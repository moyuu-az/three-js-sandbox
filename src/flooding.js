// 開口部の流量（オリフィス式）と、部屋の水量から水面の高さを求める計算。GPU 流体に「どれだけ水を入れるか」を渡す。
// 純粋な計算なので node でテストできる。座標は船体座標（m）。
import * as V from './voxel.js';

export const CD = 0.62; // 流量係数（鋭い縁のオリフィス）
// 艦内の水頭が外をこれ [m] 超えたら開口を開放して水を出す。釣り合いの近くで開放と閉鎖を行き来しないための幅（水位の見積もりの揺れ ~0.1 m より大きく）
export const OUT_MARGIN = 0.3;

// 部屋ごとの格子点の位置（水が入れる格子点のみ）。格子を作り直すたびに作る
export function roomNodes(grid, roomCount) {
  const lists = Array.from({ length: roomCount }, () => []);
  for (let n = 0; n < grid.N; n++) {
    const t = grid.type[n];
    const r = grid.room[n];
    if (r >= roomCount) continue;
    if (t === V.NODE_FLUID || (t >= V.NODE_OPENING_IN && t < V.NODE_OPENING_OUT)) lists[r].push(...grid.pos(...grid.coords(n)));
  }
  return lists.map((a) => Float32Array.from(a));
}

/**
 * 部屋の水面の高さ（up 方向の座標）。各格子点を up 方向に厚さ h の層とみなし、
 * Σ clamp((s − (hᵢ − h/2)) / h, 0, 1) · h³ = volume となる s を二分法で求める（水平でも傾いていても滑らか）。
 * 空なら -Infinity、満水なら Infinity。up は船体座標での「上」（見かけの重力の逆向き、単位ベクトル）
 */
export function waterLevel(nodes, h, volume, up, scratch = new Float32Array(nodes.length / 3)) {
  const n = nodes.length / 3;
  if (volume <= 1e-9 || n === 0) return -Infinity;
  const filled = volume / h ** 3;
  if (filled >= n - 1e-6) return Infinity;
  // 扉を開けて作り直すと部屋の格子点が増え、呼び出し側の scratch が足りなくなる。短いまま使うと範囲外が undefined → NaN で水位が壊れる
  const hts = scratch.length >= n ? scratch.subarray(0, n) : new Float32Array(n);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = up[0] * nodes[3 * i] + up[1] * nodes[3 * i + 1] + up[2] * nodes[3 * i + 2];
    hts[i] = v - h / 2; // 層の下端
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  lo -= h; hi += h;
  const inv = 1 / h;
  for (let it = 0; it < 28; it++) {
    const s = (lo + hi) / 2;
    let f = 0;
    for (let i = 0; i < n; i++) { const d = (s - hts[i]) * inv; f += d <= 0 ? 0 : d >= 1 ? 1 : d; }
    if (f < filled) lo = s; else hi = s;
  }
  return (lo + hi) / 2;
}

/**
 * 開口部 1 つの流量。samples（開口面上の点）ごとに内外の水頭差からオリフィス式 Q = Cd·A·√(2gΔh) を足す。
 * ctx.toWorld(p) → ワールド座標、ctx.sea(x, z) → 海面高さ、ctx.up（船体座標の上向き）、ctx.level（部屋の水面）、
 * ctx.airHead（部屋の空気のゲージ圧を水頭 [m] にしたもの。閉じ込められた空気が縮むと正になり流入を押し返す。省略時 0）
 * 戻り値: q [m³/s]（正 = 流入、負 = 流出）、mode、speed = 噴流の速さ [m/s]。mode は
 *   'inflow'  = どこかの点で外の水頭が艦内より高い（粒子を生成する）。同じ開口で出る点があっても流入を優先する（生成を止めない）
 *   'outflow' = 艦内の水頭（水 + 空気）が外より OUT_MARGIN を超えて高い点がある。その点の水頭差でオリフィス式の量と速さを出し、
 *               GPU 流体は開口の水に外向きの速さを与えて外側で消す（自重で落とすだけだと速さが艦内の水深で決まり、
 *               波の谷で速く出て山で遅く入るので、水位が平均の海面より低めに釣り合う）
 *   'free'    = 開放。水の届いていない海面より上の開口（空気だけ）、または満水の部屋で海面より上に出た点（水頭が決まらないので
 *               速さを与えず自重でこぼす）
 *   'closed'  = 釣り合いの近く（差が OUT_MARGIN 以内。開放と閉鎖を行き来しない幅）、または満水の部屋の海面下の開口
 */
export function openingFlow(opening, ctx, g = 9.81) {
  const pts = opening.samples;
  const a = opening.area / pts.length;
  const air = ctx.airHead ?? 0;
  // 満水の部屋は水面が決まらない（水位 +∞）。艦内の水頭を無限大とみなして海面下の開口から出すと、流れ出ては流れ込むのを繰り返す
  const full = ctx.level === Infinity;
  let q = 0, submerged = 0, headSum = 0, inflowPts = 0, qOut = 0, outSum = 0, outPts = 0, spill = false;
  const out = (head) => { qOut += CD * a * Math.sqrt(2 * g * head); outSum += head; outPts++; };
  for (const p of pts) {
    const w = ctx.toWorld(p);
    const hOut = Math.max(0, ctx.sea(w[0], w[2]) - w[1]);
    const water = Math.max(0, ctx.level - (ctx.up[0] * p[0] + ctx.up[1] * p[1] + ctx.up[2] * p[2])); // 点の上の艦内の水の深さ
    // 船内側の圧力 = 空気の圧力 + 水面より下なら水の重さ
    const dh = hOut - (water + air);
    if (hOut <= 0) { // 船外が空気（海面より上）: 水は入らない（空気の出入りは air.js）。艦内の水が届いていて、その圧力（空気込み）が
      // 外気より OUT_MARGIN を超えて高ければ出ていく。空気を見ないと、膨らんで負圧になった空気が吊り上げている水まで落とす
      if (water > 0 && -dh > OUT_MARGIN) { if (full) spill = true; else out(-dh); }
      continue;
    }
    submerged++;
    if (dh > 0) { q += CD * a * Math.sqrt(2 * g * dh); headSum += dh; inflowPts++; } else if (-dh > OUT_MARGIN && !full) out(-dh);
  }
  // 噴流の速さは縮流部の流速 Cv·√(2gΔh)（Cv ≈ 0.98）。平均の水頭で代表させる
  if (q > 0) return { q, mode: 'inflow', speed: 0.98 * Math.sqrt((2 * g * headSum) / inflowPts) };
  if (outPts > 0) return { q: -qOut, mode: 'outflow', speed: 0.98 * Math.sqrt((2 * g * outSum) / outPts) };
  if (submerged === 0 || spill) return { q: 0, mode: 'free', speed: 0 };
  return { q: 0, mode: 'closed', speed: 0 };
}

// 流量を粒子の数に直す。端数は次のフレームに持ち越す（小さい流量でも止まらないように）
export function particlesFor(q, dt, particleVolume, carry = 0) {
  const x = carry + (q * dt) / particleVolume;
  const n = Math.max(0, Math.floor(x + 1e-9)); // 浮動小数の積み残しで 1 個足りなくならないように
  return { count: n, carry: x - n };
}

// 浸水・満水の通知のしきい値 [浸水率]。on を超えたら 1 回知らせ、off を割るまで知らせ直さない
// （水位の見積もりはしきい値の前後で揺れるので、上下同じしきい値だと同じ通知が何度も出た）
const FILL_ALERTS = [['wet', 0.02, 0.01], ['full', 0.95, 0.85]];
/**
 * 部屋ごとの浸水率 fills から、新しく出す通知を求める。notified: 前回の戻り値の notified（最初は省略）。
 * 戻り値: { notified（次に渡す状態）, events: [{ room, kind: 'wet' | 'full' }] }
 */
export function fillAlerts(fills, notified = []) {
  const next = [], events = [];
  fills.forEach((f, room) => {
    const was = notified[room] ?? {}, now = {};
    for (const [kind, on, off] of FILL_ALERTS) {
      now[kind] = was[kind] ? f >= off : f >= on;
      if (now[kind] && !was[kind]) events.push({ room, kind });
    }
    next.push(now);
  });
  return { notified: next, events };
}
