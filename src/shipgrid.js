// 船体と船内配置（hull.js / layout.js）を流体格子（voxel.js）に落とす。扉の開閉・破口の追加のたびに作り直す。
import * as H from './hull.js';
import * as Lo from './layout.js';
import * as V from './voxel.js';

const MARGIN = 0.6; // 船体の外側に最低 1 層は船外の格子点を置く
export const BOUNDS = {
  x: [-H.B / 2 - MARGIN, H.B / 2 + MARGIN],
  y: [-MARGIN, Lo.HOUSE.top + MARGIN],
  z: [H.Z_MIN - MARGIN, H.Z_MAX + MARGIN],
};

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

// 板（隔壁・甲板・壁）が格子上で実際に置かれる座標。描画の壁をここに合わせないと、水が壁にめり込んで見える
export function snapPlane(at, axis, h) {
  const o = gridSpec(h).origin['xyz'.indexOf(axis)];
  return o + (Math.round((at - o) / h - 0.5) + 0.5) * h;
}

// 格子の寸法（h ごとに決まる）
export function gridSpec(h) {
  const dims = ['x', 'y', 'z'].map((a) => Math.ceil((BOUNDS[a][1] - BOUNDS[a][0]) / h));
  return { h, origin: [BOUNDS.x[0], BOUNDS.y[0], BOUNDS.z[0]], dims };
}

/**
 * @param {number} h 格子間隔 [m]
 * @param {{ doors?: Record<string, boolean>, seaOpenings?: Record<string, boolean>, breaches?: object[] }} state
 *   doors / seaOpenings: id → 開いているか（省略時は layout.js の既定値）。breaches: 破口 { center, normal, u, v, half }
 */
export function buildShipGrid(h, state = {}) {
  const grid = V.createGrid(gridSpec(h));
  const { type, room } = grid;
  const [nx, ny, nz] = grid.dims;
  const plate = new Uint8Array(grid.N); // 板（隔壁・甲板・壁）で固体にした格子点。扉で抜けるのはここだけ

  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const n = grid.index(i, j, k);
    const [x, y, z] = grid.pos(i, j, k);
    const inHull = H.inside(x, y, z);
    if (!inHull && !Lo.inHouse(x, y, z)) continue; // 船外（既定値）
    if (inHull && y < H.TANK_TOP) { type[n] = V.NODE_SOLID; continue; } // 二重底
    type[n] = V.NODE_FLUID;
    room[n] = Math.max(0, Lo.roomAt(x, y, z));
    if (Lo.roomAt(x, y, z) < 0) room[n] = V.NO_ROOM;
  }

  // 板: 面に最も近い 1 層の格子点を固体にする。「面から半格子以内」で選ぶと、面が格子点のちょうど中間に来たとき
  // 丸め誤差で 0 層（＝水密隔壁に穴）か 2 層になるので、層の番号を丸めで 1 つに決める
  const layer = (v, axis) => Math.round((v - grid.origin[axis]) / h - 0.5);
  const inSpan = (span, x, y, z) =>
    (!span.x || (x >= span.x[0] && x <= span.x[1])) &&
    (!span.z || (z >= span.z[0] && z <= span.z[1])) &&
    (!span.y || (y >= Lo.resolveY(span.y[0], z) && y <= Lo.resolveY(span.y[1], z)));
  const plates = Lo.PLATES.map((p) => ({ ...p, idx: p.axis === 'deck' ? -1 : layer(p.at, 'xyz'.indexOf(p.axis)) }));
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
    const [x, , z] = grid.pos(i, 0, k);
    const deckJ = layer(H.deckY(z), 1);
    for (let j = 0; j < ny; j++) {
      const n = grid.index(i, j, k);
      if (type[n] !== V.NODE_FLUID) continue;
      const y = grid.pos(i, j, k)[1];
      for (const p of plates) {
        const on = p.axis === 'x' ? i === p.idx : p.axis === 'y' ? j === p.idx : p.axis === 'z' ? k === p.idx : j === deckJ;
        if (on && inSpan(p.span, x, y, z)) { type[n] = V.NODE_SOLID; plate[n] = 1; break; }
      }
    }
  }

  // 扉・ハッチ: 開いていれば板を抜く
  for (const d of Lo.DOORS) {
    const open = d.wt ? (state.doors?.[d.id] ?? d.open) : true;
    if (!open) continue;
    for (let n = 0; n < grid.N; n++) {
      if (!plate[n]) continue;
      const [x, y, z] = grid.pos(...grid.coords(n));
      if (Lo.inBox(d.box, x, y, z)) {
        type[n] = V.NODE_FLUID;
        // 扉の格子点はどちらかの部屋に属させる（少しずらして探す）
        let r = -1;
        for (const [dx, dy, dz] of [[0, 0.3, 0], [0.3, 0, 0], [-0.3, 0, 0], [0, 0, 0.3], [0, 0, -0.3], [0, -0.3, 0]]) {
          r = Lo.roomAt(x + dx, y + dy, z + dz);
          if (r >= 0) break;
        }
        room[n] = r >= 0 ? r : V.NO_ROOM;
      }
    }
  }

  // 機器・貨物
  for (const o of Lo.OBSTACLES) for (let n = 0; n < grid.N; n++) {
    if (type[n] !== V.NODE_FLUID) continue;
    const [x, y, z] = grid.pos(...grid.coords(n));
    if (Lo.inBox(o.box, x, y, z)) type[n] = V.NODE_SOLID;
  }
  for (let n = 0; n < grid.N; n++) if (type[n] !== V.NODE_FLUID) room[n] = V.NO_ROOM;

  // 船外への開口: 開口面の前後 2 格子の範囲を、船内側 = OPENING_IN、船外側 = OPENING_OUT にする
  const openings = [];
  let dropped = 0; // MAX_OPENINGS を超えて格子に入らなかった開口の片（部屋ごと）の数。呼び出し側が「開けたつもりの穴が無い」を知るため
  const carve = (o, meta) => {
    // 軸が単位ベクトルでない開口（船体の外の点で作った破口は法線が 0 になる）を通すと、範囲判定が全格子点で真になり船全体が開口になる
    if (![o.normal, o.u, o.v].every((a) => Math.abs(Math.hypot(...a) - 1) < 1e-3) || !(o.half[0] > 0 && o.half[1] > 0)) return;
    const inner = new Map(); // 部屋 → 船内側の格子点
    const outer = [];
    const depth = 2 * h;
    for (let n = 0; n < grid.N; n++) {
      const t = type[n];
      if (t !== V.NODE_FLUID && t !== V.NODE_EXTERIOR) continue;
      const p = grid.pos(...grid.coords(n));
      const d = sub(p, o.center);
      const a = dot(d, o.u), b = dot(d, o.v), c = dot(d, o.normal);
      if (Math.abs(a) > o.half[0] + 1e-6 || Math.abs(b) > o.half[1] + 1e-6 || c < -depth || c > depth) continue;
      if (t === V.NODE_EXTERIOR) outer.push(n);
      else { const r = room[n]; if (!inner.has(r)) inner.set(r, []); inner.get(r).push(n); }
    }
    let total = 0;
    for (const ns of inner.values()) total += ns.length;
    if (total === 0) return;
    const pieces = [...inner.entries()].sort((p, q) => q[1].length - p[1].length);
    for (const [r, ns] of pieces) {
      if (openings.length >= V.MAX_OPENINGS) { dropped++; continue; }
      const k = openings.length;
      for (const n of ns) type[n] = V.NODE_OPENING_IN + k;
      // 船外側の格子点は一番大きい部屋の開口に付ける（粒子を消すだけなので番号はどれでもよい）
      if (r === pieces[0][0]) for (const n of outer) type[n] = V.NODE_OPENING_OUT + k;
      const pts = ns.map((n) => grid.pos(...grid.coords(n)));
      const cen = [0, 1, 2].map((a) => pts.reduce((s, p) => s + p[a], 0) / pts.length);
      const spread = (ax) => Math.max(h / 2, ...pts.map((p) => Math.abs(dot(sub(p, cen), ax))));
      openings.push({
        k, ...meta, room: r,
        normal: o.normal, u: o.u, v: o.v,
        area: (4 * o.half[0] * o.half[1] * ns.length) / total,
        samples: pts.filter((_, i) => i % Math.max(1, Math.floor(pts.length / 24)) === 0),
        spawn: { center: cen, ax: o.u.map((c) => c * spread(o.u)), ay: o.v.map((c) => c * spread(o.v)) },
      });
    }
  };
  for (const o of Lo.SEA_OPENINGS) {
    if (!(state.seaOpenings?.[o.id] ?? o.open)) continue;
    carve(o, { id: o.id, name: o.name, kind: o.kind });
  }
  (state.breaches ?? []).forEach((b, i) => carve(b, { id: `b${i}`, name: b.name ?? `破口 ${i + 1}`, kind: b.kind ?? 'breach', breach: i }));

  // 部屋ごとの容積（格子点数 × h³）
  const capacity = new Float64Array(Lo.ROOMS.length);
  for (let n = 0; n < grid.N; n++) {
    const t = type[n];
    if ((t === V.NODE_FLUID || (t >= V.NODE_OPENING_IN && t < V.NODE_OPENING_OUT)) && room[n] < Lo.ROOMS.length) capacity[room[n]] += h ** 3;
  }
  return { grid, openings, capacity, dropped };
}

// 法線 n の面に張る単位ベクトル u, v。u: 法線と上向きの外積（前後方向）、v: 法線と u の外積（おおむね上下）。
// 法線がほぼ上下（甲板）なら u は船の横方向
function faceAxes(n) {
  let u = Math.abs(n[1]) > 0.9 ? [1, 0, 0] : [-n[2], 0, n[0]];
  const ul = Math.hypot(...u) || 1;
  u = u.map((a) => a / ul);
  const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  return { u, v };
}

// 舷側の点 (x, y, z) に大きさ w × hgt の破口を開ける情報。u は船の前後方向に沿う
export function breachAt(x, y, z, w = 1.6, hgt = 1.2) {
  const side = x >= 0 ? 1 : -1;
  const hb = H.halfBreadth(z, y);
  const c = [side * Math.max(0, hb), y, z];
  const n = H.surfaceNormal(c[0], y, z);
  return { center: c, normal: n, ...faceAxes(n), half: [w / 2, hgt / 2] };
}

/**
 * 空気圧・水圧で外板が破れた穴。p: 外板の点（air.envelopePoints）、axis: 格子の面の向き（船外向き）。
 * 舷側なら船体の曲面の法線を使う。甲板・甲板室の壁は格子の向きのまま
 */
export function ruptureAt(p, axis, size = 0.8, meta = {}) {
  const onHull = Math.abs(axis[1]) < 0.5 && H.inside(p[0] - axis[0] * 0.2, p[1], p[2] - axis[2] * 0.2) && !Lo.inHouse(p[0], p[1], p[2]);
  let n = onHull ? H.surfaceNormal(p[0], p[1], p[2]) : axis;
  if (!(Math.abs(Math.hypot(...n) - 1) < 1e-3)) n = axis;
  return { center: [...p], normal: n, ...faceAxes(n), half: [size / 2, size / 2], ...meta };
}
