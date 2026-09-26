import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../src/air.js';
import * as F from '../src/flooding.js';
import * as Lo from '../src/layout.js';
import { buildShipGrid } from '../src/shipgrid.js';

const h = 0.3;
const R = (name) => Lo.ROOMS.findIndex((r) => r.name === name);
const up = [0, 1, 0];
const RHO_G = 1025 * 9.81;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} ≠ ${b} (±${tol})`);
const allClosed = {
  doors: Object.fromEntries(Lo.DOORS.filter((d) => d.wt).map((d) => [d.id, false])),
  seaOpenings: Object.fromEntries(Lo.SEA_OPENINGS.map((o) => [o.id, false])),
};
const hasLink = (links, a, b) => links.some((l) => (l.a === R(a) && l.b === R(b)) || (l.a === R(b) && l.b === R(a)));

// ---------- 部屋のつながり ----------
test('つながり: 水密扉 D1 が開いていれば機関室と通路はつながり、閉じればつながらない', () => {
  const open = A.roomLinks(buildShipGrid(h).grid, Lo.ROOMS.length);
  assert.ok(hasLink(open, '機関室', '通路'));
  const closed = A.roomLinks(buildShipGrid(h, { doors: { D1: false } }).grid, Lo.ROOMS.length);
  assert.ok(!hasLink(closed, '機関室', '通路'));
  // 水密隔壁をまたぐつながりは無い（第1船倉と船首倉庫）
  assert.ok(!hasLink(open, '第1船倉', '船首倉庫'));
});

test('つながり: つながりの点は扉の範囲にあり、部屋の組は a < b で重複しない', () => {
  const links = A.roomLinks(buildShipGrid(h).grid, Lo.ROOMS.length);
  const keys = links.map((l) => `${l.a}-${l.b}`);
  assert.equal(new Set(keys).size, keys.length);
  for (const l of links) assert.ok(l.a < l.b && l.pts.length > 0 && l.pts.length % 3 === 0);
  const d1 = Lo.DOORS.find((d) => d.id === 'D1').box;
  const l = links.find((x) => (x.a === R('機関室') && x.b === R('通路')) || (x.b === R('機関室') && x.a === R('通路')));
  for (let i = 0; i < l.pts.length; i += 3) {
    assert.ok(l.pts[i] >= d1.x[0] - h && l.pts[i] <= d1.x[1] + h, `x=${l.pts[i]}`);
    assert.ok(l.pts[i + 2] >= d1.z[0] - h && l.pts[i + 2] <= d1.z[1] + h, `z=${l.pts[i + 2]}`);
  }
});

// ---------- 空気のまとまり ----------
test('まとまり: 扉の上端より水面が高いと空気は通らない（別々のまとまりになる）', () => {
  const links = [{ a: 0, b: 1, pts: Float32Array.from([0, 1, 0, 0, 2, 0]) }]; // 扉は高さ 1〜2 m
  assert.deepEqual(A.airGroups(3, links, [-Infinity, -Infinity, -Infinity], up), [1, 1, 2]);
  assert.deepEqual(A.airGroups(3, links, [1.5, 0, -Infinity], up), [1, 1, 2], '片側だけ扉の途中まで: 上半分が空気でつながる');
  assert.deepEqual(A.airGroups(3, links, [2.5, 0, -Infinity], up), [0, 1, 2], '片側の水面が扉の上端より上: つながらない');
  assert.deepEqual(A.airGroups(3, links, [Infinity, 0, -Infinity], up), [0, 1, 2], '満水の部屋とはつながらない');
});

test('まとまり: 傾くと「上」が変わり、扉の高い側で空気が通る', () => {
  const links = [{ a: 0, b: 1, pts: Float32Array.from([-1, 1, 0, 1, 1, 0]) }];
  const s = Math.SQRT1_2;
  assert.deepEqual(A.airGroups(2, links, [1.2, 1.2], [0, 1, 0]), [0, 1]);
  assert.deepEqual(A.airGroups(2, links, [1.2, 1.2], [s, s, 0]), [1, 1], '傾いた上向きでは x=1 の点が水面より上');
});

// ---------- ボイルの法則 ----------
test('ボイル: 閉じた部屋に水が半分入ると空気は 2 気圧、つながった部屋は同じ圧力になり空気量は保存される', () => {
  const air = A.createAir([100, 50]);
  A.equalize(air, [0, 1], A.airVolumes([100, 50], [50, 0], [0, -Infinity]));
  near(air.pressure[0], 2, 1e-12);
  near(air.pressure[1], 1, 1e-12);
  // 2 部屋がつながる: 空気 150 m³（1 気圧換算）を体積 50 + 50 に詰めて 1.5 気圧
  A.equalize(air, [1, 1], A.airVolumes([100, 50], [50, 0], [0, -Infinity]));
  near(air.pressure[0], 1.5, 1e-12);
  near(air.pressure[1], 1.5, 1e-12);
  near(air.amount[0] + air.amount[1], 150, 1e-9);
});

test('ボイル: 満水の部屋は空気を持たず、ゲージ圧 0（圧力は水で決まる）', () => {
  const air = A.createAir([10, 10]);
  const v = A.airVolumes([10, 10], [10, 3], [Infinity, 0]);
  assert.equal(v[0], null);
  A.equalize(air, [0, 1], v);
  assert.equal(air.amount[0], 0);
  assert.equal(air.pressure[0], 1);
});

test('ボイル: 入ってくる水の圧力（pMax）より高くは縮まず、超えた分の空気は抜ける', () => {
  const air = A.createAir([10]);
  // 水 9.5 m³ → 体積 0.5 m³ で 20 気圧になるはずのところ、開口の水圧が 1.3 気圧までなら 1.3 気圧で止まる
  A.equalize(air, [0], A.airVolumes([10], [9.5], [3]), 1.3);
  near(air.pressure[0], 1.3, 1e-12);
  near(air.amount[0], 1.3 * 0.5, 1e-12, '空気量も上限に合わせて減る（抜けた）');
});

test('ボイル: 満水で空気を失った部屋の水位が見積もりの揺れで少し下がっても、真空（−1 bar）にしない', () => {
  const air = A.createAir([10]);
  A.equalize(air, [0], A.airVolumes([10], [10], [Infinity])); // 満水 → 空気 0
  assert.equal(air.amount[0], 0);
  A.equalize(air, [0], A.airVolumes([10], [9.97], [4.9])); // 0.03 m³ の空き
  near(air.pressure[0], 1, 1e-12, 'ゲージ 0');
  assert.ok(air.amount[0] > 0);
});

test('ボイル: 満水の手前で空気がほとんど抜けた部屋（空気 0.026 m³）の水位が揺れて 0.05 m³ 空いても、負圧にしない', () => {
  const air = A.createAir([10]);
  air.amount[0] = 0.026;
  A.equalize(air, [0], A.airVolumes([10], [9.95], [4.9]));
  near(air.pressure[0], 1, 1e-12, '小さなすき間は 1 気圧より下げない（揺れで吸い込みを作らない）');
  // 大きな空気の塊が膨らんだ（水が抜けた）ときは 1 気圧より下がりうる
  const big = A.createAir([10]);
  big.amount[0] = 4;
  A.equalize(big, [0], A.airVolumes([10], [5], [2.5]));
  near(big.pressure[0], 0.8, 1e-12);
});

test('ボイル: 水で空気の体積が 0 に近づいても圧力は上限で止まり、NaN にならない', () => {
  const air = A.createAir([10]);
  A.equalize(air, [0], A.airVolumes([10], [10 - 1e-9], [5]));
  assert.ok(Number.isFinite(air.pressure[0]) && air.pressure[0] <= 12);
});

// ---------- 空気の出入り ----------
const vent = (room, area, depth) => ({ room, samples: [{ area, depth }] });

test('出入り: 海面より上の開口がある部屋の空気は、1 気圧まで抜けて行き過ぎない（大きな dt でも）', () => {
  const air = A.createAir([100]);
  air.amount[0] = 150; // 1.5 気圧
  const v = A.airVolumes([100], [0], [-Infinity]);
  A.equalize(air, [0], v);
  for (let i = 0; i < 20; i++) { A.exchange(air, [0], v, [vent(0, 1, 0)], 0.5); A.equalize(air, [0], v); }
  near(air.pressure[0], 1, 1e-9);
  const f = A.exchange(air, [0], v, [vent(0, 1, 0)], 0.5);
  near(f[0], 0, 1e-9, '釣り合えば流れない');
});

test('出入り: 流量は Cd·A·√(2Δp/ρ)（1 気圧換算）で、音速で頭打ちになる', () => {
  const air = A.createAir([1e6]);
  air.amount[0] = 1e6 * 1.01;
  const v = A.airVolumes([1e6], [0], [-Infinity]);
  A.equalize(air, [0], v);
  const f = A.exchange(air, [0], v, [vent(0, 0.1, 0)], 1e-3);
  const dp = 0.01 * A.P_ATM;
  near(f[0], 0.62 * 0.1 * Math.sqrt((2 * dp) / (1.2 * 1.01)) * 1.01, 1e-6);
  air.amount[0] = 1e6 * 5; A.equalize(air, [0], v);
  near(A.exchange(air, [0], v, [vent(0, 0.1, 0)], 1e-3)[0], 0.62 * 0.1 * 330 * 5, 1e-6);
});

test('出入り: 水中の開口からは、中の空気が外の水圧を超えた分だけ泡になって抜け、外の水圧で止まる', () => {
  const air = A.createAir([100]);
  air.amount[0] = 200; // 2 気圧
  const v = A.airVolumes([100], [0], [-Infinity]);
  A.equalize(air, [0], v);
  const depth = 3;
  for (let i = 0; i < 50; i++) { A.exchange(air, [0], v, [vent(0, 1, depth)], 0.2); A.equalize(air, [0], v); }
  near(air.pressure[0], 1 + (RHO_G * depth) / A.P_ATM, 1e-9);
});

test('出入り: 水中の開口から空気は吸い込まない（外が水なら入るのは水）、海面より上なら負圧で吸い込む', () => {
  const air = A.createAir([100]);
  air.amount[0] = 80;
  const v = A.airVolumes([100], [0], [-Infinity]);
  A.equalize(air, [0], v);
  assert.equal(A.exchange(air, [0], v, [vent(0, 1, 2)], 0.1)[0], 0);
  assert.ok(A.exchange(air, [0], v, [vent(0, 1, 0)], 0.1)[0] < 0);
  A.equalize(air, [0], v);
  for (let i = 0; i < 50; i++) { A.exchange(air, [0], v, [vent(0, 1, 0)], 0.5); A.equalize(air, [0], v); }
  near(air.pressure[0], 1, 1e-9, '1 気圧まで戻り、行き過ぎない');
});

test('出入り: 開口の無い部屋でも、同じまとまりの部屋の開口から抜ける', () => {
  const air = A.createAir([50, 50]);
  air.amount[0] = 100; air.amount[1] = 100;
  const v = A.airVolumes([50, 50], [0, 0], [-Infinity, -Infinity]);
  for (let i = 0; i < 30; i++) { A.equalize(air, [1, 1], v); A.exchange(air, [1, 1], v, [vent(1, 1, 0)], 0.5); }
  A.equalize(air, [1, 1], v);
  near(air.pressure[0], 1, 1e-9);
  near(air.pressure[1], 1, 1e-9);
});

// ---------- 水の流入と空気の釣り合い（エアクッション） ----------
test('エアクッション: 天井のある閉じた部屋の水中の穴からは、空気が縮んで外の水圧と釣り合うところまでしか入らない', () => {
  // 1 m × 1 m × 10 m（高さ）の箱。底（y = 0）に 0.01 m² の穴、海面は y = 20（穴の深さ 20 m）
  const H = 10, cap = 10, depth = 20;
  const opening = { area: 0.01, samples: [[0, 0.05, 0]] };
  const air = A.createAir([cap]);
  let water = 0;
  const dt = 0.05;
  for (let i = 0; i < 40000; i++) {
    const level = water / 1; // 断面積 1 m²
    const v = A.airVolumes([cap], [water], [water > 0 ? level : -Infinity]);
    A.equalize(air, [0], v);
    const airHead = A.headOf((air.pressure[0] - 1) * A.P_ATM);
    const f = F.openingFlow(opening, { toWorld: (p) => p, sea: () => depth, up, level: water > 0 ? level : -Infinity, airHead });
    water = Math.min(H, water + f.q * dt);
  }
  // 釣り合い: p = 1 + ρg(20 − x)/Pa、p (10 − x) = 10 （x = 水位）
  let lo = 0, hi = H;
  for (let i = 0; i < 60; i++) { const x = (lo + hi) / 2; const p = 1 + (RHO_G * (depth - x)) / A.P_ATM; if (p * (H - x) > H) lo = x; else hi = x; }
  near(water, lo, 0.02, 'ボイルの法則の釣り合いの水位');
  assert.ok(water < 7, `満水にはならない: ${water}`);
});

test('流量: 空気の水頭は流入を押し返し、外の水頭と等しければ止まる。負圧なら増える', () => {
  const o = { area: 1, samples: [[0, -2, 0]] };
  const ctx = (airHead) => ({ toWorld: (p) => p, sea: () => 0, up, level: -Infinity, airHead });
  const q0 = F.openingFlow(o, ctx(0)).q;
  near(F.openingFlow(o, ctx(1)).q / q0, Math.sqrt(0.5), 1e-9);
  assert.equal(F.openingFlow(o, ctx(2)).mode, 'closed');
  assert.ok(F.openingFlow(o, ctx(-1)).q > q0);
  // 海面より上の開口: 負圧でも水は入らない（入るのは空気）
  assert.equal(F.openingFlow({ area: 1, samples: [[0, 1, 0]] }, ctx(-3)).q, 0);
});

// ---------- 外板の点と強度 ----------
test('外板: 実船の外板の点は船外に接し、上甲板は上向き、甲板室は壁の強度、閉じたハッチの周りは最も弱い', () => {
  const closed = Lo.SEA_OPENINGS.filter((o) => o.id === 'o1');
  const { grid } = buildShipGrid(h, { seaOpenings: { o1: false } });
  const env = A.envelopePoints(grid, Lo.ROOMS.length, A.strengthOf(closed));
  const n = env.room.length;
  assert.ok(n > 1000, `${n}`);
  const pts = Array.from({ length: n }, (_, i) => A.envelopePoint(env, i));
  for (const p of pts) near(Math.hypot(...p.n), 1, 1e-6);
  const S = Lo.STRENGTH;
  const inRange = (p, base) => p.strength >= base * 0.85 - 1 && p.strength <= base * 1.15 + 1;
  const hold1 = pts.filter((p) => p.room === R('第1船倉'));
  assert.ok(hold1.some((p) => p.n[1] === 1 && inRange(p, S.deck)), '第1船倉の天井は上甲板');
  assert.ok(hold1.some((p) => Math.abs(p.n[0]) === 1 && inRange(p, S.hull)), '第1船倉の側面は外板');
  assert.ok(pts.filter((p) => Lo.ROOMS[p.room].comp === 'DH').every((p) => inRange(p, S.house)), '甲板室');
  const hatch = pts.filter((p) => p.closure === 'o1');
  assert.ok(hatch.length > 0 && hatch.every((p) => inRange(p, S.closure) && p.room === R('船首倉庫')), '船首倉庫ハッチ');
  // 開いているハッチは船外とつながる開口なので弱点にならない
  const envOpen = A.envelopePoints(buildShipGrid(h).grid, Lo.ROOMS.length, A.strengthOf([]));
  assert.ok(envOpen.closure.every((c) => c === null));
});

test('外板の荷重: 深く沈んだ密閉の空の部屋は内向き、閉じ込めた空気が海面より上の外板を外向きに押す', () => {
  // 2 点だけの外板: 部屋 0 の底（y = 0）と天井（y = 5）。強度 100 kPa
  const env = { data: Float32Array.from([0, 0, 0, 0, -1, 0, 100e3, 0, 5, 0, 0, 1, 0, 100e3]), room: Int32Array.from([0, 0]), closure: [null, null] };
  const m = (ty) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, ty, 0, 1];
  // 空（1 気圧）のまま海面下 20 m（底）: 内向き 20 m の水頭
  let w = A.worstLoad(env, { m: m(-20), seaY: () => 0, up, levels: [-Infinity], gauge: [0] });
  assert.equal(w.i, 0);
  near(w.dp, -RHO_G * 20, 1e-6);
  near(w.ratio, (RHO_G * 20) / 100e3, 1e-9);
  // 空気 0.5 bar のまま天井が海面より上: 天井が外向き 0.5 bar
  w = A.worstLoad(env, { m: m(-3), seaY: () => 0, up, levels: [-Infinity], gauge: [0.5e5] });
  assert.equal(w.i, 1);
  near(w.dp, 0.5e5, 1e-6);
  // 水が入って外と釣り合っていれば、水面より下の外板にはほとんど力がかからない
  w = A.worstLoad(env, { m: m(-10), seaY: () => 0, up, levels: [4], gauge: [RHO_G * 6] });
  near(w.dp, RHO_G * 6 - RHO_G * 5, 1e-6, '天井: 空気 6 m 水頭 − 外 5 m');
  // 満水の部屋（水位 +∞）は除く。水頭が無限大になって必ず「破れる」判定にならないこと
  assert.equal(A.worstLoad(env, { m: m(-10), seaY: () => 0, up, levels: [Infinity], gauge: [0] }), null);
});

// ---------- 境界値 ----------
test('出入り: dt = 0（一時停止）では空気量は変わらない', () => {
  const air = A.createAir([100]);
  air.amount[0] = 150;
  const v = A.airVolumes([100], [0], [-Infinity]);
  A.equalize(air, [0], v);
  const before = air.amount[0];
  A.exchange(air, [0], v, [vent(0, 1, 0)], 0);
  assert.equal(air.amount[0], before);
});

test('出入り: 満水の部屋の開口は空気を通さず、NaN にならない', () => {
  const air = A.createAir([10, 10]);
  const v = A.airVolumes([10, 10], [10, 0], [Infinity, -Infinity]);
  A.equalize(air, [0, 1], v);
  const f = A.exchange(air, [0, 1], v, [vent(0, 1, 0)], 0.5);
  assert.deepEqual(f, [0]);
  A.equalize(air, [0, 1], v);
  assert.ok([...air.amount, ...air.pressure].every(Number.isFinite));
});

test('外板の種類: 甲板室の部屋は甲板室の壁、上向きの面は上甲板、それ以外は外板（破断の通知と強度で同じ判定）', () => {
  const house = Lo.ROOMS.findIndex((r) => r.comp === 'DH');
  assert.equal(A.surfaceKind(house, [0, 1, 0]), 'house');
  assert.equal(A.surfaceKind(R('第1船倉'), [0, 1, 0]), 'deck');
  assert.equal(A.surfaceKind(R('第1船倉'), [1, 0, 0]), 'hull');
  assert.equal(A.surfaceKind(R('第1船倉'), [0, -1, 0]), 'hull');
});
