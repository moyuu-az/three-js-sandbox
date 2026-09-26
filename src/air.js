// 船内の空気: 部屋ごとの空気量を持ち、空気でつながった部屋どうしは同じ圧力にする（等温・ボイルの法則 p V = 一定）。
// 閉じ込められた空気は水に押されて縮み、圧力が上がって流入を押し返す（エアクッション）。開口部の水面より上の部分からは
// 空気が出入りする。外板の内外の圧力差が強度を超えたら破断させる（外向きの破裂・内向きの圧潰）。
// three を import しない純粋な計算なので node でテストできる。座標は船体座標（m）、圧力は絶対圧を気圧単位で持つ。
import * as V from './voxel.js';
import * as Lo from './layout.js';

export const P_ATM = 101325; // [Pa]
const RHO_W = 1025, G = 9.81;
const RHO_AIR = 1.2; // 1 気圧の空気の密度 [kg/m³]
const CD_AIR = 0.62;
const V_SONIC = 330; // 開口部を抜ける空気の速さの上限（チョーク）[m/s]
const P_MAX = 12; // 数値の上限 [atm]（水がほぼ満ちた部屋で体積 → 0 のとき）
const V_MIN = 0.02; // 空気の体積の下限 [m³]
export const headOf = (gaugePa) => gaugePa / (RHO_W * G); // ゲージ圧 → 水頭 [m]

const wet = (t) => t === V.NODE_FLUID || (t >= V.NODE_OPENING_IN && t < V.NODE_OPENING_OUT);

/**
 * 部屋どうしのつながり（開いた扉・ハッチ）。隣り合う 2 つの水が入れる格子点が別の部屋なら、その境目の点を記録する。
 * 格子を作り直す（扉の開閉・破口）たびに作る。戻り値: [{ a, b, pts: Float32Array(xyz…) }]
 */
export function roomLinks(grid, nRooms) {
  const [nx, ny, nz] = grid.dims;
  const map = new Map();
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const n = grid.index(i, j, k);
    const ra = grid.room[n];
    if (ra >= nRooms || !wet(grid.type[n])) continue;
    for (const [di, dj, dk] of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
      if (i + di >= nx || j + dj >= ny || k + dk >= nz) continue;
      const m = grid.index(i + di, j + dj, k + dk);
      const rb = grid.room[m];
      if (rb >= nRooms || rb === ra || !wet(grid.type[m])) continue;
      const key = Math.min(ra, rb) * 64 + Math.max(ra, rb);
      if (!map.has(key)) map.set(key, []);
      const p = grid.pos(i, j, k);
      map.get(key).push(p[0] + (di * grid.h) / 2, p[1] + (dj * grid.h) / 2, p[2] + (dk * grid.h) / 2);
    }
  }
  return [...map].map(([key, pts]) => ({ a: Math.floor(key / 64), b: key % 64, pts: Float32Array.from(pts) }));
}

const STRIDE = 7; // x, y, z, nx, ny, nz, 強度 [Pa]
/**
 * 外板の点（船外と接する、水が入れる格子点の面）と、その点の強度。
 * kindOf(x, y, z, normal, room) → { strength, closure }（closure: 閉じた開口の id。そこが破れたら開口が開く）
 * 戻り値: { data: Float32Array(STRIDE × n), room: Int32Array, closure: (string|null)[] }
 */
export function envelopePoints(grid, nRooms, kindOf) {
  const [nx, ny, nz] = grid.dims;
  const data = [], room = [], closure = [];
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const n = grid.index(i, j, k);
    const r = grid.room[n];
    if (r >= nRooms || grid.type[n] !== V.NODE_FLUID) continue;
    const p = grid.pos(i, j, k);
    for (const d of dirs) {
      if (grid.type[grid.index(i + d[0], j + d[1], k + d[2])] !== V.NODE_EXTERIOR) continue;
      const q = [p[0] + (d[0] * grid.h) / 2, p[1] + (d[1] * grid.h) / 2, p[2] + (d[2] * grid.h) / 2];
      const kd = kindOf(q[0], q[1], q[2], d, r);
      data.push(...q, ...d, kd.strength);
      room.push(r);
      closure.push(kd.closure ?? null);
    }
  }
  return { data: Float32Array.from(data), room: Int32Array.from(room), closure };
}

/**
 * 外板の点の強度（layout.STRENGTH × 場所ごとのばらつき ±15%）。閉じた開口（ハッチ蓋・扉・通風筒の蓋）の周りは最も弱く、
 * 破れたらその開口が開く。甲板室の部屋は甲板室の壁、上向きの面は上甲板、それ以外は外板。
 * closed: 閉じている layout.SEA_OPENINGS の要素。scale: 強度の倍率（UI）
 */
export function strengthOf(closed, scale = 1) {
  const S = Lo.STRENGTH;
  return (x, y, z, d, r) => {
    // 位置から決まる擬似乱数（同じ船なら毎回同じ場所が弱い）
    const jitter = 0.85 + 0.3 * (((Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453) % 1 + 1) % 1);
    for (const o of closed) {
      const q = [x - o.center[0], y - o.center[1], z - o.center[2]];
      const dot = (a) => a[0] * q[0] + a[1] * q[1] + a[2] * q[2];
      if (Math.abs(dot(o.u)) <= o.half[0] + 0.35 && Math.abs(dot(o.v)) <= o.half[1] + 0.35 && Math.abs(dot(o.normal)) <= 0.6) {
        return { strength: S.closure * scale * jitter, closure: o.id };
      }
    }
    const kind = Lo.ROOMS[r]?.comp === 'DH' ? 'house' : d[1] > 0.5 ? 'deck' : 'hull';
    return { strength: S[kind] * scale * jitter, closure: null };
  };
}

// 空気でつながった部屋のまとまり。つながりの点のどれかが両側の水面より上にあれば空気が通る
// levels: 部屋の水面（up 方向の座標、空は -∞・満水は +∞）。戻り値: 部屋ごとのまとまりの代表の番号
export function airGroups(nRooms, links, levels, up) {
  const parent = Array.from({ length: nRooms }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (const { a, b, pts } of links) {
    const lv = Math.max(levels[a], levels[b]);
    if (!(lv < Infinity)) continue;
    let open = false;
    for (let i = 0; i < pts.length && !open; i += 3) open = up[0] * pts[i] + up[1] * pts[i + 1] + up[2] * pts[i + 2] > lv;
    if (open) parent[find(a)] = find(b);
  }
  return parent.map((_, i) => find(i));
}

/** 空気の状態。amount = 1 気圧に換算した空気の体積 [m³]、pressure = 絶対圧 [atm] */
export function createAir(capacity) {
  return { amount: Float64Array.from(capacity), pressure: new Float64Array(capacity.length).fill(1) };
}

// 空気の体積（部屋の容積 − 水の体積）。満水の部屋には空気が無い（null）
export function airVolumes(capacity, water, levels) {
  return capacity.map((c, i) => (levels[i] === Infinity ? null : Math.max(V_MIN, c - water[i])));
}

/**
 * 同じまとまりの部屋の圧力をそろえる（空気量の合計を体積で割る）。満水の部屋は空気を失い、圧力はゲージ 0（水の圧力は
 * つながった水で決まる）。水に押されて体積が減った分だけ圧力が上がる（ボイルの法則）。
 * pMax [atm]: 空気を押し縮められる上限。水が空気を押せるのは入ってくる水の圧力（開口の最も深い点の水圧）までで、それを
 * 超えるなら空気のほうが水を押し返すか開口から泡で抜ける（どちらもここでは空気が抜けたことにする）。
 * 水量の見積もりの揺れで空気の体積が 0 近くになったときに、圧力が跳ね上がって偽の破断を起こさないための物理的な上限でもある
 */
export function equalize(air, groupOf, vAir, pMax = P_MAX) {
  const n = vAir.length, sumA = new Float64Array(n), sumV = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (vAir[i] === null) { air.amount[i] = 0; continue; }
    sumA[groupOf[i]] += air.amount[i];
    sumV[groupOf[i]] += vAir[i];
  }
  for (let i = 0; i < n; i++) {
    if (vAir[i] === null) { air.pressure[i] = 1; continue; }
    const g = groupOf[i];
    const p = Math.min(P_MAX, pMax, Math.max(0.05, sumA[g] / sumV[g]));
    air.pressure[i] = p;
    air.amount[i] = p * vAir[i];
  }
}

/**
 * 開口部を通る空気の出入り。vents: [{ room, samples: [{ area, depth }] }]（depth: 船外の水深 [m]、海面より上は 0。
 * 船内側が水面より上の点だけを渡す）。部屋の空気が外の水圧より高ければ出て（水中なら泡になる）、海面より上の開口では
 * 外気より低ければ入る。1 ステップで行き過ぎないよう、まとまりごとに外と釣り合う圧力で止める。
 * 戻り値: 開口ごとの流量 [m³/s、1 気圧換算、正 = 流出]
 */
export function exchange(air, groupOf, vAir, vents, dt) {
  const n = vAir.length;
  const flows = vents.map(() => 0);
  const out = new Float64Array(n), inn = new Float64Array(n), eqOut = new Float64Array(n).fill(Infinity);
  vents.forEach((v, k) => {
    if (vAir[v.room] === null) return;
    const g = groupOf[v.room], p = air.pressure[v.room];
    for (const s of v.samples) {
      const dp = (p - 1) * P_ATM - RHO_W * G * s.depth;
      if (dp > 0) {
        const q = CD_AIR * s.area * Math.min(V_SONIC, Math.sqrt((2 * dp) / (RHO_AIR * p))) * p;
        flows[k] += q; out[g] += q;
        eqOut[g] = Math.min(eqOut[g], 1 + (RHO_W * G * s.depth) / P_ATM);
      } else if (dp < 0 && s.depth <= 0) {
        const q = CD_AIR * s.area * Math.min(V_SONIC, Math.sqrt((-2 * dp) / RHO_AIR));
        flows[k] -= q; inn[g] += q;
      }
    }
  });
  // まとまりごとの行き過ぎの制限: 出るなら外と釣り合う圧力まで、入るなら 1 気圧まで
  const sumA = new Float64Array(n), sumV = new Float64Array(n);
  for (let i = 0; i < n; i++) if (vAir[i] !== null) { sumA[groupOf[i]] += air.amount[i]; sumV[groupOf[i]] += vAir[i]; }
  const scale = new Float64Array(n).fill(1), net = new Float64Array(n);
  for (let g = 0; g < n; g++) {
    const d = (out[g] - inn[g]) * dt;
    if (d > 0) { const room = Math.max(0, sumA[g] - eqOut[g] * sumV[g]); if (d > room) scale[g] = room / d; }
    else if (d < 0) { const room = Math.max(0, sumV[g] - sumA[g]); if (-d > room) scale[g] = room / -d; }
    net[g] = d * scale[g];
  }
  vents.forEach((v, k) => { if (vAir[v.room] !== null) flows[k] *= scale[groupOf[v.room]]; });
  // 流出入の分をまとまりの部屋に体積の比で配る（直後の equalize で圧力がそろう）
  for (let i = 0; i < n; i++) {
    if (vAir[i] === null) continue;
    const g = groupOf[i];
    if (sumV[g] > 0) air.amount[i] = Math.max(0, air.amount[i] - (net[g] * vAir[i]) / sumV[g]);
  }
  return flows;
}

/**
 * 外板で最も危ない点（圧力差 / 強度 が最大）。env: envelopePoints の結果。
 * ctx: { m: 船体 → ワールドの行列（列優先 16 要素）, seaY(room) → 部屋の近くの海面の高さ, up, levels, gauge: 部屋のゲージ圧 [Pa] }
 * 船内の圧力 = 空気のゲージ圧 + 水面より下なら水の圧力、船外 = 海面より下なら水の圧力。
 * 戻り値: { i, room, dp（正 = 外向き）, ratio } または null
 */
export function worstLoad(env, ctx) {
  const { data, room } = env, { m, up, levels, gauge } = ctx;
  const seaY = new Map();
  let best = null;
  for (let i = 0; i < room.length; i++) {
    const r = room[i], o = i * STRIDE;
    // 満水の部屋は空気が無く、中の水の圧力はつながった水（破口の先の海）で決まるので、外とほぼ釣り合っている
    if (levels[r] === Infinity || !Number.isFinite(gauge[r])) continue;
    const x = data[o], y = data[o + 1], z = data[o + 2];
    const yw = m[1] * x + m[5] * y + m[9] * z + m[13];
    if (!seaY.has(r)) seaY.set(r, ctx.seaY(r));
    const hOut = Math.max(0, seaY.get(r) - yw);
    const hIn = levels[r] === -Infinity ? 0 : Math.max(0, levels[r] - (up[0] * x + up[1] * y + up[2] * z));
    const dp = gauge[r] + RHO_W * G * (hIn - hOut);
    const ratio = Math.abs(dp) / data[o + 6];
    if (!best || ratio > best.ratio) best = { i, room: r, dp, ratio };
  }
  return best;
}

export const envelopePoint = (env, i) => {
  const o = i * STRIDE, d = env.data;
  return { p: [d[o], d[o + 1], d[o + 2]], n: [d[o + 3], d[o + 4], d[o + 5]], strength: d[o + 6], room: env.room[i], closure: env.closure[i] };
};
