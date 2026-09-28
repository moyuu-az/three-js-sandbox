// 船体形状の SSOT。物理（浮力セル・衝突形状・流体格子）と描画（外板メッシュ・塗装位置）の両方がここを参照する。
// 船は駆逐艦 島風（1943 年竣工）。実寸（全長 129.5 m）で作る。寸法の出典と推定の区別は layout.js の冒頭。
// 座標: +z 船首, +y 上, +x 左舷（port）。原点は船底（キール）の高さ、船体中央。単位 m。
// three を import しない純粋な数式だけにして node でもテストできるようにする。

export const L = 129.5; // 全長（甲板位置）
export const B = 11.2; // 最大幅
export const D = 7.02; // 深さ（船体中央の上甲板まで）
export const Z_MIN = -L / 2, Z_MAX = L / 2;
export const DESIGN_DRAFT = 4.14; // 設計喫水 [m]（船体中央のキールから）。島風の公試状態（燃料 2/3）
export const TANK_TOP = 1.0; // 二重底の天板。これより下は燃料・水のタンク（浸水しない前提）
// 船首楼: 船首からここまで上甲板の上にもう 1 層（船首楼甲板）がある。後ろ端は切り立った壁（船首楼の後端壁）
export const FC_Z = 21.0;
export const FC_H = 2.4; // 船首楼甲板の上甲板からの高さ

const BOW_START = 8; // これより前で船首が絞られる（長く細い船首: 駆逐艦の高速船型）
const STERN_START = -18; // これより後ろで船尾が絞られる
const STERN_ROUND = 3.0; // 巡洋艦型船尾の平面の丸み（最後のこの長さで丸く閉じる）
const STERN_W = 0.52; // 丸みの始まりでの幅の比
const BOW_RAKE = 7.5; // 船首材の傾き。船底側ほど手前で閉じる（上端が前へ突き出したクリッパー型に近い形）
const FLOOR = 3.4; // 船体中央でビルジの丸みが終わる（幅が最大になる）高さ [m]
const FULL = 4.1; // 断面の肥え具合（大きいほど箱形）。駆逐艦の中央断面係数 ~0.8 に合わせる

// 船底の高さ。船首（フォアフット）と船尾（カットアップ: 推進軸と舵の上で持ち上がる）で持ち上がる
export function keelY(z) {
  if (z > BOW_START) return D * 0.5 * ((z - BOW_START) / (Z_MAX - BOW_START)) ** 2.6;
  if (z < STERN_START) return 3.7 * ((STERN_START - z) / (STERN_START - Z_MIN)) ** 1.7;
  return 0;
}

// 上甲板の高さ。舷弧（シア）: 船首へ向けて高く、船尾はほぼ平ら
export function upperY(z) {
  const t = z / (L / 2);
  return D + (z > 0 ? 0.9 * t * t : 0.25 * t * t);
}

// 最も上の甲板（外殻の上端）の高さ。船首楼の範囲は船首楼甲板（船首へ向けてさらに反り上がる）
export function deckY(z) {
  if (z < FC_Z) return upperY(z);
  const f = (z - FC_Z) / (Z_MAX - FC_Z);
  return upperY(z) + FC_H + 0.9 * f * f;
}

// 水線面の幅の比率 0..1
function planScale(z) {
  if (z > BOW_START) return Math.max(0, 1 - ((z - BOW_START) / (Z_MAX - BOW_START)) ** 1.7);
  if (z < STERN_START) {
    const zr = Z_MIN + STERN_ROUND;
    if (z >= zr) return 1 - (1 - STERN_W) * ((STERN_START - z) / (STERN_START - zr)) ** 1.9;
    if (z <= Z_MIN) return 0;
    return STERN_W * Math.sqrt(1 - ((zr - z) / STERN_ROUND) ** 2); // 丸い船尾
  }
  return 1;
}

// 高さ y・位置 z での船体の半幅。船体の外なら -1
export function halfBreadth(z, y) {
  if (z < Z_MIN || z > Z_MAX) return -1;
  const k = keelY(z), u = upperY(z), d = deckY(z);
  if (y < k || y > d) return -1;
  // 断面の形は上甲板までで決める（船首楼の段で形が飛ばないように）。上甲板より上（船首楼の舷側）は上甲板の幅から少し広がる
  const t = Math.min(1, (y - k) / (u - k)); // 船底 0 → 上甲板 1
  const ps = planScale(z > 0 ? z + BOW_RAKE * (1 - t) ** 1.6 : z);
  if (ps <= 0) return -1;
  // 断面: 船底の立ち上がり（デッドライズ）とビルジを 1 − (1 − y/Y0)^n で表す。船首ほど Y0 を上げ n を下げて V 字に近づける
  const v = (1 - planScale(z)) ** 0.7;
  const y0 = FLOOR + (u - k - FLOOR) * v, n = FULL - 1.8 * v;
  const s = 1 - (1 - Math.min(1, (y - k) / y0)) ** n;
  const bow = z > 0 ? 1 - planScale(z) : 0;
  const flare = 1 + 0.1 * Math.max(0, t - 0.55) * bow + 0.05 * Math.max(0, y - u) * bow; // 船首上部のフレア（波を返す広がり）
  return (B / 2) * Math.min(1, ps * s * flare);
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

// 断面を並べる z。等間隔に、船首楼の後端の前後（段の両側）を足す（外板の段が斜めにならないように）
export function stations(n) {
  const zs = [];
  for (let i = 0; i <= n; i++) zs.push(Z_MIN + (L * i) / n);
  zs.push(FC_Z - 1e-3, FC_Z);
  return [...new Set(zs)].sort((a, b) => a - b);
}

// 船体表面の点群（衝突形状の凸包と描画メッシュの元）。p(i, j) = 断面 i、断面内の高さ比 j の点
export function surfaceGrid(nz = 120, nt = 20) {
  const rows = [];
  for (const z of stations(nz)) {
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

// 水線 y = wl の水線面の横断面二次モーメント I_T = ∫ (2/3) b³ dz [m⁴]（b = 半幅）。BM = I_T / 排水量
export function waterplaneInertia(wl, dz = 0.05) {
  let I = 0;
  for (let z = Z_MIN + dz / 2; z < Z_MAX; z += dz) {
    const b = halfBreadth(z, wl);
    if (b > 0) I += (2 / 3) * b ** 3 * dz;
  }
  return I;
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
