// 海面の波（ガーストナー波の重ね合わせ）。浮力計算（CPU）と海面の描画（シェーダ）が同じ成分を使う SSOT。
// 成分 i: 位相 θ = k (D · x₀) − ω t + φ、変位 = (Q a Dx cos θ, a sin θ, Q a Dz cos θ)。深水の分散関係 ω = √(g k)
export const G = 9.81;
export const MAX_WAVES = 12;

// 海況。hs = 有義波高 [m]、tp = ピーク周期 [s]
export const SEA_STATES = [
  { id: 'calm', name: '穏やか', hs: 0.25, tp: 4.0 },
  { id: 'moderate', name: 'やや波あり', hs: 0.9, tp: 5.5 },
  { id: 'rough', name: '荒天', hs: 2.2, tp: 7.5 },
];

// 決定的な乱数（毎回同じ海になるように）
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/**
 * 有義波高 hs・ピーク周期 tp の波の成分を作る。主方向 dir [rad]（x 軸から z 軸へ）のまわりに ±spread で散らす。
 * 振幅は JONSWAP 風のスペクトル形状で配分し、4√m₀ = hs になるよう正規化する。
 */
export function makeWaves(hs, tp, { dir = 0.5, spread = 0.7, count = MAX_WAVES, seed = 7, steepness = 0.55 } = {}) {
  if (!(hs > 0)) return [];
  const r = rng(seed);
  const wp = (2 * Math.PI) / tp;
  const comps = [];
  for (let i = 0; i < count; i++) {
    const w = wp * (0.7 + (1.6 * (i + r())) / count); // 0.7ωp 〜 2.3ωp
    const s = w ** -5 * Math.exp(-1.25 * (wp / w) ** 4); // PM 型
    const a = dir + (r() - 0.5) * 2 * spread * (i % 2 ? 1 : 0.6);
    comps.push({ dx: Math.cos(a), dz: Math.sin(a), k: (w * w) / G, omega: w, phase: r() * Math.PI * 2, s });
  }
  const m0 = (hs / 4) ** 2, sum = comps.reduce((t, c) => t + c.s, 0);
  let qk = 0;
  for (const c of comps) { c.amp = Math.sqrt((2 * m0 * c.s) / sum); qk += c.k * c.amp; }
  // ガーストナー波の尖り Q。Σ Q k a < 1 でないと波頂がループする
  const q = Math.min(1, steepness / Math.max(qk, 1e-9));
  for (const c of comps) { c.q = q; delete c.s; }
  return comps;
}

// 静止位置 (x0, z0) の水粒子の変位
export function displace(waves, x0, z0, t, out = [0, 0, 0]) {
  let dx = 0, dy = 0, dz = 0;
  for (const w of waves) {
    const th = w.k * (w.dx * x0 + w.dz * z0) - w.omega * t + w.phase;
    const c = Math.cos(th), s = Math.sin(th);
    dx += w.q * w.amp * w.dx * c;
    dz += w.q * w.amp * w.dz * c;
    dy += w.amp * s;
  }
  out[0] = dx; out[1] = dy; out[2] = dz;
  return out;
}

// 水平位置 (x, z) での海面の高さ。ガーストナー波は水平にもずれるので、静止位置を不動点反復で探す
const tmp = [0, 0, 0];
export function heightAt(waves, x, z, t, iterations = 4) {
  if (waves.length === 0) return 0;
  let x0 = x, z0 = z;
  for (let i = 0; i < iterations; i++) {
    displace(waves, x0, z0, t, tmp);
    x0 = x - tmp[0]; z0 = z - tmp[2];
  }
  return displace(waves, x0, z0, t, tmp)[1];
}

// 深さ depth（海面から下向き正）での水粒子の速度（線形理論、指数減衰）
export function orbitalVelocity(waves, x, z, t, depth, out = [0, 0, 0]) {
  let u = 0, v = 0, w = 0;
  for (const c of waves) {
    const th = c.k * (c.dx * x + c.dz * z) - c.omega * t + c.phase;
    const e = c.amp * c.omega * Math.exp(-c.k * Math.max(0, depth));
    const s = Math.sin(th);
    u += e * c.dx * s * c.q; w += e * c.dz * s * c.q;
    v -= e * Math.cos(th);
  }
  out[0] = u; out[1] = v; out[2] = w;
  return out;
}

// シェーダ用に詰める: [dx, dz, k, ω] と [amp, q, phase, 0]
export function packWaves(waves) {
  const a = new Float32Array(MAX_WAVES * 4), b = new Float32Array(MAX_WAVES * 4);
  waves.slice(0, MAX_WAVES).forEach((w, i) => {
    a.set([w.dx, w.dz, w.k, w.omega], 4 * i);
    b.set([w.amp, w.q, w.phase, 0], 4 * i);
  });
  return { a, b, count: Math.min(MAX_WAVES, waves.length) };
}

// 海面高さの格子の間隔 [m]。最短の波（穏やか: 波長 ~4.9 m）の半分より細かくする（粗いと短い波がエイリアスして長いうねりに化ける）
export const HEIGHT_STEP = 2.2;

// 船の周りの海面高さを粗い格子で先に求め、浮力セルでは双線形補間する（セルごとに反復するより 50 倍速い）。
// 格子は船の向き dir（水平の単位ベクトル [x, z]）に沿った長さ length × 幅 width の長方形。全長 130 m の艦を正方形で覆うと
// 点が 3 倍以上になり、剛体の 1 ステップ（60 Hz）ごとの更新が ~11 ms かかった。格子の外の点は端の値で近似する
export function createHeightGrid(length = 48, step = HEIGHT_STEP, width = length) {
  const nu = Math.ceil(length / step) + 1, nv = Math.ceil(width / step) + 1;
  const hts = new Float32Array(nu * nv);
  let cx = 0, cz = 0, dx = 0, dz = 1;
  const grid = {
    max: 0, // 格子内の最高の海面（これより上のセルは計算を省ける）
    points: nu * nv,
    update(waves, x0, z0, t, dir = [0, 1]) {
      const l = Math.hypot(dir[0], dir[1]);
      if (l > 1e-6) { dx = dir[0] / l; dz = dir[1] / l; } // 真上・真下を向いた船（向きが決まらない）は前の向きのまま
      cx = x0; cz = z0;
      let m = -Infinity;
      for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
        const u = i * step - length / 2, v = j * step - width / 2;
        const h = heightAt(waves, cx + u * dx + v * dz, cz + u * dz - v * dx, t, 3);
        hts[i + nu * j] = h;
        if (h > m) m = h;
      }
      grid.max = m;
    },
    sample(x, z) {
      const ex = x - cx, ez = z - cz;
      const fu = Math.min(nu - 1.001, Math.max(0, (ex * dx + ez * dz + length / 2) / step));
      const fv = Math.min(nv - 1.001, Math.max(0, (ex * dz - ez * dx + width / 2) / step));
      const i = Math.floor(fu), j = Math.floor(fv), a = fu - i, b = fv - j;
      const h00 = hts[i + nu * j], h10 = hts[i + 1 + nu * j], h01 = hts[i + nu * (j + 1)], h11 = hts[i + 1 + nu * (j + 1)];
      return (h00 * (1 - a) + h10 * a) * (1 - b) + (h01 * (1 - a) + h11 * a) * b;
    },
  };
  return grid;
}
