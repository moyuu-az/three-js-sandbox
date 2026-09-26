// 船内の水を GPU（WebGPU compute）上の MLS-MPM で解く。
// 格子は船体座標に固定し、船の運動は見かけの力（重力の向きの変化・並進加速度・回転による力）として入れる。
// 単位: 位置 = セル（格子単位）、速度 = セル/s、時間 = s。粒子 1 個の質量 = 1、静止密度 = ppc（1 セルあたりの粒子数）。
//
// 格子点 (i, j, k) は格子座標 (i+.5, j+.5, k+.5) にある。各格子点の種類（NODE_*）は voxel.js が決める。
// 粒子は壁（固体の格子点）から 0.5 セル以上離しておく。そうすると粒子の 3×3×3 の影響範囲が壁の向こう側の格子点に届かず、
// 隔壁 1 枚（1 セル厚）で両側の水が混ざらない。
import * as THREE from 'three/webgpu';
import {
  Fn, If, Return, instanceIndex, uniform, uniformArray, float, int, vec3, vec4, floor, max, min, clamp, dot, cross, length,
  atomicAdd, atomicLoad, atomicStore, atomicSub, atomicMax, atomicMin, instancedArray, hash, workgroupArray, workgroupBarrier,
  localId, workgroupId, select,
} from 'three/tsl';
import { NODE_SOLID, NODE_EXTERIOR, NODE_OPENING_IN, NODE_OPENING_OUT, MAX_OPENINGS, MAX_ROOMS, NO_ROOM } from '../voxel.js';

const FIX = 65536; // アトミック加算用の固定小数点の倍率（WebGPU の atomic は整数のみ）
const WG = 256; // ワークグループのスレッド数
const MOMENTS = 10; // 質量, Σx, Σy, Σz, Σxx, Σyy, Σzz, Σxy, Σyz, Σzx
export const OPEN_FREE = 0, OPEN_INFLOW = 1, OPEN_CLOSED = 2; // 開口部の状態（格子点の境界条件）
const C_FREE_TOP = 0, C_HIGH = 1, C_KILLED = 2, C_REVERT = 3; // counters の添字（REVERT は壁にめり込んで戻した回数、診断用）

/**
 * 状態方程式の剛性と安定な時間刻み（SSOT）。深さ depth [m] の水が compression だけ縮む剛性にする。
 * 音速 c = √(k/ρ₀) [セル/s]、時間刻み dt ≤ cfl / c。
 * 弱圧縮性なので、水柱が自重で縮んだ分だけ上下に「呼吸」する振動（周期 ~0.3 s、変位 数 cm）が残る。
 * 剛性を上げるほど振動が速く減衰しにくい（実測）。12% なら水深 5 m で水面が ~30 cm 低く見える程度で、揺れも穏やか
 */
export function fluidParams(h, ppc, { depth = 5, compression = 0.12, cfl = 0.3 } = {}) {
  const g = 9.81 / h, d = depth / h;
  const stiffness = (ppc * g * d) / compression;
  const soundSpeed = Math.sqrt(stiffness / ppc);
  return { stiffness, soundSpeed, dtMax: cfl / soundSpeed };
}

/**
 * @param {THREE.WebGPURenderer} renderer
 * @param {{ dims: number[], ppc?: number, maxParticles: number, stiffness: number, viscosity?: number }} opt
 */
export function createFluid(renderer, { dims, ppc = 8, maxParticles, stiffness, viscosity = 0.3, bulkViscosity = 40, maxSpawn = 16384 }) {
  const [nx, ny, nz] = dims;
  const N = nx * ny * nz, P = maxParticles;
  // ワークグループ内で同期（workgroupBarrier）するカーネルは、全スレッドが揃っていないと未定義動作になる
  if (P % WG !== 0) throw new Error(`maxParticles は ${WG} の倍数にする（${P}）`);
  const rho0 = ppc;

  // ---------- バッファ ----------
  const pos = instancedArray(P, 'vec4'); // xyz = 位置, w = 1 生存 / 0 空き
  const vel = instancedArray(P, 'vec4'); // xyz = 速度, w = 密度比（描画の泡・水しぶき判定用）
  const cmat = instancedArray(P * 3, 'vec4'); // APIC の速度勾配 C（粒子ごとに 3 列）
  const cCol = (i, c) => cmat.element(int(i).mul(3).add(c));
  const freeStack = instancedArray(P, 'int');
  const counters = instancedArray(4, 'int').toAtomic();
  const gridI = instancedArray(N * 4, 'int').toAtomic(); // 質量, 運動量 xyz（固定小数点）
  const gridV = instancedArray(N, 'vec4'); // 更新後の速度 xyz, w = 質量
  const nodeInfo = instancedArray(N, 'vec4'); // xyz = 滑り境界の法線（向きは問わない）, w = 種類
  const sdf = instancedArray(N, 'vec4'); // xyz = 最寄りの固体から離れる向き, w = 最寄りの固体までの距離 [セル]
  const roomOf = instancedArray(N, 'int');
  const roomAcc = instancedArray(MAX_ROOMS, 'int').toAtomic();
  const nWG = Math.ceil(N / WG);
  const partials = instancedArray(nWG * MOMENTS, 'float');

  // ---------- 一様変数 ----------
  const u = {
    dt: uniform(1 / 240),
    gravity: uniform(new THREE.Vector3(0, -9.81, 0)), // 船体座標の見かけの重力（並進加速度込み）[セル/s²]
    omega: uniform(new THREE.Vector3()), // 船の角速度（船体座標）[rad/s]
    alpha: uniform(new THREE.Vector3()), // 角加速度
    origin: uniform(new THREE.Vector3()), // 回転の基準点（格子座標）
    maxSpeed: uniform(100),
    stiffness: uniform(stiffness),
    viscosity: uniform(viscosity),
    bulk: uniform(bulkViscosity), // 体積粘性。弱圧縮性の水柱が上下に伸び縮みする音響振動を減衰させる（流れのずれには効かない）
    spawnTotal: uniform(0, 'int'),
    seed: uniform(0),
  };
  const open = {
    state: uniformArray(new Array(MAX_OPENINGS).fill(0).map(() => new THREE.Vector4()), 'vec4'), // xyz = 流入速度, w = OPEN_*
    center: uniformArray(new Array(MAX_OPENINGS).fill(0).map(() => new THREE.Vector4()), 'vec4'), // xyz = 生成位置の中心, w = 累積生成数
    ax: uniformArray(new Array(MAX_OPENINGS).fill(0).map(() => new THREE.Vector4()), 'vec4'), // 生成範囲の半軸 1
    ay: uniformArray(new Array(MAX_OPENINGS).fill(0).map(() => new THREE.Vector4()), 'vec4'), // 生成範囲の半軸 2
    vel: uniformArray(new Array(MAX_OPENINGS).fill(0).map(() => new THREE.Vector4()), 'vec4'), // 生成時の速度
  };
  // 部屋の空気の圧力（x = g·水頭 / h² [セル²/s²]）。setRoomHeads で入れる
  const roomPhi = uniformArray(new Array(MAX_ROOMS).fill(0).map(() => new THREE.Vector4()), 'vec4');

  // ---------- 共通: 2 次 B スプラインの 3×3×3 ステンシル（JS 側で展開して WGSL に直書きする） ----------
  const strideY = nx, strideZ = nx * ny;
  function stencil(x) {
    const cell = floor(x).toVar();
    const d = x.sub(cell).sub(0.5).toVar(); // [-0.5, 0.5)
    const a = vec3(0.5).sub(d), b = vec3(0.5).add(d);
    const w = [a.mul(a).mul(0.5).toVar(), vec3(0.75).sub(d.mul(d)).toVar(), b.mul(b).mul(0.5).toVar()];
    const base = int(cell.x).add(int(cell.y).mul(strideY)).add(int(cell.z).mul(strideZ)).toVar();
    const out = [];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) {
      out.push({
        weight: w[i].x.mul(w[j].y).mul(w[k].z),
        index: base.add((i - 1) + (j - 1) * strideY + (k - 1) * strideZ),
        dist: vec3(i - 1, j - 1, k - 1).sub(d), // 格子点 − 粒子
      });
    }
    return out;
  }
  const fx = (v) => int(v.mul(FIX));
  const unfx = (v) => float(v).div(FIX);
  const matMul = (col0, col1, col2, v) => col0.mul(v.x).add(col1.mul(v.y)).add(col2.mul(v.z));

  // ---------- カーネル ----------
  const clearGrid = Fn(() => {
    const i = int(instanceIndex).mul(4);
    atomicStore(gridI.element(i), 0);
    atomicStore(gridI.element(i.add(1)), 0);
    atomicStore(gridI.element(i.add(2)), 0);
    atomicStore(gridI.element(i.add(3)), 0);
  })().compute(N, [WG]);

  // P2G 1: 質量と APIC 運動量を格子へ
  const p2g1 = Fn(() => {
    const p = pos.element(instanceIndex);
    If(p.w.lessThan(0.5), () => { Return(); });
    const x = p.xyz.toVar(), v = vel.element(instanceIndex).xyz.toVar();
    const C0 = cCol(instanceIndex, 0).xyz.toVar(), C1 = cCol(instanceIndex, 1).xyz.toVar(), C2 = cCol(instanceIndex, 2).xyz.toVar();
    for (const s of stencil(x)) {
      const w = s.weight.toVar();
      const mv = v.add(matMul(C0, C1, C2, s.dist)).mul(w);
      const g = s.index.mul(4).toVar();
      atomicAdd(gridI.element(g), fx(w));
      atomicAdd(gridI.element(g.add(1)), fx(mv.x));
      atomicAdd(gridI.element(g.add(2)), fx(mv.y));
      atomicAdd(gridI.element(g.add(3)), fx(mv.z));
    }
  })().compute(P, [WG]);

  // P2G 2: 格子の質量から粒子の密度を求め、圧力（状態方程式）と粘性の応力を運動量の変化として格子へ
  const p2g2 = Fn(() => {
    const p = pos.element(instanceIndex);
    If(p.w.lessThan(0.5), () => { Return(); });
    const x = p.xyz.toVar();
    const st = stencil(x);
    const density = float(0).toVar();
    for (const s of st) density.addAssign(s.weight.mul(unfx(atomicLoad(gridI.element(s.index.mul(4))))));
    density.assign(max(density, rho0 * 0.05));
    vel.element(instanceIndex).w.assign(density.div(rho0));
    // 線形の状態方程式 p = k (ρ/ρ₀ − 1)。音速が圧縮で変わらないので時間刻みの安定条件が一定。
    // Tait 型（7 乗）は局所的に圧縮された瞬間に音速が跳ね上がって安定条件を超え、水全体が周期的に跳ねた。
    // 負圧は出さない（自由表面で粒子がくっつくのを防ぐ）
    const pressure = max(0, u.stiffness.mul(density.div(rho0).sub(1))).toVar();
    const C0 = cCol(instanceIndex, 0).xyz, C1 = cCol(instanceIndex, 1).xyz, C2 = cCol(instanceIndex, 2).xyz;
    // 応力 = −p I + μ (C + Cᵀ) + λ tr(C) I（ニュートン流体、λ = 体積粘性）。列ごとに持つ。
    // 運動量への換算に掛ける体積は、圧力には実際の体積 1/ρ、粘性の項には静止時の体積 1/ρ₀ を使う。
    // 粘性にも 1/ρ を使うと、水面やしぶきの低密度の粒子で体積が 10〜20 倍になり陽解法の安定限界を超えて発散した（第 1 船倉で実測）
    const kp = float(-4).mul(u.dt).div(density), kv = float(-4 / rho0).mul(u.dt);
    const vis = u.viscosity.mul(kv), bulkTerm = u.bulk.mul(C0.x.add(C1.y).add(C2.z)).mul(kv);
    const pk = pressure.mul(kp).negate().toVar(); // −p I · kp
    const S0 = vec3(C0.x.mul(2), C0.y.add(C1.x), C0.z.add(C2.x)).mul(vis).add(vec3(bulkTerm.add(pk), 0, 0)).toVar();
    const S1 = vec3(C1.x.add(C0.y), C1.y.mul(2), C1.z.add(C2.y)).mul(vis).add(vec3(0, bulkTerm.add(pk), 0)).toVar();
    const S2 = vec3(C2.x.add(C0.z), C2.y.add(C1.z), C2.z.mul(2)).mul(vis).add(vec3(0, 0, bulkTerm.add(pk))).toVar();
    for (const s of st) {
      const f = matMul(S0, S1, S2, s.dist).mul(s.weight).toVar();
      const g = s.index.mul(4).toVar();
      atomicAdd(gridI.element(g.add(1)), fx(f.x));
      atomicAdd(gridI.element(g.add(2)), fx(f.y));
      atomicAdd(gridI.element(g.add(3)), fx(f.z));
    }
  })().compute(P, [WG]);

  // 格子の更新: 速度 = 運動量/質量、見かけの力、境界条件
  const updateGrid = Fn(() => {
    const i = int(instanceIndex);
    const g = i.mul(4);
    const m = unfx(atomicLoad(gridI.element(g))).toVar();
    const out = gridV.element(i);
    If(m.lessThanEqual(1e-6), () => { out.assign(vec4(0)); Return(); });
    const v = vec3(unfx(atomicLoad(gridI.element(g.add(1)))), unfx(atomicLoad(gridI.element(g.add(2)))), unfx(atomicLoad(gridI.element(g.add(3))))).div(m).toVar();
    const ix = i.mod(nx), iy = i.div(nx).mod(ny), iz = i.div(strideZ);
    const r = vec3(float(ix).add(0.5), float(iy).add(0.5), float(iz).add(0.5)).sub(u.origin);
    // 回転座標系の見かけの力: −α×r − ω×(ω×r) − 2ω×v
    const acc = u.gravity.sub(cross(u.alpha, r)).sub(cross(u.omega, cross(u.omega, r))).sub(cross(u.omega, v).mul(2));
    v.addAssign(acc.mul(u.dt));
    const info = nodeInfo.element(i);
    const type = info.w.toVar();
    // 部屋の空気の圧力: 水面を押す空気の圧力は、部屋の中では一様なので流れを生まず、別の部屋との境目（開いた扉・ハッチ）でだけ
    // 圧力の段差として効く。境目の両側の 2 格子点に −∇φ（中心差分）を掛けると、合計でちょうど ρ·g·Δ水頭 の段差になる。
    // 隣が壁・船外・部屋なしなら自分と同じ値（段差なし）。
    // 圧力は体積に働く力なので、格子点の質量が静止密度より少ない分（扉は狭く、格子点のほとんどが壁際で、粒子を壁から離して
    // 置くため質量が 5〜8 割になる）は ρ₀/m で補う（最大 2 倍）。補わないと段差が 7 割しか効かなかった（セルフテストで実測）
    const room = roomOf.element(i).toVar();
    If(room.lessThan(NO_ROOM).and(type.equal(0).or(type.greaterThanEqual(NODE_OPENING_IN).and(type.lessThan(NODE_OPENING_OUT)))), () => {
      const phi0 = roomPhi.element(room).x;
      const phi = (off) => { const r = roomOf.element(i.add(off)); return select(r.lessThan(NO_ROOM), roomPhi.element(r).x, phi0); };
      const fill = clamp(float(rho0).div(m), 1, 2);
      v.subAssign(vec3(phi(1).sub(phi(-1)), phi(strideY).sub(phi(-strideY)), phi(strideZ).sub(phi(-strideZ))).mul(u.dt.mul(0.5).mul(fill)));
    });
    const n = info.xyz;
    const slip = () => {
      If(dot(n, n).greaterThan(0.5), () => { v.subAssign(n.mul(dot(v, n))); }).Else(() => { v.assign(vec3(0)); });
    };
    If(type.equal(NODE_SOLID).or(type.equal(NODE_EXTERIOR)), slip).ElseIf(type.greaterThanEqual(NODE_OPENING_IN), () => {
      const k = int(type).sub(NODE_OPENING_IN).mod(32); // 開口部の番号（内側・外側とも）
      const s = open.state.element(k);
      If(s.w.equal(OPEN_INFLOW), () => { v.assign(s.xyz); }).ElseIf(s.w.equal(OPEN_CLOSED), slip);
    });
    out.assign(vec4(v, m));
  })().compute(N, [WG]);

  // G2P: 格子の速度を粒子へ戻し（APIC）、移動・壁からの押し出し・船外へ出た粒子の除去
  const g2p = Fn(() => {
    const pid = int(instanceIndex);
    const p = pos.element(pid);
    If(p.w.lessThan(0.5), () => { Return(); });
    const x = p.xyz.toVar();
    const v = vec3(0).toVar(), B0 = vec3(0).toVar(), B1 = vec3(0).toVar(), B2 = vec3(0).toVar();
    for (const s of stencil(x)) {
      const wv = gridV.element(s.index).xyz.mul(s.weight).toVar();
      v.addAssign(wv);
      B0.addAssign(wv.mul(s.dist.x)); B1.addAssign(wv.mul(s.dist.y)); B2.addAssign(wv.mul(s.dist.z));
    }
    // 1 サブステップで 0.5 セル未満しか動かないよう速度を抑える（壁の厚さ 1 セルをすり抜けない条件）
    const sp = length(v);
    If(sp.greaterThan(u.maxSpeed), () => { v.mulAssign(u.maxSpeed.div(sp)); });
    const xOld = x.toVar();
    x.addAssign(v.mul(u.dt));
    x.assign(clamp(x, vec3(1.001), vec3(nx - 1.001, ny - 1.001, nz - 1.001)));

    // 壁からの押し出し（距離場を三線形補間）
    const q = x.sub(0.5).toVar();
    const q0 = floor(q), f = q.sub(q0).toVar();
    const b = int(q0.x).add(int(q0.y).mul(strideY)).add(int(q0.z).mul(strideZ)).toVar();
    const acc = vec4(0).toVar();
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) {
      const wx = i ? f.x : float(1).sub(f.x), wy = j ? f.y : float(1).sub(f.y), wz = k ? f.z : float(1).sub(f.z);
      acc.addAssign(sdf.element(b.add(i + j * strideY + k * strideZ)).mul(wx.mul(wy).mul(wz)));
    }
    // 押し出しの基準は「固体の格子点の中心から R 以上離す」（格子点のセルの中かどうかではない。セルの角は中心から 0.87 離れていて、
    // セルで判定すると押し出し済みの粒子まで戻してしまい、壁際で押し出しと戻しが綱引きして水全体が周期的に跳ねた）
    const R = 0.52;
    If(acc.w.lessThan(0.25), () => {
      // 深くめり込んだ（勾配が当てにならない）: 動く前の位置へ戻す
      x.assign(xOld);
      v.mulAssign(0.5);
      atomicAdd(counters.element(C_REVERT), 1);
    }).ElseIf(acc.w.lessThan(R), () => {
      const n = acc.xyz.toVar();
      const nl = length(n);
      If(nl.greaterThan(1e-4), () => {
        n.divAssign(nl);
        x.addAssign(n.mul(float(R).sub(acc.w)));
        const vn = dot(v, n);
        If(vn.lessThan(0), () => { v.subAssign(n.mul(vn)); });
      });
    });
    // 開口部の外側に出た粒子: 開放（海面より上）の開口ならこぼれ出た水として消す。流入中・閉じた開口なら戻す（外側は距離場の固体に
    // 含めていないので押し出しでは止まらない）。水が船から出られるのは開口部だけ
    const ci = int(x.x).add(int(x.y).mul(strideY)).add(int(x.z).mul(strideZ));
    const type = nodeInfo.element(ci).w.toVar();
    If(type.greaterThanEqual(NODE_OPENING_OUT), () => {
      const outMode = open.state.element(int(type).sub(NODE_OPENING_OUT).clamp(0, MAX_OPENINGS - 1)).w;
      If(outMode.equal(OPEN_FREE), () => {
        p.w.assign(0);
        const slot = atomicAdd(counters.element(C_FREE_TOP), 1);
        freeStack.element(slot).assign(pid);
        atomicAdd(counters.element(C_KILLED), 1);
        Return();
      });
      x.assign(xOld);
      v.mulAssign(0.5);
      atomicAdd(counters.element(C_REVERT), 1);
    });
    p.assign(vec4(x, 1));
    vel.element(pid).assign(vec4(v, vel.element(pid).w));
    cCol(pid, 0).assign(vec4(B0.mul(4), 0)); cCol(pid, 1).assign(vec4(B1.mul(4), 0)); cCol(pid, 2).assign(vec4(B2.mul(4), 0));
  })().compute(P, [WG]);

  // 開口部からの流入: 空きスロット（フリーリスト → 末尾）に粒子を置く
  const spawn = Fn(() => {
    const i = int(instanceIndex);
    If(i.greaterThanEqual(u.spawnTotal), () => { Return(); });
    // どの開口部の分か（累積数で探す）
    const k = int(0).toVar();
    for (let n = 0; n < MAX_OPENINGS - 1; n++) If(float(i).greaterThanEqual(open.center.element(n).w), () => { k.assign(n + 1); });
    const t = atomicSub(counters.element(C_FREE_TOP), 1).sub(1).toVar();
    const slot = int(0).toVar();
    If(t.greaterThanEqual(0), () => { slot.assign(freeStack.element(t)); }).Else(() => { slot.assign(atomicAdd(counters.element(C_HIGH), 1)); });
    If(slot.greaterThanEqual(P), () => { Return(); });
    const s = float(i).add(u.seed);
    const r1 = hash(s.mul(1.37).add(0.11)).mul(2).sub(1), r2 = hash(s.mul(2.71).add(0.53)).mul(2).sub(1);
    const lo = vec3(1.001), hi = vec3(nx - 1.001, ny - 1.001, nz - 1.001);
    const xp = clamp(open.center.element(k).xyz.add(open.ax.element(k).xyz.mul(r1)).add(open.ay.element(k).xyz.mul(r2)), lo, hi).toVar();
    // 曲がった外板では生成範囲の角が船外・壁にはみ出す。そこに置くと動けなくなるので開口の中心に置き直す
    const t0 = nodeInfo.element(int(xp.x).add(int(xp.y).mul(strideY)).add(int(xp.z).mul(strideZ))).w;
    If(t0.equal(NODE_SOLID).or(t0.equal(NODE_EXTERIOR)).or(t0.greaterThanEqual(NODE_OPENING_OUT)), () => { xp.assign(clamp(open.center.element(k).xyz, lo, hi)); });
    pos.element(slot).assign(vec4(xp, 1));
    vel.element(slot).assign(vec4(open.vel.element(k).xyz, 1));
    cCol(slot, 0).assign(vec4(0)); cCol(slot, 1).assign(vec4(0)); cCol(slot, 2).assign(vec4(0));
  })().compute(maxSpawn, [WG]);

  const fixCounters = Fn(() => {
    atomicMax(counters.element(C_FREE_TOP), 0);
    atomicMin(counters.element(C_HIGH), P);
  })().compute(1, [1]);

  // 集計: 質量モーメント（ワークグループ内で総和 → 部分和を CPU で合計）と部屋ごとの水量
  const clearRooms = Fn(() => { atomicStore(roomAcc.element(instanceIndex), 0); })().compute(MAX_ROOMS, [MAX_ROOMS]);
  const shared = new Array(MOMENTS).fill(0).map(() => workgroupArray('float', WG));
  const stats = Fn(() => {
    const i = int(instanceIndex);
    const l = int(localId.x);
    const valid = i.lessThan(N);
    const gv = gridV.element(min(i, N - 1));
    const m = select(valid, gv.w, float(0)).toVar();
    const ix = i.mod(nx), iy = i.div(nx).mod(ny), iz = i.div(strideZ);
    const r = vec3(float(ix).add(0.5), float(iy).add(0.5), float(iz).add(0.5)).sub(vec3(nx / 2, ny / 2, nz / 2)).toVar();
    const vals = [m, m.mul(r.x), m.mul(r.y), m.mul(r.z), m.mul(r.x).mul(r.x), m.mul(r.y).mul(r.y), m.mul(r.z).mul(r.z),
      m.mul(r.x).mul(r.y), m.mul(r.y).mul(r.z), m.mul(r.z).mul(r.x)];
    vals.forEach((v, q) => shared[q].element(l).assign(v));
    workgroupBarrier();
    for (let s = WG / 2; s > 0; s >>= 1) {
      If(l.lessThan(s), () => { for (const sh of shared) sh.element(l).addAssign(sh.element(l.add(s))); });
      workgroupBarrier();
    }
    If(l.equal(0), () => { shared.forEach((sh, q) => partials.element(int(workgroupId.x).mul(MOMENTS).add(q)).assign(sh.element(int(0)))); });
  })().compute(nWG * WG, [WG]);

  // 部屋ごとの水量: 粒子をその位置の格子点の部屋で数える。格子の質量で数えると、壁の格子点に配られた分（壁際の粒子の
  // 質量の 1〜2 割）がどの部屋にも入らず水位を低く見積もる。ワークグループ内で数えてから全体に足す（アトミックの競合を減らす）
  const hist = workgroupArray('int', MAX_ROOMS).toAtomic();
  const roomCount = Fn(() => {
    const l = int(localId.x);
    If(l.lessThan(MAX_ROOMS), () => { atomicStore(hist.element(l), 0); });
    workgroupBarrier();
    const p = pos.element(instanceIndex);
    If(p.w.greaterThan(0.5), () => {
      const ci = int(p.x).add(int(p.y).mul(strideY)).add(int(p.z).mul(strideZ));
      const r = roomOf.element(ci).toVar();
      // 壁際の粒子は壁の格子点のセル（部屋なし）に入っていることがある。距離場の勾配（壁から離れる向き）の先の格子点の部屋にする
      If(r.equal(NO_ROOM), () => {
        const y = p.xyz.add(sdf.element(ci).xyz.mul(0.8));
        r.assign(roomOf.element(int(y.x).add(int(y.y).mul(strideY)).add(int(y.z).mul(strideZ))));
      });
      atomicAdd(hist.element(r), 1);
    });
    workgroupBarrier();
    If(l.lessThan(MAX_ROOMS), () => { atomicAdd(roomAcc.element(l), atomicLoad(hist.element(l))); });
  })().compute(P, [WG]);

  // ---------- CPU 側の管理 ----------
  let hwUpper = 0; // 粒子の添字の上限（GPU の highWater の CPU 側の上界。ディスパッチ数に使う）
  let spawnIssued = 0; // これまでに投げた生成数の累計（読み戻しを出した後に増えた分を上界に足すため）
  let epoch = 0; // init のたびに増やす。init 前に出した読み戻しの値（別の粒子の集合）を捨てる
  let latest = null, pending = false, frame = 0;

  const upload = (node, data) => { const a = node.value; a.array.set(data); a.needsUpdate = true; };
  // packForGpu の結果を受け取る。sdf は格子点ごとの vec4（法線 xyz + 距離）。スカラーの dist を渡すと押し出しが効かず粒子が壁を抜ける
  function setGrid({ info, sdf: field, rooms }) {
    if (info.length !== N * 4 || field.length !== N * 4 || rooms.length !== N) throw new Error('setGrid: 格子の大きさが合わない');
    upload(nodeInfo, info);
    upload(sdf, field);
    upload(roomOf, rooms);
  }

  // dt: 1 サブステップの時間, substeps: 回数, spawns: [{ opening, count }]（開口部ごとの生成数）
  function step(dt, substeps, spawns = []) {
    u.dt.value = dt;
    u.maxSpeed.value = 0.45 / dt;
    const count = Math.max(WG, hwUpper);
    for (let s = 0; s < substeps; s++) {
      renderer.compute(clearGrid);
      renderer.compute([p2g1, p2g2], count);
      renderer.compute(updateGrid);
      renderer.compute(g2p, count);
    }
    renderer.compute([clearRooms, stats]);
    renderer.compute(roomCount, count);
    // 開口部ごとの生成数を添字順の累積数にする（spawn カーネルはこれで自分の開口部を探す）
    const per = new Array(MAX_OPENINGS).fill(0);
    for (const s of spawns) per[s.opening] += Math.max(0, s.count | 0);
    let total = 0;
    for (let k = 0; k < MAX_OPENINGS; k++) { total = Math.min(maxSpawn, total + per[k]); open.center.array[k].w = total; }
    if (total > 0) {
      u.spawnTotal.value = total;
      u.seed.value = (frame * 7919) % 100000;
      // 配列でまとめて渡すと個数 total が fixCounters にも使われ、1 スレッドのワークグループを total 個起動してしまう
      renderer.compute(spawn, total);
      renderer.compute(fixCounters);
      hwUpper = Math.min(P, hwUpper + total);
      spawnIssued += total;
    }
    frame++;
    if (!pending) readback();
  }

  async function readback() {
    pending = true;
    // 読み戻しのコピーはここで（この後に投げる生成より前に）キューに積まれる。返事の HIGH にはここまでの生成が入っている
    const mark = spawnIssued, ep = epoch;
    try {
      const [cnt, rooms, part] = await Promise.all([
        renderer.getArrayBufferAsync(counters.value),
        renderer.getArrayBufferAsync(roomAcc.value),
        renderer.getArrayBufferAsync(partials.value),
      ]);
      if (ep !== epoch) return;
      const c = new Int32Array(cnt), pr = new Float32Array(part);
      const mom = new Float64Array(MOMENTS);
      for (let w = 0; w < nWG; w++) for (let q = 0; q < MOMENTS; q++) mom[q] += pr[w * MOMENTS + q];
      const high = c[C_HIGH];
      // GPU の値が確定したら上界を締める。生成はフリーリストから先に取るので HIGH は hwUpper ほど増えない。
      // 締めないと、船外へ出た分を入れ直すたびに hwUpper だけ増え、やがて全スロット（P）をディスパッチ・描画し続ける。
      // 読み戻しを出した後に投げた生成（spawnIssued − mark）は返事の HIGH に入っていないので足す
      hwUpper = Math.min(hwUpper, P, high + (spawnIssued - mark));
      latest = {
        high, free: c[C_FREE_TOP], killed: c[C_KILLED], reverts: c[C_REVERT], alive: high - c[C_FREE_TOP],
        roomMass: Array.from(new Int32Array(rooms)), // 粒子の数
        moments: mom, center: [nx / 2, ny / 2, nz / 2],
      };
    } finally {
      pending = false;
    }
  }

  // 開口部の状態と生成範囲（格子座標）
  function setOpening(k, { mode, inflow = [0, 0, 0], center = [0, 0, 0], ax = [0, 0, 0], ay = [0, 0, 0], spawnVel = inflow }) {
    open.state.array[k].set(inflow[0], inflow[1], inflow[2], mode);
    open.center.array[k].set(center[0], center[1], center[2], open.center.array[k].w);
    open.ax.array[k].set(ax[0], ax[1], ax[2], 0);
    open.ay.array[k].set(ay[0], ay[1], ay[2], 0);
    open.vel.array[k].set(spawnVel[0], spawnVel[1], spawnVel[2], 0);
  }

  // 部屋ごとの空気のゲージ圧を水頭 [m] で入れる（h: 格子間隔 [m]）。境目の段差が大きすぎると、弱圧縮の水が段差の分だけ縮んで
  // 安定条件（fluidParams は水深 5 m 相当）を外れるので、水頭は −2〜10 m に抑える（破断の強度で実際はこの範囲に収まる）
  function setRoomHeads(heads, h) {
    for (let r = 0; r < MAX_ROOMS; r++) {
      const H = Number.isFinite(heads[r]) ? Math.min(10, Math.max(-2, heads[r])) : 0;
      roomPhi.array[r].x = (9.81 * H) / (h * h);
    }
  }

  // 初期配置（テスト・デモ用）。xyz を格子座標で並べた配列
  function init(points) {
    const n = Math.min(P, points.length / 3);
    const a = pos.value.array;
    a.fill(0);
    for (let i = 0; i < n; i++) a.set([points[3 * i], points[3 * i + 1], points[3 * i + 2], 1], 4 * i);
    pos.value.needsUpdate = true;
    for (const b of [vel, cmat]) { b.value.array.fill(0); b.value.needsUpdate = true; }
    counters.value.array.set([0, n, 0, 0]);
    counters.value.needsUpdate = true;
    hwUpper = n;
    epoch++;
    latest = null;
  }

  return {
    dims, ppc, init, maxParticles: P, uniforms: u, buffers: { pos, vel, gridV },
    setGrid, setOpening, setRoomHeads, step,
    get stats() { return latest; },
    get drawCount() { return hwUpper; },
  };
}
