// 船体形状の SSOT。物理（浮力セル・衝突形状・流体格子）と描画（外板メッシュ・塗装位置）の両方がここを参照する。
// 座標: +z 船首, +y 上, +x 左舷（port）。原点は船底（キール）の高さ、船体中央。単位 m。
// three を import しない純粋な数式だけにして node でもテストできるようにする。

export const L = 30; // 全長（甲板位置）
export const B = 7; // 型幅
export const D = 5; // 深さ（船体中央の上甲板まで）
export const Z_MIN = -L / 2, Z_MAX = L / 2;
export const TANK_TOP = 0.9; // 二重底の天板。これより下は燃料・バラストタンク（浸水しない前提）

const BOW_START = 6; // これより前で船首が絞られる
const STERN_START = -9; // これより後ろで船尾が絞られる
const BOW_RAKE = 2.2; // 船首材の傾き。船底側ほど手前で閉じる
const BILGE = 0.24; // ビルジ（船底の角）の丸みの大きさ（深さに対する比）

// 船底の高さ。船首（フォアフット）と船尾（カットアップ）で持ち上がる
export function keelY(z) {
  if (z > BOW_START) return D * 0.45 * ((z - BOW_START) / (Z_MAX - BOW_START)) ** 2.2;
  if (z < STERN_START) return D * 0.3 * ((STERN_START - z) / (STERN_START - Z_MIN)) ** 2;
  return 0;
}

// 上甲板の高さ。舷弧（シア）で船首・船尾が高い
export function deckY(z) {
  const t = z / (L / 2);
  return D + 0.35 * t * t + (z > 0 ? 0.45 * t ** 3 : 0);
}

// 水線面の幅の比率 0..1
function planScale(z) {
  if (z > BOW_START) return Math.max(0, 1 - ((z - BOW_START) / (Z_MAX - BOW_START)) ** 1.6);
  if (z < STERN_START) return 1 - 0.28 * ((STERN_START - z) / (STERN_START - Z_MIN)) ** 1.8; // 船尾はトランサム（平らな板）で終わる
  return 1;
}

// 高さ y・位置 z での船体の半幅。船体の外なら -1
export function halfBreadth(z, y) {
  if (z < Z_MIN || z > Z_MAX) return -1;
  const k = keelY(z), d = deckY(z);
  const t = (y - k) / (d - k); // 船底 0 → 甲板 1
  if (t < 0 || t > 1) return -1;
  const ps = planScale(z > 0 ? z + BOW_RAKE * (1 - t) ** 2 : z);
  if (ps <= 0) return -1;
  const rb = BILGE + (1 - BILGE) * (1 - planScale(z)) ** 0.7; // 船首ほど V 字断面に近づける
  const s = t >= rb ? 1 : 1 - rb + rb * Math.sqrt(1 - ((rb - t) / rb) ** 2);
  const flare = 1 + 0.06 * Math.max(0, t - 0.6) * (1 - planScale(z)); // 船首上部のフレア（波を返す広がり）
  return (B / 2) * ps * s * flare;
}

export const inside = (x, y, z) => Math.abs(x) <= halfBreadth(z, y);

export const Y_MIN = 0;
export const Y_MAX = deckY(Z_MAX);

// 船体表面の外向き法線（数値微分）。舷側の点 (x, y, z) で使う
export function surfaceNormal(x, y, z, e = 0.02) {
  const f = (a, b, c) => Math.abs(a) - halfBreadth(c, b); // 0 が表面、正が船外
  let nx = (f(x + e, y, z) - f(x - e, y, z)) / (2 * e);
  let ny = (f(x, y + e, z) - f(x, y - e, z)) / (2 * e);
  let nz = (f(x, y, z + e) - f(x, y, z - e)) / (2 * e);
  if (!Number.isFinite(ny) || Math.abs(ny) > 50) ny = 0;
  if (!Number.isFinite(nz) || Math.abs(nz) > 50) nz = 0;
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

// 船体表面の点群（衝突形状の凸包と描画メッシュの元）。p(i, j) = 断面 i、断面内の高さ比 j の点
export function surfaceGrid(nz = 120, nt = 20) {
  const rows = [];
  for (let i = 0; i <= nz; i++) {
    const z = Z_MIN + (L * i) / nz;
    const k = keelY(z), d = deckY(z), row = [];
    for (let j = 0; j <= nt; j++) {
      const y = k + ((d - k) * j) / nt;
      row.push({ z, y, hb: Math.max(0, halfBreadth(z, Math.min(d - 1e-9, Math.max(k + 1e-9, y)))) });
    }
    rows.push(row);
  }
  return rows;
}

// 浮力計算用のセル（立方体）。中心が inside(x, y, z) を満たすものだけ残す
export function buildCells(h, isInside = inside, yMax = Y_MAX) {
  const cells = [];
  for (let x = -B / 2 + h / 2; x < B / 2; x += h)
    for (let y = Y_MIN + h / 2; y < yMax; y += h)
      for (let z = Z_MIN + h / 2; z < Z_MAX; z += h)
        if (isInside(x, y, z)) cells.push({ x, y, z });
  return cells;
}

// 静水中で y = wl まで沈めたときの排水量 [m³] と浮心 (lcb = z, kb = y)
export function displacement(cells, h, wl) {
  let v = 0, mz = 0, my = 0;
  for (const c of cells) {
    const f = Math.min(1, Math.max(0, (wl - (c.y - h / 2)) / h));
    if (f === 0) continue;
    const dv = f * h ** 3;
    v += dv;
    mz += dv * c.z;
    my += dv * (c.y - h / 2 + (f * h) / 2);
  }
  return { v, lcb: v > 0 ? mz / v : 0, kb: v > 0 ? my / v : 0 };
}

// 排水量が volume になる喫水線の高さ（二分法）
export function waterlineFor(cells, h, volume) {
  let lo = Y_MIN, hi = Y_MAX;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (displacement(cells, h, mid).v < volume) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
