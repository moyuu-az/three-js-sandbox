// 流体格子（船体座標に固定）の格子点の分類と距離場。GPU 流体（gpu/fluid.js）の境界条件の元データ。
// three を import しない純粋な計算なので node でテストできる。
//
// 格子点 (i, j, k) の船体座標 = origin + (i+.5, j+.5, k+.5) · h
export const NODE_FLUID = 0; // 水が入れる
export const NODE_SOLID = 1; // 構造（甲板・隔壁・壁・機械）
export const NODE_EXTERIOR = 2; // 船外。ここに入った粒子は船外へ出たものとして消す
export const NODE_OPENING_IN = 16; // + 開口部番号。開口部の船内側
export const NODE_OPENING_OUT = 48; // + 開口部番号。開口部の船外側（粒子は消す）
export const MAX_OPENINGS = 16;
export const MAX_ROOMS = 32;
export const NO_ROOM = MAX_ROOMS - 1; // 部屋に属さない格子点の集計先
const MAX_DIST = 1e3;

export const isOpening = (t) => t >= NODE_OPENING_IN;
export const isBlocked = (t) => t === NODE_SOLID || t === NODE_EXTERIOR; // 粒子を押し返す格子点

export function createGrid({ h, origin, dims }) {
  const [nx, ny, nz] = dims;
  const N = nx * ny * nz;
  const index = (i, j, k) => i + nx * (j + ny * k);
  const coords = (n) => [n % nx, Math.floor(n / nx) % ny, Math.floor(n / (nx * ny))];
  const pos = (i, j, k) => [origin[0] + (i + 0.5) * h, origin[1] + (j + 0.5) * h, origin[2] + (k + 0.5) * h];
  // 船体座標 → 格子座標（格子点 i の中心が i+.5）
  const toGrid = (x, y, z) => [(x - origin[0]) / h, (y - origin[1]) / h, (z - origin[2]) / h];
  const toLocal = (gx, gy, gz) => [origin[0] + gx * h, origin[1] + gy * h, origin[2] + gz * h];
  return {
    h, origin, dims, N, index, coords, pos, toGrid, toLocal,
    type: new Uint8Array(N).fill(NODE_EXTERIOR),
    room: new Int32Array(N).fill(NO_ROOM),
  };
}

// 1 次元の二乗距離変換（Felzenszwalb & Huttenlocher）。f: 入力（0 か ∞）、d: 出力。有限の点が無ければ全て ∞
function dt1(f, n, d, v, z) {
  let k = -1;
  for (let q = 0; q < n; q++) {
    if (f[q] === Infinity) continue;
    let s = -Infinity;
    while (k >= 0) {
      const p = v[k];
      s = (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p);
      if (s > z[k]) break;
      k--;
    }
    k++;
    v[k] = q; z[k] = k === 0 ? -Infinity : s; z[k + 1] = Infinity;
  }
  if (k < 0) { d.fill(Infinity, 0, n); return; }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

// 3 次元のユークリッド距離変換。blocked な格子点までの距離（格子点の中心間、セル単位）
export function distanceField(grid, blocked = (t) => isBlocked(t)) {
  const [nx, ny, nz] = grid.dims;
  const N = grid.N;
  const g = new Float64Array(N);
  for (let n = 0; n < N; n++) g[n] = blocked(grid.type[n]) ? 0 : Infinity;
  const m = Math.max(nx, ny, nz);
  const f = new Float64Array(m), d = new Float64Array(m), v = new Int32Array(m), z = new Float64Array(m + 1);
  const pass = (len, count, at) => {
    for (let c = 0; c < count; c++) {
      for (let q = 0; q < len; q++) f[q] = g[at(c, q)];
      dt1(f, len, d, v, z);
      for (let q = 0; q < len; q++) g[at(c, q)] = d[q];
    }
  };
  pass(nx, ny * nz, (c, q) => q + nx * c);
  pass(ny, nx * nz, (c, q) => (c % nx) + nx * (q + ny * Math.floor(c / nx)));
  pass(nz, nx * ny, (c, q) => c + nx * ny * q);
  const out = new Float32Array(N);
  for (let n = 0; n < N; n++) out[n] = Math.min(MAX_DIST, Math.sqrt(g[n])); // 固体が 1 つも無い場合の ∞ を GPU に渡さない
  return out;
}

// GPU 用の配列にまとめる
// info: xyz = 滑り境界の法線（固体の格子点で、水のある側の向き。薄い壁は両側に水があるので軸だけ）、w = 種類
// sdf:  xyz = 距離場の勾配（固体から離れる向き）、w = 距離
export function packForGpu(grid) {
  const [nx, ny, nz] = grid.dims;
  const { N, type } = grid;
  const dist = distanceField(grid);
  const info = new Float32Array(N * 4), sdf = new Float32Array(N * 4);
  const at = (i, j, k) => (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz ? -1 : i + nx * (j + ny * k));
  const free = (n) => n >= 0 && !isBlocked(type[n]);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const n = at(i, j, k);
    const dv = (a, b) => (a >= 0 ? dist[a] : 0) - (b >= 0 ? dist[b] : 0);
    let gx = dv(at(i + 1, j, k), at(i - 1, j, k)), gy = dv(at(i, j + 1, k), at(i, j - 1, k)), gz = dv(at(i, j, k + 1), at(i, j, k - 1));
    const gl = Math.hypot(gx, gy, gz);
    if (gl > 1e-6) { gx /= gl; gy /= gl; gz /= gl; } else gx = gy = gz = 0;
    sdf.set([gx, gy, gz, dist[n]], 4 * n);
    let sx = 0, sy = 0, sz = 0;
    if (isBlocked(type[n])) {
      // 隣の水側の数（軸ごと、±の和）。一番多い軸を法線にする。角（2 軸以上が同数）は 0 = 速度を止める
      const c = [free(at(i + 1, j, k)) + free(at(i - 1, j, k)), free(at(i, j + 1, k)) + free(at(i, j - 1, k)), free(at(i, j, k + 1)) + free(at(i, j, k - 1))];
      const best = Math.max(...c);
      if (best > 0 && c.filter((x) => x === best).length === 1) [sx, sy, sz] = c.map((x) => (x === best ? 1 : 0));
    }
    info.set([sx, sy, sz, type[n]], 4 * n);
  }
  return { info, sdf, rooms: grid.room, dist };
}

// 連結成分（水が通れる格子点のつながり）。テストと部屋のつながりの確認用
export function flood(grid, start, passable = (t) => !isBlocked(t)) {
  const [nx, ny] = grid.dims;
  const seen = new Uint8Array(grid.N);
  const stack = [start];
  seen[start] = 1;
  while (stack.length) {
    const n = stack.pop();
    const [i, j, k] = grid.coords(n);
    for (const [di, dj, dk] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const a = i + di, b = j + dj, c = k + dk;
      if (a < 0 || b < 0 || c < 0 || a >= nx || b >= ny || c >= grid.dims[2]) continue;
      const m = a + nx * (b + ny * c);
      if (!seen[m] && passable(grid.type[m])) { seen[m] = 1; stack.push(m); }
    }
  }
  return seen;
}
