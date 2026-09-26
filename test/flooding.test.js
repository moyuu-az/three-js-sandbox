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

test('実船: 喫水線下の破口の流量は、深さに見合った値になる', () => {
  const h = 0.3;
  const b = breachAt(3.5, 1.6, 7.5, 1.6, 1.2);
  const { openings } = buildShipGrid(h, { breaches: [b] });
  const o = openings.find((x) => x.kind === 'breach');
  // 船を喫水 2.6 m で浮かべた状態（ワールド y = 船体 y − 2.6）
  const q = F.openingFlow(o, { toWorld: (p) => [p[0], p[1] - 2.6, p[2]], sea: () => 0, up, level: -Infinity }).q;
  const expect = F.CD * 1.92 * Math.sqrt(2 * 9.81 * 1.0); // 中心の深さ 1.0 m
  assert.ok(Math.abs(q / expect - 1) < 0.15, `q=${q} 目安=${expect}`);
  const nodes = F.roomNodes(buildShipGrid(h).grid, Lo.ROOMS.length);
  assert.equal(nodes.length, Lo.ROOMS.length);
  assert.ok(nodes.every((a) => a.length > 0));
});
