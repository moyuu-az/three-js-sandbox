// 沈没シミュレーションの物理部分（描画に依存しない。node からもテストできる）
// 浮力・浸水は Rapier に無いので、船体をセル（立方体）に分けて力を計算し、合力と重心まわりのトルクを剛体に加える。
import RAPIER from '@dimforge/rapier3d-compat';
import { Vector3, Quaternion } from 'three';
import * as H from './hull.js';

export const RHO = 1000; // 水の密度。簡略化して真水 [kg/m³]
export const G = 9.81;
export const SHIP_MASS = 6000; // 上部構造込みの空船重量 [kg]
export const SEABED_Y = -20;
export const CELL = 0.2; // セルの一辺 [m]。小さいほど水面・浮力が滑らかになるが重い
export const CD = 0.6; // 開口部の流量係数（オリフィス）

const DT = 1 / 60;
const CELL_VOL = CELL ** 3;
const DRAG = 3000; // 水の抵抗 [N·s/m per m³ 没水体積]。上下揺れが臨界減衰の 3 割程度になる値

// 形状から決まる設計値（SSOT は hull.js）
const baseCells = H.buildCells(CELL);
export const HULL_VOLUME = baseCells.length * CELL_VOL;
export const WATERLINE = H.waterlineFor(baseCells, CELL, SHIP_MASS / RHO); // 設計喫水線の y（船体座標）
// 重心: 前後位置は浮心に合わせて水平に浮くようにし、高さは実船相当の深さの 45%
const COM = { x: 0, y: H.Y_MIN + 0.45 * H.D, z: H.displacement(baseCells, CELL, WATERLINE).lcb };
export const COMP_VOLUME = [0, 1, 2].map((c) => baseCells.filter((s) => s.comp === c).length * CELL_VOL);

// スロッシング（区画内の水の揺れ）: 水面の傾きを減衰振動で表す
// 固有角振動数は長さ l の槽の一次モード √(g·π/l)（深水近似）
const SLOSH_ZETA = 0.08; // 減衰比
const SLOSH_DRAG = 0.6; // 船体が回転したとき壁に引きずられて水面が一緒に回る割合
const SLOSH_MAX = 0.6; // 水面の傾きの上限（tan）。着底の衝撃などで発散させない

export async function createSim() {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -G, z: 0 });
  world.timestep = DT;

  // 質量は衝突形状ではなく明示した重心・慣性で与える（実船は下が重い）
  const I = (a, b) => (SHIP_MASS / 12) * (a * a + b * b);
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, -WATERLINE, 0) // 設計喫水線が海面に来る釣り合い位置から始める
      .setAdditionalMassProperties(SHIP_MASS, COM, { x: I(H.D, H.L), y: I(H.B, H.L), z: I(H.B, H.D) }, { x: 0, y: 0, z: 0, w: 1 }),
  );
  const pts = [];
  for (const row of H.surfaceGrid(40, 8)) for (const p of row) pts.push(p.hb, p.y, p.z, -p.hb, p.y, p.z);
  const hullCollider = world.createCollider(RAPIER.ColliderDesc.convexHull(new Float32Array(pts)).setDensity(0), body);
  world.createCollider(RAPIER.ColliderDesc.cuboid(60, 1, 60).setTranslation(0, SEABED_Y - 1, 0));

  // セルは浮力の計算点であり、区画内の水の入れ物でもある。fill = そのセルの浸水率 0..1
  const cells = baseCells.map((c) => ({ local: new Vector3(c.x, c.y, c.z), world: new Vector3(), comp: c.comp, fill: 0, key: 0 }));
  const compCells = [0, 1, 2].map((c) => cells.filter((s) => s.comp === c));
  const water = [0, 0, 0]; // 各区画の浸水量 [m³]
  // 各区画の水面。n = 水面の法線（ワールド）、d = n·p が水面上の点で一定。tilt/tiltVel はスロッシングの状態
  const surfaces = [0, 1, 2].map((c) => ({
    n: new Vector3(0, 1, 0), d: 0, tilt: { x: 0, z: 0 }, tiltVel: { x: 0, z: 0 },
    omega: Math.sqrt((G * Math.PI) / (H.COMP_RANGES[c][1] - H.COMP_RANGES[c][0])),
  }));

  // 開口部。kind: 'hatch' / 'door' は甲板の開口、'breach' は破孔。inward は描画用（水が流れ込む向き、船体座標）
  const holes = H.HATCHES.map((h) => ({
    kind: h.type, comp: H.compOf(h.z), local: new Vector3(0, H.deckY(h.z), h.z), inward: new Vector3(0, -1, 0), area: h.size ** 2, q: 0,
  }));
  function addHole(local, inward, area) {
    const hole = { kind: 'breach', comp: H.compOf(local.z), local: local.clone(), inward: inward.clone().normalize(), area, q: 0 };
    holes.push(hole);
    return hole;
  }
  // 舷側の (z, y) に破孔を開ける。side = -1 で右舷、+1 で左舷
  const addSideHole = (z, y, side = -1, area = 0.05) =>
    addHole(new Vector3(side * H.halfBreadth(z, y), y, z), new Vector3(-side, 0, 0), area);

  // 魚雷命中: 舷側 (z, y) に半径 radius の破口。隔壁をまたげば両側の区画に穴が開く（1 区画だけなら沈まないのが普通）
  // ponytail: 有効開口は円の半分（めくれた外板で流れが絞られる想定）。実際の破口形状は扱わない
  function torpedo(z, y, side = -1, radius = 0.35) {
    const area = Math.PI * radius ** 2 * 0.5;
    const made = [];
    H.COMP_RANGES.forEach(([z0, z1]) => {
      const lo = Math.max(z0, z - radius), hi = Math.min(z1, z + radius), zc = (lo + hi) / 2;
      if (hi > lo && H.halfBreadth(zc, y) > 0) made.push(addSideHole(zc, y, side, (area * (hi - lo)) / (2 * radius)));
    });
    return made;
  }

  const pos = new Vector3(), rot = new Quaternion(), lin = new Vector3(), ang = new Vector3(), com = new Vector3();
  const prevLin = new Vector3(), acc = new Vector3();
  const p = new Vector3(), r = new Vector3(), f = new Vector3(), F = new Vector3(), T = new Vector3();
  const toWorld = (local, out) => out.copy(local).applyQuaternion(rot).add(pos);
  // Rapier への WASM 呼び出しをセル数ぶん行うと重いので、JS 側で合力・重心まわりの合トルクにまとめる
  const addAt = (fx, fy, fz, at) => {
    f.set(fx, fy, fz);
    F.add(f);
    T.add(r.subVectors(at, com).cross(f));
  };
  // 区画 c の水面の、ワールド (x, z) での高さ
  const surfaceYAt = (c, x, z) => { const s = surfaces[c]; return (s.d - s.n.x * x - s.n.z * z) / s.n.y; };

  function updateSlosh(s, c) {
    // 見かけの重力 = 重力 − 船の加速度。水面はこれに垂直になろうとする
    const gy = Math.max(1, G + acc.y);
    const tx = Math.max(-SLOSH_MAX, Math.min(SLOSH_MAX, acc.x / gy)), tz = Math.max(-SLOSH_MAX, Math.min(SLOSH_MAX, acc.z / gy));
    const w = water[c];
    if (w <= 0 || w >= COMP_VOLUME[c]) { // 空・満水なら揺れる水面が無い
      s.tilt.x = tx; s.tilt.z = tz; s.tiltVel.x = s.tiltVel.z = 0;
    } else {
      // 船体の回転に水面が引きずられる（ω × 上向き = (−ωz, 0, ωx)）
      s.tilt.x += SLOSH_DRAG * -ang.z * DT;
      s.tilt.z += SLOSH_DRAG * ang.x * DT;
      const k = s.omega * s.omega, cdamp = 2 * SLOSH_ZETA * s.omega;
      s.tiltVel.x += (-k * (s.tilt.x - tx) - cdamp * s.tiltVel.x) * DT;
      s.tiltVel.z += (-k * (s.tilt.z - tz) - cdamp * s.tiltVel.z) * DT;
      s.tilt.x = Math.max(-SLOSH_MAX, Math.min(SLOSH_MAX, s.tilt.x + s.tiltVel.x * DT));
      s.tilt.z = Math.max(-SLOSH_MAX, Math.min(SLOSH_MAX, s.tilt.z + s.tiltVel.z * DT));
    }
    s.n.set(s.tilt.x, 1, s.tilt.z).normalize();
  }

  function step() {
    const t = body.translation(), q = body.rotation(), lv = body.linvel(), av = body.angvel(), wc = body.worldCom();
    pos.set(t.x, t.y, t.z);
    rot.set(q.x, q.y, q.z, q.w);
    lin.set(lv.x, lv.y, lv.z);
    ang.set(av.x, av.y, av.z);
    com.set(wc.x, wc.y, wc.z);
    acc.subVectors(lin, prevLin).divideScalar(DT);
    prevLin.copy(lin);
    F.set(0, 0, 0);
    T.set(0, 0, 0);

    // 浮力 + 抵抗。ponytail: セル中心の高さで没水率を線形補間。精度は CELL で上げる
    for (const s of cells) {
      toWorld(s.local, s.world);
      const frac = Math.min(1, Math.max(0, (0 - (s.world.y - CELL / 2)) / CELL));
      if (frac === 0) continue;
      const vel = r.subVectors(s.world, com).cross(ang).negate().add(lin); // v = lin + ω × r
      const d = DRAG * CELL_VOL * frac;
      addAt(-d * vel.x, RHO * G * CELL_VOL * frac - d * vel.y, -d * vel.z, s.world);
    }

    // 浸水: 内外の水頭差からオリフィス流量 Q = Cd·A·√(2gΔh)
    for (const h of holes) {
      h.q = 0;
      if (water[h.comp] >= COMP_VOLUME[h.comp]) continue;
      toWorld(h.local, p);
      const dh = -p.y - Math.max(0, surfaceYAt(h.comp, p.x, p.z) - p.y);
      if (dh <= 0) continue;
      h.q = CD * h.area * Math.sqrt(2 * G * dh);
      water[h.comp] = Math.min(COMP_VOLUME[h.comp], water[h.comp] + h.q * DT);
    }

    // 区画内の水を水面の法線方向に低いセルから詰める。水面は通常は水平、揺れているときは傾く
    // ponytail: 水の運動量は持たない（重さの分布だけ）。区画内の流れそのものを解くなら SPH 等
    compCells.forEach((cs, c) => {
      const s = surfaces[c];
      updateSlosh(s, c);
      for (const cell of cs) cell.key = s.n.dot(cell.world);
      cs.sort((a, b) => a.key - b.key);
      let rem = water[c], top = null;
      for (const cell of cs) {
        cell.fill = Math.min(1, rem / CELL_VOL);
        rem -= cell.fill * CELL_VOL;
        if (cell.fill > 0) top = cell;
      }
      s.d = top ? top.key + (top.fill - 0.5) * CELL : cs[0].key - CELL / 2;
    });

    // 浸水は「付加重量法」: 水の入ったセルの位置にその重さを下向きに加える
    for (const s of cells) if (s.fill > 0) addAt(0, -RHO * G * CELL_VOL * s.fill, 0, s.world);

    body.resetForces(true);
    body.resetTorques(true);
    body.addForce(F, true);
    body.addTorque(T, true);
    world.step();
  }

  const deg = (v) => (Math.asin(Math.min(1, Math.max(-1, v))) * 180) / Math.PI;
  function state() {
    const q = body.rotation(), qq = new Quaternion(q.x, q.y, q.z, q.w);
    return {
      y: body.translation().y,
      pitchDeg: deg(new Vector3(0, 0, 1).applyQuaternion(qq).y), // 負 = 船首が下がっている
      rollDeg: deg(new Vector3(1, 0, 0).applyQuaternion(qq).y), // 正 = 右舷（-x 側）に傾いている
      flood: water.map((w, c) => w / COMP_VOLUME[c]),
    };
  }

  return { world, body, hullCollider, step, state, cells, holes, surfaces, surfaceYAt, water, addHole, addSideHole, torpedo };
}
