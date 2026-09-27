import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim, SEABED_Y, DESIGN_DRAFT, SHIP_MASS, ENVELOPE_VOLUME, RHO, SHIP_COM, GM } from '../src/sim.js';
import * as MP from '../src/massprops.js';
import * as W from '../src/waves.js';
import * as Lo from '../src/layout.js';
import * as H from '../src/hull.js';

const run = (sim, sec) => { for (let i = 0; i < sec * 60; i++) sim.step(); };
// 部屋 name を水位 level（船体座標 y）まで満たしたときの水の質量特性（格子で数値積分）。side = 1 なら左舷（+x）の半分だけ
function roomWater(names, level = Infinity, { dx = 0.4, side = 0 } = {}) {
  let m = 0; const s1 = [0, 0, 0], s2 = [0, 0, 0, 0, 0, 0];
  const rooms = names.map((n) => Lo.ROOMS.find((r) => r.name === n));
  for (let x = -H.B / 2; x < H.B / 2; x += dx) for (let y = 0; y < H.Y_MAX; y += dx) for (let z = H.Z_MIN; z < H.Z_MAX; z += dx) {
    const [cx, cy, cz] = [x + dx / 2, y + dx / 2, z + dx / 2];
    if (cy > level || cx * side < 0) continue;
    if (!H.inside(cx, cy, cz)) continue;
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

test('艦型: 外殻の体積は予備浮力を持ち、設計喫水の排水量（公試排水量 3,048 t の ±4%）が艦の重さ', () => {
  assert.ok(ENVELOPE_VOLUME * RHO > SHIP_MASS * 2, `外殻 ${ENVELOPE_VOLUME} m³`);
  assert.ok(Math.abs(SHIP_MASS / 3048e3 - 1) < 0.04, `${SHIP_MASS}`);
});

test('艦型: 重心の高さ KG = KM − GM（駆逐艦の典型 4〜5 m）、前後は浮心の位置', () => {
  const cells = H.buildCells(0.25);
  const d = H.displacement(cells, 0.25, DESIGN_DRAFT);
  const km = d.kb + H.waterplaneInertia(DESIGN_DRAFT) / d.v;
  assert.ok(Math.abs(SHIP_COM[1] - (km - GM)) < 0.08, `KG ${SHIP_COM[1]} vs KM − GM ${km - GM}`);
  assert.ok(SHIP_COM[1] > 4 && SHIP_COM[1] < 5, `KG ${SHIP_COM[1]}`);
  assert.ok(Math.abs(SHIP_COM[2] - d.lcb) < 0.3, `LCG ${SHIP_COM[2]} LCB ${d.lcb}`);
});

test('水線面の二次モーメント: 幅 b・長さ l の箱なら l b³ / 12', () => {
  // 船体中央の平行部の 1 m 分（幅 11.2 m）を数値積分と比べる代わりに、全長の積分が中央部の値を上限に持つことを確かめる
  const I = H.waterplaneInertia(DESIGN_DRAFT);
  const box = (H.L * H.B ** 3) / 12;
  assert.ok(I > 0.4 * box && I < box, `I_T ${I} / 箱 ${box}`);
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
  sim.body.applyTorqueImpulse({ x: 0, y: 0, z: 4.5e7 }, true);
  run(sim, 1.5);
  assert.ok(Math.abs(sim.state().rollDeg) > 4, `傾いた ${sim.state().rollDeg}`);
  run(sim, 40);
  assert.ok(Math.abs(sim.state().rollDeg) < 0.5, `戻った ${sim.state().rollDeg}`);
});

test('浸水: 隣り合う 2 つの缶室が外の喫水まで浸水しても、艦首が沈むが浮き続ける（2 区画浸水に耐える）', async () => {
  const sim = await createSim();
  run(sim, 2);
  sim.setWater(roomWater(['第1缶室', '第2缶室'], DESIGN_DRAFT + 0.6)); // 沈下した後の外の喫水程度まで
  run(sim, 40);
  const s = sim.state();
  assert.ok(s.pitchDeg < -0.3, `艦首トリム ${s.pitchDeg}`);
  assert.ok(s.submerged < 0.75 && s.y > -DESIGN_DRAFT - 2, `浮いている y=${s.y} submerged=${s.submerged}`);
});

test('浸水: 機関区画（缶室 3・機械室 2）が全部満水でも、前後の区画の浮力で沈まない', async () => {
  const sim = await createSim();
  run(sim, 2);
  sim.setWater(roomWater(['第1缶室', '第2缶室', '第3缶室', '前部機械室', '後部機械室'], DESIGN_DRAFT + 1.2));
  run(sim, 60);
  const s = sim.state();
  assert.ok(s.submerged < 0.95 && s.y > -H.D, `浮いている y=${s.y} submerged=${s.submerged}`);
});

test('浸水: 片舷に偏った水で、その舷に傾く', async () => {
  const sim = await createSim();
  run(sim, 2);
  sim.setWater(roomWater(['後部兵員室 1', '後部兵員室 2', '士官室'], Infinity, { side: 1 }));
  run(sim, 30);
  assert.ok(sim.state().rollDeg < -1, `左舷（+x）が下がる roll=${sim.state().rollDeg}`);
});

test('沈没: 船内がほぼ満水なら沈んで海底に着き、数値が発散しない', async () => {
  const sim = await createSim();
  run(sim, 2);
  sim.setWater(roomWater(Lo.ROOMS.map((r) => r.name)));
  run(sim, 120);
  const s = sim.state();
  assert.ok(s.y < SEABED_Y + 15, `海底付近 y=${s.y}`);
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

test('浸水: 1 回ごとの増分が閾値より小さくても、積み重なった水の質量は剛体に反映される', async () => {
  const sim = await createSim();
  // 毎フレーム 17 kg（約 1 m³/min。閾値 = 総質量の 0.1% ≈ 3 t より小さい）ずつ増える遅い浸水
  for (let i = 1; i <= 600; i++) sim.setWater({ mass: 17 * i, com: [0, 2.5, 7], inertia: [0, 0, 0, 0, 0, 0] });
  const applied = sim.state().totalMass - SHIP_MASS;
  assert.ok(Math.abs(applied - 17 * 600) <= SHIP_MASS * 1e-3, `反映された水 ${applied} kg / 受け取った水 ${17 * 600} kg`);
  assert.ok(Math.abs(sim.body.mass() - sim.state().totalMass) < 1, '重力に使う質量と Rapier の質量が一致');
});

test('浸水: 非有限の水の質量特性は捨て、後から来た正しい値で回復する', async () => {
  const sim = await createSim();
  sim.step();
  sim.setWater({ mass: 1e5, com: [NaN, 1, 1], inertia: [1, 1, 1, 0, 0, 0] });
  sim.setWater({ mass: Infinity, com: [0, 1, 1], inertia: [1, 1, 1, 0, 0, 0] });
  sim.setWater({ mass: 1e5, com: [0, 1, 1], inertia: [1, NaN, 1, 0, 0, 0] });
  const c = sim.body.localCom();
  assert.ok([c.x, c.y, c.z].every(Number.isFinite), `重心 ${JSON.stringify(c)}`);
  sim.setWater({ mass: 1e6, com: [0, 2, 1], inertia: [1, 1, 1, 0, 0, 0] });
  run(sim, 1);
  const s = sim.state();
  assert.ok(Math.abs(s.totalMass - (SHIP_MASS + 1e6)) < 1, `${s.totalMass}`);
  assert.ok(s.y < -DESIGN_DRAFT - 0.1, `水の重さで沈む y=${s.y}`);
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

test('流体への見かけの重力: 傾いて落ち着いた船では、低い舷・低い船首へ向く（水が坂を下る向き）', async () => {
  // 姿勢を瞬間的に書き換えると浮力が急変して並進加速度が混ざるので、水の偏りで静かに傾けて落ち着かせてから見る
  const sim = await createSim();
  run(sim, 2);
  sim.setWater(roomWater(['後部兵員室 1', '後部兵員室 2', '士官室'], Infinity, { side: 1 }));
  run(sim, 30);
  const roll = sim.state().rollDeg;
  assert.ok(roll < -1, `左舷（+x）が下がる roll=${roll}`);
  const g = sim.fluidFrame().gravity;
  const expect = 9.81 * Math.sin((-roll * Math.PI) / 180);
  assert.ok(g.x > 0 && Math.abs(g.x - expect) < 0.3, `重力の x 成分は +x（低い左舷）向きで g·sin(傾斜) に近い: ${g.x} vs ${expect}`);
  const sim2 = await createSim();
  run(sim2, 2);
  sim2.setWater(roomWater(['第1缶室', '第2缶室'], DESIGN_DRAFT + 0.6));
  run(sim2, 40);
  const pitch = sim2.state().pitchDeg;
  assert.ok(pitch < -0.5, `船首が下がる pitch=${pitch}`);
  const g2 = sim2.fluidFrame().gravity;
  assert.ok(g2.z > 0 && Math.abs(g2.z - 9.81 * Math.sin((-pitch * Math.PI) / 180)) < 0.3, `重力の z 成分は +z（低い船首）向き: ${g2.z}`);
});
