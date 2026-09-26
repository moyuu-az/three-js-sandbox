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
import { NODE_SOLID, NODE_EXTERIOR, NODE_OPENING_IN, NODE_OPENING_OUT, MAX_OPENINGS, MAX_ROOMS } from '../voxel.js';

const FIX = 65536; // アトミック加算用の固定小数点の倍率（WebGPU の atomic は整数のみ）
const ROOM_FIX = 256;
const WG = 256; // ワークグループのスレッド数
const MOMENTS = 10; // 質量, Σx, Σy, Σz, Σxx, Σyy, Σzz, Σxy, Σyz, Σzx
export const OPEN_FREE = 0, OPEN_INFLOW = 1, OPEN_CLOSED = 2; // 開口部の状態（格子点の境界条件）
const C_FREE_TOP = 0, C_HIGH = 1, C_KILLED = 2; // counters の添字

/**
 * @param {THREE.WebGPURenderer} renderer
 * @param {{ dims: number[], ppc?: number, maxParticles: number, stiffness: number, viscosity?: number }} opt
 */
export function createFluid(renderer, { dims, ppc = 8, maxParticles, stiffness, viscosity = 0.05, maxSpawn = 16384 }) {
  const [nx, ny, nz] = dims;
  const N = nx * ny * nz, P = maxParticles;
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
    // Tait 型の状態方程式。負圧は出さない（自由表面で粒子がくっつくのを防ぐ）
    const r = density.div(rho0), r2 = r.mul(r), r4 = r2.mul(r2);
    const pressure = max(0, u.stiffness.mul(r4.mul(r2).mul(r).sub(1))).toVar();
    const C0 = cCol(instanceIndex, 0).xyz, C1 = cCol(instanceIndex, 1).xyz, C2 = cCol(instanceIndex, 2).xyz;
    // 応力 = −p I + μ (C + Cᵀ)。列ごとに持つ
    const S0 = vec3(C0.x.mul(2), C0.y.add(C1.x), C0.z.add(C2.x)).mul(u.viscosity).sub(vec3(pressure, 0, 0)).toVar();
    const S1 = vec3(C1.x.add(C0.y), C1.y.mul(2), C1.z.add(C2.y)).mul(u.viscosity).sub(vec3(0, pressure, 0)).toVar();
    const S2 = vec3(C2.x.add(C0.z), C2.y.add(C1.z), C2.z.mul(2)).mul(u.viscosity).sub(vec3(0, 0, pressure)).toVar();
    const k = float(-4).mul(u.dt).div(density).toVar(); // −体積 · 4/Δx² · dt（粒子質量 1）
    for (const s of st) {
      const f = matMul(S0, S1, S2, s.dist).mul(s.weight.mul(k)).toVar();
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
    x.addAssign(v.mul(u.dt));
    x.assign(clamp(x, vec3(1.001), vec3(nx - 1.001, ny - 1.001, nz - 1.001)));

    // 船外（外側の格子点）に出た粒子は消す
    const ci = int(x.x).add(int(x.y).mul(strideY)).add(int(x.z).mul(strideZ));
    const type = nodeInfo.element(ci).w;
    If(type.equal(NODE_EXTERIOR).or(type.greaterThanEqual(NODE_OPENING_OUT)), () => {
      p.w.assign(0);
      const slot = atomicAdd(counters.element(C_FREE_TOP), 1);
      freeStack.element(slot).assign(pid);
      atomicAdd(counters.element(C_KILLED), 1);
      Return();
    });

    // 壁からの押し出し（距離場を三線形補間）
    const q = x.sub(0.5).toVar();
    const q0 = floor(q), f = q.sub(q0).toVar();
    const b = int(q0.x).add(int(q0.y).mul(strideY)).add(int(q0.z).mul(strideZ)).toVar();
    const acc = vec4(0).toVar();
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) {
      const wx = i ? f.x : float(1).sub(f.x), wy = j ? f.y : float(1).sub(f.y), wz = k ? f.z : float(1).sub(f.z);
      acc.addAssign(sdf.element(b.add(i + j * strideY + k * strideZ)).mul(wx.mul(wy).mul(wz)));
    }
    const R = 0.52;
    If(acc.w.lessThan(R), () => {
      const n = acc.xyz.toVar();
      const nl = length(n);
      If(nl.greaterThan(1e-4), () => {
        n.divAssign(nl);
        x.addAssign(n.mul(float(R).sub(acc.w)));
        const vn = dot(v, n);
        If(vn.lessThan(0), () => { v.subAssign(n.mul(vn)); });
      });
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
    const xp = open.center.element(k).xyz.add(open.ax.element(k).xyz.mul(r1)).add(open.ay.element(k).xyz.mul(r2));
    pos.element(slot).assign(vec4(clamp(xp, vec3(1.001), vec3(nx - 1.001, ny - 1.001, nz - 1.001)), 1));
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
    If(m.greaterThan(0), () => { atomicAdd(roomAcc.element(roomOf.element(min(i, N - 1))), int(m.mul(ROOM_FIX))); });
    workgroupBarrier();
    for (let s = WG / 2; s > 0; s >>= 1) {
      If(l.lessThan(s), () => { for (const sh of shared) sh.element(l).addAssign(sh.element(l.add(s))); });
      workgroupBarrier();
    }
    If(l.equal(0), () => { shared.forEach((sh, q) => partials.element(int(workgroupId.x).mul(MOMENTS).add(q)).assign(sh.element(int(0)))); });
  })().compute(nWG * WG, [WG]);

  // ---------- CPU 側の管理 ----------
  let hwUpper = 0; // 粒子の添字の上限（GPU の highWater の CPU 側の上界。ディスパッチ数に使う）
  let latest = null, pending = false, frame = 0;

  const upload = (node, data) => { const a = node.value; a.array.set(data); a.needsUpdate = true; };
  function setGrid({ info, dist, rooms }) {
    upload(nodeInfo, info);
    upload(sdf, dist);
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
    // 開口部ごとの生成数を添字順の累積数にする（spawn カーネルはこれで自分の開口部を探す）
    const per = new Array(MAX_OPENINGS).fill(0);
    for (const s of spawns) per[s.opening] += Math.max(0, s.count | 0);
    let total = 0;
    for (let k = 0; k < MAX_OPENINGS; k++) { total = Math.min(maxSpawn, total + per[k]); open.center.array[k].w = total; }
    if (total > 0) {
      u.spawnTotal.value = total;
      u.seed.value = (frame * 7919) % 100000;
      renderer.compute([spawn, fixCounters], total);
      hwUpper = Math.min(P, hwUpper + total);
    }
    frame++;
    if (!pending) readback();
  }

  async function readback() {
    pending = true;
    try {
      const [cnt, rooms, part] = await Promise.all([
        renderer.getArrayBufferAsync(counters.value),
        renderer.getArrayBufferAsync(roomAcc.value),
        renderer.getArrayBufferAsync(partials.value),
      ]);
      const c = new Int32Array(cnt), pr = new Float32Array(part);
      const mom = new Float64Array(MOMENTS);
      for (let w = 0; w < nWG; w++) for (let q = 0; q < MOMENTS; q++) mom[q] += pr[w * MOMENTS + q];
      const high = c[C_HIGH];
      hwUpper = Math.max(Math.min(hwUpper, P), high); // GPU の値が確定したら上界を締める（生成中の分は hwUpper が持つ）
      latest = {
        high, free: c[C_FREE_TOP], killed: c[C_KILLED], alive: high - c[C_FREE_TOP],
        roomMass: Array.from(new Int32Array(rooms), (v) => v / ROOM_FIX),
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
  }

  return {
    dims, ppc, init, maxParticles: P, uniforms: u, buffers: { pos, vel, gridV },
    setGrid, setOpening, step,
    get stats() { return latest; },
    get drawCount() { return hwUpper; },
  };
}
