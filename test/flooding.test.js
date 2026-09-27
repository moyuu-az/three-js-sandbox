import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../src/flooding.js';
import * as Lo from '../src/layout.js';
import { buildShipGrid, breachAt } from '../src/shipgrid.js';

// 10 × 10 × 10 の格子点（h = 0.1 → 1 m 立方）
function cube(h = 0.1, n = 10) {
  const a = [];
  for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) a.push((i + 0.5) * h, (j + 0.5) * h, (k + 0.5) * h);
  return Float32Array.from(a);
}
const up = [0, 1, 0];

test('水位: 立方体の部屋に半分入れると水面は高さの半分、空は -∞、満水は +∞', () => {
  const c = cube();
  assert.ok(Math.abs(F.waterLevel(c, 0.1, 0.5, up) - 0.5) < 1e-6);
  assert.ok(Math.abs(F.waterLevel(c, 0.1, 0.25, up) - 0.25) < 1e-6);
  assert.ok(Math.abs(F.waterLevel(c, 0.1, 0.123, up) - 0.123) < 1e-6, '層の途中は端数で補間');
  assert.equal(F.waterLevel(c, 0.1, 0, up), -Infinity);
  assert.equal(F.waterLevel(c, 0.1, 1.0, up), Infinity);
});

test('水位: 傾いた重力では、その向きに低い側から詰まる', () => {
  const c = cube();
  const s = Math.SQRT1_2, tilt = [s, s, 0];
  const lv = F.waterLevel(c, 0.1, 0.5, tilt);
  // 対称性から、半分入れた水面は立方体の中心を通る
  assert.ok(Math.abs(lv - (0.5 * s + 0.5 * s)) < 0.05, `${lv}`);
});

test('水位: 作業領域（scratch）が格子点数より短くても結果は同じ（扉を開けて部屋の格子点が増えた後）', () => {
  const c = cube();
  const ref = F.waterLevel(c, 0.1, 0.5, up);
  assert.equal(F.waterLevel(c, 0.1, 0.5, up, new Float32Array(990)), ref);
  assert.equal(F.waterLevel(c, 0.1, 0.5, up, new Float32Array(0)), ref);
});

const ctx = (over = {}) => ({ toWorld: (p) => p, sea: () => 0, up, level: -Infinity, ...over });
const hole = (y, area = 1) => ({ area, samples: [[0, y, 0]] });

test('流量: 海面下の開口・空の部屋では Q = Cd·A·√(2gh)', () => {
  const r = F.openingFlow(hole(-2, 0.5), ctx());
  assert.equal(r.mode, 'inflow');
  assert.ok(Math.abs(r.q - F.CD * 0.5 * Math.sqrt(2 * 9.81 * 2)) < 1e-9);
  assert.ok(Math.abs(r.speed - 0.98 * Math.sqrt(2 * 9.81 * 2)) < 1e-9);
});

test('流量: 海面より上の開口からは入らない（開放）', () => {
  assert.deepEqual(F.openingFlow(hole(0.5), ctx()), { q: 0, mode: 'free', speed: 0 });
});

test('流量: 船内の水位が外と同じか高ければ流入しない（閉じた扱い）', () => {
  assert.equal(F.openingFlow(hole(-2), ctx({ level: 0 })).mode, 'closed');
  assert.equal(F.openingFlow(hole(-2), ctx({ level: 0.3 })).q, 0);
});

test('流量: 船内の水位が上がると流入が減る', () => {
  const q0 = F.openingFlow(hole(-2), ctx()).q, q1 = F.openingFlow(hole(-2), ctx({ level: -1 })).q;
  assert.ok(q1 < q0 && q1 > 0);
  assert.ok(Math.abs(q1 / q0 - Math.sqrt(0.5)) < 1e-9, '水頭差が半分なら √(1/2) 倍');
});

test('流量: 波が来て一時的に海面下になると入る', () => {
  const o = hole(0.3);
  assert.equal(F.openingFlow(o, ctx({ sea: () => 0.8 })).mode, 'inflow');
  assert.equal(F.openingFlow(o, ctx({ sea: () => -0.2 })).mode, 'free');
});

test('粒子数: 流量 × 時間 ÷ 粒子の体積。端数は持ち越して合計が合う', () => {
  let carry = 0, total = 0;
  for (let i = 0; i < 600; i++) { const r = F.particlesFor(0.01, 1 / 60, 0.001, carry); carry = r.carry; total += r.count; }
  assert.equal(total, 100);
  assert.equal(F.particlesFor(-1, 1, 0.001).count, 0);
});

test('実艦: 喫水線下の破口の流量は、深さに見合った値になる', () => {
  const h = 0.5;
  const b = breachAt(3.5, 1.6, 7.5, 1.6, 1.2);
  const { openings } = buildShipGrid(h, { breaches: [b] });
  const o = openings.find((x) => x.kind === 'breach');
  // 艦を設計喫水 4.14 m で浮かべた状態（ワールド y = 船体 y − 4.14）
  const q = F.openingFlow(o, { toWorld: (p) => [p[0], p[1] - 4.14, p[2]], sea: () => 0, up, level: -Infinity }).q;
  const expect = F.CD * 1.92 * Math.sqrt(2 * 9.81 * 2.54); // 中心の深さ 2.54 m
  assert.ok(Math.abs(q / expect - 1) < 0.15, `q=${q} 目安=${expect}`);
  const nodes = F.roomNodes(buildShipGrid(h).grid, Lo.ROOMS.length);
  assert.equal(nodes.length, Lo.ROOMS.length);
  assert.ok(nodes.every((a) => a.length > 0));
});

// ---------- 浸水・満水の通知 ----------
test('通知: しきい値を超えたときに 1 回だけ。しきい値の前後で揺れても、下のしきい値を割るまで繰り返さない', () => {
  let st = [];
  const step = (fills) => { const r = F.fillAlerts(fills, st); st = r.notified; return r.events.map((e) => `${e.room}:${e.kind}`); };
  assert.deepEqual(step([0, 0]), []);
  assert.deepEqual(step([0.03, 0]), ['0:wet']);
  assert.deepEqual(step([0.96, 0]), ['0:full']);
  // 満水の前後で揺れる（再現: 船室 左3 が満水 を 4 回通知した）
  for (const f of [0.94, 0.96, 0.9, 0.97, 0.86, 0.95]) assert.deepEqual(step([f, 0]), [], `f=${f}`);
  // 十分下がってから（0.85 未満）もう一度満ちたら知らせる
  assert.deepEqual(step([0.8, 0]), []);
  assert.deepEqual(step([0.95, 0]), ['0:full']);
  // 浸水も同じ（0.01 未満に戻るまで繰り返さない）
  assert.deepEqual(step([0.95, 0.021]), ['1:wet']);
  for (const f of [0.019, 0.025, 0.011]) assert.deepEqual(step([0.95, f]), [], `f=${f}`);
  assert.deepEqual(step([0.95, 0.005]), []);
  assert.deepEqual(step([0.95, 0.03]), ['1:wet']);
});

test('通知: 最初から満水の部屋は浸水と満水を 1 回ずつ。NaN（容積 0 の部屋）は知らせない', () => {
  const r = F.fillAlerts([1, NaN]);
  assert.deepEqual(r.events.map((e) => `${e.room}:${e.kind}`), ['0:wet', '0:full']);
  assert.deepEqual(F.fillAlerts([1, NaN], r.notified).events, []);
});
