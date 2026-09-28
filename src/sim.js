// 船体の運動（Rapier の剛体）。浮力・波・流体抵抗は Rapier に無いので、船体をセルに分けて力を計算して合力とトルクを加える。
// 船内の水は GPU 流体が持ち、その質量・重心・慣性（setWater）を船体と合成して 1 つの剛体として動かす（付加重量法）。
// 描画に依存しない。node からもテストできる。
import RAPIER from '@dimforge/rapier3d-compat';
import { Vector3, Quaternion } from 'three';
import * as H from './hull.js';
import * as W from './waves.js';
import * as MP from './massprops.js';

export const RHO = 1025; // 海水の密度 [kg/m³]
export const G = W.G;
export const SEABED_Y = -60;
export const DESIGN_DRAFT = H.DESIGN_DRAFT; // 設計喫水 [m]（SSOT は hull.js。描画だけの開発ページも使う）
export const CELL = 0.8; // 浮力セルの一辺 [m]（全長 130 m の船で ~1.3 万個）
export const GM = 0.95; // 設計喫水での横メタセンタ高さ [m]（友鶴事件後の駆逐艦の復原性の目安、推定）
export const DT = 1 / 60;

const cells0 = H.buildCells(CELL); // 水密の外殻（船体。船首楼を含む）
export const ENVELOPE_VOLUME = cells0.length * CELL ** 3;
const design = H.displacement(cells0, CELL, DESIGN_DRAFT);
export const SHIP_MASS = RHO * design.v; // 空船 + 積荷 + 燃料（設計喫水で釣り合う重さ）
// 重心: 前後は浮心に合わせて水平に浮かせる。高さ KG = KM − GM（KM = KB + BM、BM = 水線面の横二次モーメント ÷ 排水量）
export const SHIP_COM = [0, design.kb + H.waterplaneInertia(DESIGN_DRAFT) / design.v - GM, design.lcb];
export const SHIP_INERTIA = [SHIP_MASS * (0.26 * H.L) ** 2, SHIP_MASS * (0.27 * H.L) ** 2, SHIP_MASS * (0.36 * H.B) ** 2, 0, 0, 0];

// 流体抵抗。LIN: 没水体積あたりの線形減衰（上下揺れが臨界減衰の 3 割程度）。QUAD: 投影面積あたりの形状抵抗係数
const LIN = 1300;
const QUAD_CD = 1.0;
const AREA = [H.L * H.D * 0.9, H.L * H.B * 0.85, H.B * H.D * 0.8]; // 船体座標 x, y, z 方向の投影面積
const ROT_DAMP = 0.08; // 回転の線形減衰（横揺れの造波減衰の代わり）[1/s]

export async function createSim({ waves = [], seabedY = SEABED_Y } = {}) {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 }); // 重力は自前で加える（質量が浸水で変わるため）
  world.timestep = DT;

  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, -DESIGN_DRAFT, 0).setCanSleep(false));
  const pts = [];
  for (const row of H.surfaceGrid(60, 10)) for (const p of row) pts.push(p.hb, p.y, p.z, -p.hb, p.y, p.z);
  const hullCollider = world.createCollider(RAPIER.ColliderDesc.convexHull(new Float32Array(pts)).setDensity(0).setFriction(0.6), body);
  world.createCollider(RAPIER.ColliderDesc.cuboid(600, 1, 600).setTranslation(0, seabedY - 1, 0).setFriction(0.8));

  const ship = { mass: SHIP_MASS, com: SHIP_COM, inertia: SHIP_INERTIA };
  let water = { mass: 0, com: [0, 0, 0], inertia: [0, 0, 0, 0, 0, 0] };
  let applied = water; // 剛体に最後に反映した水。閾値の比較はこれと行う（前回の受け取り値と比べると、少しずつ増える浸水が永久に反映されない）
  let total = ship;
  function applyMass() {
    applied = water;
    total = MP.combine(ship, water);
    const e = MP.eigenSym(total.inertia);
    const q = MP.matToQuat(e.vectors);
    const [cx, cy, cz] = total.com;
    body.setAdditionalMassProperties(total.mass, { x: cx, y: cy, z: cz }, { x: e.values[0], y: e.values[1], z: e.values[2] }, q, true);
    body.recomputeMassPropertiesFromColliders();
  }
  applyMass();

  // 船内の水の質量特性（GPU 流体の集計値）。質量が 0.1% 以上、または重心が 2 cm 以上動いたときだけ剛体に反映する
  // GPU の集計は信頼境界の外。非有限・負の値は捨てて直前の値を保つ（一度 NaN を Rapier に渡すと重心が NaN のまま戻らない）
  function setWater(wm) {
    if (!(wm.mass >= 0) || ![wm.mass, ...wm.com, ...wm.inertia].every(Number.isFinite)) return;
    const dm = Math.abs(wm.mass - applied.mass), dc = Math.hypot(...wm.com.map((c, i) => c - applied.com[i]));
    water = wm;
    if (dm > total.mass * 1e-3 || dc > 0.02 || (wm.mass === 0) !== (applied.mass === 0)) applyMass();
  }

  const cells = Float64Array.from(cells0.flatMap((c) => [c.x, c.y, c.z]));
  // 船の周りの海面。船の向きに沿った長方形: 長さは全長 + 余裕、幅は横倒し（甲板の高さ ~11 m が横に来る）でも覆う ±16 m
  const heights = W.createHeightGrid(H.L + 20, W.HEIGHT_STEP, 32);
  const fwd = [0, 1];
  const pos = new Vector3(), rot = new Quaternion(), lin = new Vector3(), ang = new Vector3(), com = new Vector3();
  const p = new Vector3(), r = new Vector3(), v = new Vector3(), f = new Vector3(), F = new Vector3(), T = new Vector3(), tmp = new Vector3();
  const invRot = new Quaternion();
  let t = 0, submerged = 0;
  const kin = { vO: new Vector3(), w: new Vector3(), aO: new Vector3(), alpha: new Vector3() };

  function step() {
    const tr = body.translation(), q = body.rotation(), lv = body.linvel(), av = body.angvel(), wc = body.worldCom();
    pos.set(tr.x, tr.y, tr.z); rot.set(q.x, q.y, q.z, q.w); lin.set(lv.x, lv.y, lv.z); ang.set(av.x, av.y, av.z); com.set(wc.x, wc.y, wc.z);
    // 艦首の向き（船体の +z をワールドの水平面へ）。格子を艦に沿わせる
    fwd[0] = 2 * (q.x * q.z + q.y * q.w); fwd[1] = 1 - 2 * (q.x * q.x + q.y * q.y);
    heights.update(waves, pos.x, pos.z, t, fwd);
    let vol = 0;
    const cv = CELL ** 3;
    // 回転行列（three の Quaternion → 成分）。セル 7 千個の内側では Vector3 のメソッドを使わない
    const { x: qx, y: qy, z: qz, w: qw } = rot;
    const r00 = 1 - 2 * (qy * qy + qz * qz), r01 = 2 * (qx * qy - qz * qw), r02 = 2 * (qx * qz + qy * qw);
    const r10 = 2 * (qx * qy + qz * qw), r11 = 1 - 2 * (qx * qx + qz * qz), r12 = 2 * (qy * qz - qx * qw);
    const r20 = 2 * (qx * qz - qy * qw), r21 = 2 * (qy * qz + qx * qw), r22 = 1 - 2 * (qx * qx + qy * qy);
    let fx = 0, fy = 0, fz = 0, tx = 0, ty = 0, tz = 0;
    for (let i = 0; i < cells.length; i += 3) {
      const lx = cells[i], ly = cells[i + 1], lz = cells[i + 2];
      const wy = r10 * lx + r11 * ly + r12 * lz + pos.y;
      if (wy - CELL / 2 > heights.max) continue; // 波頂より上
      const wx = r00 * lx + r01 * ly + r02 * lz + pos.x, wz = r20 * lx + r21 * ly + r22 * lz + pos.z;
      const eta = heights.sample(wx, wz);
      const frac = Math.min(1, Math.max(0, (eta - (wy - CELL / 2)) / CELL));
      if (frac === 0) continue;
      vol += frac * cv;
      const rx = wx - com.x, ry = wy - com.y, rz = wz - com.z;
      // セルの速度 v = v_cm + ω × r
      const vx = lin.x + ang.y * rz - ang.z * ry, vy = lin.y + ang.z * rx - ang.x * rz, vz = lin.z + ang.x * ry - ang.y * rx;
      const d = LIN * cv * frac;
      const ax = -d * vx, ay = RHO * G * cv * frac - d * vy, az = -d * vz;
      fx += ax; fy += ay; fz += az;
      tx += ry * az - rz * ay; ty += rz * ax - rx * az; tz += rx * ay - ry * ax;
    }
    F.set(fx, fy, fz); T.set(tx, ty, tz);
    submerged = vol / ENVELOPE_VOLUME;
    // 形状抵抗（速度の 2 乗）。船体座標の軸ごとの投影面積 × 没水率
    invRot.copy(rot).invert();
    tmp.copy(lin).applyQuaternion(invRot);
    const sub = Math.min(1, vol / (0.5 * ENVELOPE_VOLUME));
    f.set(-0.5 * RHO * QUAD_CD * AREA[0] * sub * Math.abs(tmp.x) * tmp.x, -0.5 * RHO * QUAD_CD * AREA[1] * sub * Math.abs(tmp.y) * tmp.y, -0.5 * RHO * QUAD_CD * AREA[2] * sub * Math.abs(tmp.z) * tmp.z);
    F.add(f.applyQuaternion(rot));
    // 回転の減衰（慣性に比例）
    tmp.copy(ang).applyQuaternion(invRot);
    const I = total.inertia;
    T.add(new Vector3(-ROT_DAMP * sub * I[0] * tmp.x, -ROT_DAMP * sub * I[1] * tmp.y, -ROT_DAMP * sub * I[2] * tmp.z).applyQuaternion(rot));
    F.y -= total.mass * G; // 重力（船体 + 船内の水）。重心に掛かるのでトルクは無い

    body.resetForces(true); body.resetTorques(true);
    body.addForce(F, true); body.addTorque(T, true);
    world.step();
    t += DT;

    // 流体格子（船体座標）に渡す運動: 原点の速度・加速度と角速度・角加速度（ワールド）
    const nlv = body.linvel(), nav = body.angvel(), nwc = body.worldCom(), ntr = body.translation();
    const w = new Vector3(nav.x, nav.y, nav.z);
    const vO = new Vector3(nlv.x, nlv.y, nlv.z).add(w.clone().cross(new Vector3(ntr.x - nwc.x, ntr.y - nwc.y, ntr.z - nwc.z)));
    kin.aO.subVectors(vO, kin.vO).divideScalar(DT);
    kin.alpha.subVectors(w, kin.w).divideScalar(DT);
    kin.vO.copy(vO); kin.w.copy(w);
  }

  // 流体に渡す見かけの力（船体座標）。g_eff = Rᵀ(g − a_O)。着底の衝撃などの外れ値は 3g で抑える
  function fluidFrame() {
    const tq = body.rotation();
    const inv = new Quaternion(tq.x, tq.y, tq.z, tq.w).invert();
    const clampLen = (vv, m) => (vv.length() > m ? vv.setLength(m) : vv);
    const a = clampLen(kin.aO.clone(), 3 * G);
    return {
      gravity: new Vector3(0, -G, 0).sub(a).applyQuaternion(inv),
      omega: kin.w.clone().applyQuaternion(inv),
      alpha: clampLen(kin.alpha.clone(), 4).applyQuaternion(inv),
    };
  }

  const toWorld = (local, out = [0, 0, 0]) => {
    const tq = body.rotation(), tt = body.translation();
    p.set(local[0], local[1], local[2]).applyQuaternion(rot.set(tq.x, tq.y, tq.z, tq.w)).add(tmp.set(tt.x, tt.y, tt.z));
    out[0] = p.x; out[1] = p.y; out[2] = p.z;
    return out;
  };

  const deg = (s) => (Math.asin(Math.min(1, Math.max(-1, s))) * 180) / Math.PI;
  function state() {
    const tq = body.rotation(), tt = body.translation();
    const qq = new Quaternion(tq.x, tq.y, tq.z, tq.w);
    const keel = new Vector3(0, 0, 0).applyQuaternion(qq).add(new Vector3(tt.x, tt.y, tt.z));
    return {
      t,
      y: tt.y,
      draft: heights.sample(keel.x, keel.z) - keel.y, // 船体中央のキールの海面からの深さ
      pitchDeg: deg(new Vector3(0, 0, 1).applyQuaternion(qq).y), // 正 = 船首が上がっている
      rollDeg: deg(new Vector3(1, 0, 0).applyQuaternion(qq).y), // 正 = 左舷（+x）が上がっている（右舷に傾斜）
      submerged,
      waterMass: water.mass,
      totalMass: total.mass,
      com: total.com,
    };
  }

  return {
    world, body, hullCollider, step, state, setWater, fluidFrame, toWorld,
    sea: (x, z) => heights.sample(x, z),
    get time() { return t; },
    get waves() { return waves; },
    set waves(w) { waves = w; },
  };
}
