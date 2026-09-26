// 船体形状の SSOT。物理（セル化・衝突形状・喫水）と描画（メッシュ・塗装位置）の両方がここを参照する。
// 座標: +z 船首, +y 上, +x 左舷（port）。単位 m。three を import しない純粋な数式だけにして node でもテストできるようにする。

export const L = 8; // 全長
export const B = 2.2; // 船幅
export const D = 1.4; // 船底から甲板（中央部）までの深さ
export const Z_MIN = -L / 2, Z_MAX = L / 2;

const BOW_START = 1.4; // これより前で船首が絞られる
const STERN_START = -2.6; // これより後ろで船尾が絞られる
const BOW_RAKE = 0.6; // 船首材の傾き。船底側ほど手前で閉じる
const BILGE = 0.35; // ビルジ（船底の角）の丸みの大きさ（半幅に対する比）

export const BULKHEADS = [-1.33, 1.33]; // 水密隔壁の z。3 区画（船尾・中央・船首）
export const compOf = (z) => BULKHEADS.filter((b) => z > b).length;
export const COMP_RANGES = [[Z_MIN, BULKHEADS[0]], [BULKHEADS[0], BULKHEADS[1]], [BULKHEADS[1], Z_MAX]];

// 船底の高さ。船首・船尾で持ち上がる
export function keelY(z) {
  if (z > BOW_START) return -D / 2 + D * 0.5 * ((z - BOW_START) / (Z_MAX - BOW_START)) ** 2;
  if (z < STERN_START) return -D / 2 + D * 0.28 * ((STERN_START - z) / (STERN_START - Z_MIN)) ** 2;
  return -D / 2;
}

// 甲板の高さ。舷弧（シア）で船首・船尾が高い
export function deckY(z) {
  const t = z / (L / 2);
  return D / 2 + 0.1 * t * t + (z > 0 ? 0.12 * t ** 3 : 0);
}

// 水線面の幅の比率 0..1
function planScale(z) {
  if (z > BOW_START) return Math.max(0, 1 - ((z - BOW_START) / (Z_MAX - BOW_START)) ** 1.7);
  if (z < STERN_START) return 1 - 0.3 * ((STERN_START - z) / (STERN_START - Z_MIN)) ** 2; // 船尾はトランサム（平らな板）で終わる
  return 1;
}

// 甲板の開口部。z と一辺の長さ（door は開口面積が同じになる正方形の一辺）。物理では常に開いている開口部として扱う
// 船尾区画は上部構造の後ろのハッチと、上部構造前面の扉（船尾を上にして立ったときに水没し、最後まで浮かせない）
export const HATCHES = [
  { z: -3.5, size: 0.5, type: 'hatch' },
  { z: -1.45, size: 0.35, type: 'door' },
  { z: 0, size: 0.6, type: 'hatch' },
  { z: 2.3, size: 0.55, type: 'hatch' },
];

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
  return (B / 2) * ps * s;
}

export const inside = (x, y, z) => Math.abs(x) <= halfBreadth(z, y);

export const Y_MIN = -D / 2;
export const Y_MAX = deckY(Z_MAX);

// 船体表面の点群（衝突形状の凸包と描画メッシュの元）。p(i, j) = 断面 i、断面内の高さ比 j の点
export function surfaceGrid(nz = 80, nt = 16) {
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

// 浮力・浸水計算用のセル（立方体）。中心が船体内にあるものだけ残す
export function buildCells(h) {
  const cells = [];
  for (let x = -B / 2 + h / 2; x < B / 2; x += h)
    for (let y = Y_MIN + h / 2; y < Y_MAX; y += h)
      for (let z = Z_MIN + h / 2; z < Z_MAX; z += h)
        if (inside(x, y, z)) cells.push({ x, y, z, comp: compOf(z) });
  return cells;
}

// 静水中で船体を y = wl まで沈めたときの排水量 [m³] と浮心 z
export function displacement(cells, h, wl) {
  let v = 0, mz = 0;
  for (const c of cells) {
    const f = Math.min(1, Math.max(0, (wl - (c.y - h / 2)) / h)) * h ** 3;
    v += f;
    mz += f * c.z;
  }
  return { v, lcb: v > 0 ? mz / v : 0 };
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
