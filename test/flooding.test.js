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

// ---------- 流出（艦内の水頭が外より高い開口からは水が出ていく） ----------
// 再現: 艦首の大破口で、噴き込んだ水が破口の上端より高く溜まり、区画の空気も +0.39 bar に縮んだまま、開口が「閉じた」扱いで固まった
test('流出: 艦内の水位が外の海面より OUT_MARGIN を超えて高い海面下の開口は流出（オリフィス式の量と速さで外へ）', () => {
  assert.equal(F.openingFlow(hole(-2), ctx({ level: F.OUT_MARGIN + 0.05 })).mode, 'outflow');
  // 内外の水頭差 1.5 m: Q = −Cd·A·√(2g·1.5)（負 = 流出。粒子は作らない）、噴流の速さ Cv·√(2g·1.5)。
  // 開放（自重で落ちるだけ）だと速さが艦内の水深（3.5 m）で決まり、波の中で水位が平均の海面より低めに釣り合った
  const r = F.openingFlow(hole(-2, 0.5), ctx({ level: 1.5 }));
  assert.ok(Math.abs(r.q + F.CD * 0.5 * Math.sqrt(2 * 9.81 * 1.5)) < 1e-9, `${r.q}`);
  assert.ok(Math.abs(r.speed - 0.98 * Math.sqrt(2 * 9.81 * 1.5)) < 1e-9, `${r.speed}`);
});

test('流出: 閉じ込められた空気の圧力が外の水圧を超えていれば、水面が開口より低くても開放', () => {
  // 水面は開口の上 0.5 m、空気 2 m 水頭: 艦内 2.5 m ＞ 外 2 m + 余裕
  assert.equal(F.openingFlow(hole(-2), ctx({ level: -1.5, airHead: 2 })).mode, 'outflow');
});

test('流出: 釣り合いの近く（差が OUT_MARGIN 以内）は閉じた扱いのまま（開放と閉鎖を行き来しない）', () => {
  assert.equal(F.openingFlow(hole(-2), ctx({ level: 0 })).mode, 'closed');
  assert.equal(F.openingFlow(hole(-2), ctx({ level: F.OUT_MARGIN - 0.05 })).mode, 'closed');
  assert.equal(F.openingFlow(hole(-2), ctx({ level: -1, airHead: 1 + F.OUT_MARGIN - 0.05 })).mode, 'closed');
});

test('流出: 満水の部屋（水位 +∞）の海面下の開口は開放しない（開けると流れ出と再流入を繰り返す）', () => {
  assert.equal(F.openingFlow(hole(-2), ctx({ level: Infinity })).mode, 'closed');
});

test('流出: 海面をまたぐ開口で、艦内の水が海面より上の部分に届いていれば開放（こぼれ出る）', () => {
  const o = { area: 1, samples: [[0, -0.5, 0], [0, 0.5, 0]] };
  assert.equal(F.openingFlow(o, ctx({ level: 0.2 })).mode, 'closed', '艦内の水が海面とほぼ同じ');
  assert.equal(F.openingFlow(o, ctx({ level: 0.9 })).mode, 'outflow', '艦内の水が海面より 0.9 m 高い');
});

test('流出: 海面より上の点だけで判定が決まるとき（波の谷）、艦内の水が届いていれば開放、届いていなければ閉じたまま', () => {
  // 海面下の点（x = 0）は波の山で外の水頭 1.2 m、艦内 1.2〜1.4 m（差 0〜0.2 m、釣り合いの近く）。海面より上の点（x = 10）は波の谷
  const o = { area: 1, samples: [[0, -0.5, 0], [10, 0.5, 0]] };
  const sea = (x) => (x > 5 ? -0.5 : 0.7);
  assert.equal(F.openingFlow(o, ctx({ level: 0.9, sea })).mode, 'outflow', '海面より上の点の上に艦内の水が 0.4 m');
  assert.equal(F.openingFlow(o, ctx({ level: 0.7, sea })).mode, 'closed', '海面より上の点の上の水は 0.2 m（OUT_MARGIN 以内）');
});

// 再現: 海面より上の点の判定が空気の圧力を見ていなかった。水を抜いて膨らんだ（負圧の）空気が水を吊り上げていても開放になり、
// GPU 流体は水を落とす → 空気がさらに負圧 → 流入、と開放と流入を行き来する
test('流出: 海面より上の点でも艦内の圧力は空気 + 水。空気が負圧で外気より低ければ開放しない', () => {
  const o = { area: 1, samples: [[0, -0.5, 0], [0, 0.5, 0]] };
  // 海面より上の点: 水 0.4 m + 空気 −0.7 m = −0.3 m（外気より低い）。海面下の点: 1.4 − 0.7 = 0.7 m、外 0.5 m（差 0.2 m）
  assert.equal(F.openingFlow(o, ctx({ level: 0.9, airHead: -0.7 })).mode, 'closed');
  // 空気が正圧なら、海面より上の点の水が OUT_MARGIN より浅くても押し出される（波の谷の点: 水 0.2 m + 空気 0.2 m）。
  // 海面下の点（波の山）は外 1.3 m、艦内 1.2 + 0.2 = 1.4 m で差 0.1 m（釣り合いの近く）なので、決めているのは海面より上の点
  const sea = (x) => (x > 5 ? -0.5 : 0.8);
  const o2 = { area: 1, samples: [[0, -0.5, 0], [10, 0.5, 0]] };
  assert.equal(F.openingFlow(o2, ctx({ level: 0.7, airHead: 0.2, sea })).mode, 'outflow');
});

test('流出: 海面より上の点が艦内の水面より上（空気の中）なら、空気の圧力が高くても水の開放の理由にならない（空気の出入りは air.js）', () => {
  // 海面より上の点（x = 10、波の谷）は水面 0.2 より上。空気 0.7 m。海面下の点（波の山）は外 1.3 m、艦内 0.7 + 0.7 = 1.4 m（差 0.1 m）
  const sea = (x) => (x > 5 ? -0.5 : 0.8);
  const o = { area: 1, samples: [[0, -0.5, 0], [10, 1.5, 0]] };
  assert.equal(F.openingFlow(o, ctx({ level: 0.2, airHead: 0.7, sea })).mode, 'closed');
  assert.equal(F.openingFlow(hole(1.5), ctx({ level: 0.2, airHead: 0.7 })).mode, 'free', '全体が海面より上の開口は従来どおり開放');
});

test('流出: 満水の部屋でも、海面より上に出た開口の点からは水がこぼれる（水頭が決まらないので速さは与えず開放）', () => {
  const o = { area: 1, samples: [[0, -0.5, 0], [0, 0.5, 0]] };
  const r = F.openingFlow(o, ctx({ level: Infinity }));
  assert.deepEqual(r, { q: 0, mode: 'free', speed: 0 }, '無限大の水頭で流出の速さを作らない');
});

test('流出: 一部の点で流入していれば流入を優先する（波の谷にかかった点から出る水と、深い点から入る水が同時にあるときは入れる）', () => {
  const o = { area: 1, samples: [[0, -5, 0], [10, -2.9, 0]] };
  const sea = (x) => (x > 5 ? -2.5 : 0); // x = 10 の点は波の谷（海面 −2.5 m、深さ 0.4 m）
  const r = F.openingFlow(o, ctx({ level: -1, sea }));
  assert.equal(r.mode, 'inflow');
  assert.ok(r.q > 0);
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
