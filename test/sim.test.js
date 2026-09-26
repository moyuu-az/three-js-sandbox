import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim, SEABED_Y, DESIGN_DRAFT, SHIP_MASS, ENVELOPE_VOLUME, RHO } from '../src/sim.js';
import * as MP from '../src/massprops.js';
import * as W from '../src/waves.js';
import * as Lo from '../src/layout.js';
import * as H from '../src/hull.js';

const run = (sim, sec) => { for (let i = 0; i < sec * 60; i++) sim.step(); };
// 部屋 name を水位 level（船体座標 y）まで満たしたときの水の質量特性（格子で数値積分）
function roomWater(names, level = Infinity, dx = 0.25) {
  let m = 0; const s1 = [0, 0, 0], s2 = [0, 0, 0, 0, 0, 0];
  const rooms = names.map((n) => Lo.ROOMS.find((r) => r.name === n));
  for (let x = -H.B / 2; x < H.B / 2; x += dx) for (let y = 0; y < Lo.HOUSE.top; y += dx) for (let z = H.Z_MIN; z < H.Z_MAX; z += dx) {
    const [cx, cy, cz] = [x + dx / 2, y + dx / 2, z + dx / 2];
    if (cy > level) continue;
    if (!(H.inside(cx, cy, cz) || Lo.inHouse(cx, cy, cz))) continue;
    if (!rooms.some((r) => Lo.inBox(r.box, cx, cy, cz))) continue;
    const dm = RHO * dx ** 3;
    m += dm; s1[0] += dm * cx; s1[1] += dm * cy; s1[2] += dm * cz;
    s2[0] += dm * cx * cx; s2[1] += dm * cy * cy; s2[2] += dm * cz * cz; s2[3] += dm * cx * cy; s2[4] += dm * cy * cz; s2[5] += dm * cz * cx;
  }
  return MP.fromMoments(m, s1, s2);
}

test('質量特性: 合成は平行軸の定理どおり、固有値分解で元の行列に戻る', () => {
  const a = { mass: 2, com: [1, 0, 0], inertia: [1, 2, 3, 0, 0, 0] };
  const b = { mass: 2, com: [-1, 0, 0], inertia: [1, 2, 3, 0, 0, 0] };
  const c = MP.combine(a, b);
  assert.deepEqual(c.com, [0, 0, 0]);
  assert.deepEqual(c.inertia, [2, 4 + 4, 6 + 4, 0, 0, 0]);
  const I = [5, 4, 3, 0.7, -0.4, 0.2];
  const { values: l, vectors: v } = MP.eigenSym(I);
  const M = [[I[0], I[3], I[5]], [I[3], I[1], I[4]], [I[5], I[4], I[2]]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const r = l.reduce((s, lk, k) => s + v[i][k] * lk * v[j][k], 0);
    assert.ok(Math.abs(r - M[i][j]) < 1e-9, `${i}${j}`);
  }
  const q = MP.matToQuat(v);
  assert.ok(Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1) < 1e-12);
});

test('質量特性: 点群のモーメントから重心まわりの慣性', () => {
  // 質量 1 の点を (±1, 0, 0) に置く → y・z 軸まわりの慣性 2、x 軸まわり 0
  const w = MP.fromMoments(2, [0, 0, 0], [2, 0, 0, 0, 0, 0]);
  assert.deepEqual(w.inertia, [0, 2, 2, -0, -0, -0]);
});

test('船型: 外殻の体積は予備浮力を持ち、設計喫水の排水量が船の重さ', () => {
  assert.ok(ENVELOPE_VOLUME * RHO > SHIP_MASS * 1.8, `外殻 ${ENVELOPE_VOLUME} m³`);
  assert.ok(SHIP_MASS > 300e3 && SHIP_MASS < 500e3, `${SHIP_MASS}`);
});

test('静水: 無傷なら設計喫水で水平に浮き続ける', async () => {
  const sim = await createSim();
  run(sim, 30);
  const s = sim.state();
  assert.ok(Math.abs(s.draft - DESIGN_DRAFT) < 0.05, `喫水 ${s.draft}`);
  assert.ok(Math.abs(s.pitchDeg) < 0.3 && Math.abs(s.rollDeg) < 0.3, `${s.pitchDeg} ${s.rollDeg}`);
});

test('復原性: 横に傾けても元に戻る（GM が正）', async () => {
  const sim = await createSim();
  run(sim, 3);
  sim.body.applyTorqueImpulse({ x: 0, y: 0, z: 2.2e6 }, true);
  run(sim, 1.5);
  assert.ok(Math.abs(sim.state().rollDeg) > 4, `傾いた ${sim.state().rollDeg}`);
  run(sim, 40);
  assert.ok(Math.abs(sim.state().rollDeg) < 0.5, `戻った ${sim.state().rollDeg}`);
});

test('浸水: 第1船倉が満水なら船首が沈むが、浮き続ける（1 区画浸水に耐える）', async () => {
  const sim = await createSim();
  run(sim, 2);
  sim.setWater(roomWater(['第1船倉'], 3.4)); // 外の喫水程度まで
  run(sim, 40);
  const s = sim.state();
  assert.ok(s.pitchDeg < -0.8, `船首トリム ${s.pitchDeg}`);
  assert.ok(s.submerged < 0.9 && s.y > -8, `浮いている y=${s.y}`);
});

test('浸水: 片舷に偏った水で、その舷に傾く', async () => {
  const sim = await createSim();
  run(sim, 2);
  sim.setWater(roomWater(['船室 左1', '船室 左2', '船室 左3']));
  run(sim, 30);
  assert.ok(sim.state().rollDeg < -1, `左舷（+x）が下がる roll=${sim.state().rollDeg}`);
});

test('沈没: 船内がほぼ満水なら沈んで海底に着き、数値が発散しない', async () => {
  const sim = await createSim();
  run(sim, 2);
  sim.setWater(roomWater(Lo.ROOMS.map((r) => r.name)));
  run(sim, 120);
  const s = sim.state();
  assert.ok(s.y < SEABED_Y + 6, `海底付近 y=${s.y}`);
  assert.ok(Number.isFinite(s.pitchDeg) && Number.isFinite(s.rollDeg));
});

test('波: 波の中では上下に揺れ、発散しない', async () => {
  const sim = await createSim({ waves: W.makeWaves(0.9, 5.5) });
  run(sim, 5);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 60 * 20; i++) { sim.step(); const y = sim.state().y; lo = Math.min(lo, y); hi = Math.max(hi, y); }
  assert.ok(hi - lo > 0.05 && hi - lo < 2, `上下揺れ ${hi - lo}`);
  assert.ok(Math.abs(sim.state().rollDeg) < 15);
});

test('流体への見かけの重力: 静止時は船体座標で真下 g、傾くと向きが変わる', async () => {
  const sim = await createSim();
  run(sim, 5);
  const f = sim.fluidFrame();
  assert.ok(Math.abs(f.gravity.y + 9.81) < 0.1 && Math.abs(f.gravity.x) < 0.1, `${f.gravity.toArray()}`);
  sim.body.setRotation({ x: 0, y: 0, z: Math.sin(0.1), w: Math.cos(0.1) }, true); // 約 11.5° 傾ける
  sim.step(); sim.step();
  const g = sim.fluidFrame().gravity;
  assert.ok(Math.abs(g.x) > 1, `船体座標で横向き成分 ${g.toArray()}`);
});
