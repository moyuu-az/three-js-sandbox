import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { createSim, SEABED_Y, WATERLINE, HULL_VOLUME, CELL } from './sim.js';
import * as H from './hull.js';

const run = (sim, sec) => { for (let i = 0; i < sec * 60; i++) sim.step(); };
const torpedo = (sim) => sim.addSideHole(2.2, WATERLINE - 0.25); // 右舷船首、喫水線の 25cm 下（船首区画だけ）

test('船型: セル化した体積が真の体積に近く、衝突形状（凸包）はそれを包む', async () => {
  const fine = H.buildCells(0.05).length * 0.05 ** 3; // 細かいセルで求めた真の体積の近似
  assert.ok(Math.abs(HULL_VOLUME - fine) / fine < 0.02, `cells=${HULL_VOLUME} fine=${fine}`);
  const v = (await createSim()).hullCollider.volume();
  // 凸包は船首・船尾の反りの凹みを埋めるので少し大きい。衝突（着底）にしか使わない
  assert.ok(v >= fine && v < fine * 1.1, `collider=${v} fine=${fine}`);
});

test('船型: 船首は絞られ、船底は丸い', () => {
  assert.ok(H.halfBreadth(0, 0) === H.B / 2);
  assert.ok(H.halfBreadth(0, -H.D / 2 + 0.01) < H.B / 2 * 0.8, 'ビルジが丸い');
  assert.ok(H.halfBreadth(3.6, 0.6) < H.halfBreadth(0, 0.6) / 2, '船首が細い');
  assert.equal(H.halfBreadth(0, 2), -1, '甲板より上は船外');
});

test('無傷なら設計喫水線で水平に浮き続ける', async () => {
  const sim = await createSim();
  run(sim, 30);
  const s = sim.state();
  assert.ok(Math.abs(s.y + WATERLINE) < 0.02, `y=${s.y} expected ${-WATERLINE}`);
  assert.ok(Math.abs(s.pitchDeg) < 0.3, `pitch=${s.pitchDeg}`);
  assert.ok(Math.abs(s.rollDeg) < 0.3, `roll=${s.rollDeg}`);
  assert.deepEqual(s.flood, [0, 0, 0]);
});

test('復原性: 横に傾けても元に戻る', async () => {
  const sim = await createSim();
  run(sim, 5);
  sim.body.applyTorqueImpulse({ x: 0, y: 0, z: 8000 }, true);
  run(sim, 1);
  assert.ok(Math.abs(sim.state().rollDeg) > 3, `傾いた roll=${sim.state().rollDeg}`);
  run(sim, 30);
  assert.ok(Math.abs(sim.state().rollDeg) < 0.5, `戻った roll=${sim.state().rollDeg}`);
});

test('喫水線より上の破孔からは浸水しない', async () => {
  const sim = await createSim();
  sim.addSideHole(0, WATERLINE + 0.3);
  run(sim, 20);
  assert.deepEqual(sim.state().flood, [0, 0, 0]);
});

test('船首区画だけの浸水なら、隔壁が持ちこたえて船首が下がった状態で浮き続ける', async () => {
  const sim = await createSim();
  run(sim, 5);
  torpedo(sim);
  run(sim, 120);
  const s = sim.state();
  assert.ok(s.flood[2] > 0 && s.flood[0] === 0 && s.flood[1] === 0, `船首区画だけ ${s.flood}`);
  assert.ok(s.pitchDeg < -2, `船首が下がる pitch=${s.pitchDeg}`);
  assert.ok(s.y > -1, `浮いている y=${s.y}`);
});

test('魚雷: 破口が隔壁をまたがなければ 1 区画、またげば 2 区画に穴が開く', async () => {
  const sim = await createSim();
  assert.equal(sim.torpedo(2.5, WATERLINE - 0.3).length, 1);
  const two = sim.torpedo(H.BULKHEADS[1], WATERLINE - 0.3);
  assert.deepEqual(two.map((h) => h.comp), [1, 2]);
  assert.ok(Math.abs(two[0].area - two[1].area) < 1e-9, '隔壁の真上なら半々');
});

test('隔壁をまたぐ魚雷: 船首から沈み、全区画満水で海底に着く', async () => {
  const sim = await createSim();
  run(sim, 5);
  sim.torpedo(H.BULKHEADS[1], WATERLINE - 0.3);
  run(sim, 20);
  const s = sim.state();
  assert.ok(s.flood[2] > 0 && s.flood[1] > 0 && s.flood[0] === 0, `最初は中央・船首区画 ${s.flood}`);
  assert.ok(s.pitchDeg < -2, `船首が下がる pitch=${s.pitchDeg}`);
  run(sim, 240);
  assert.ok(sim.state().y < SEABED_Y + H.L, `海底付近 y=${sim.state().y}`);
  assert.ok(sim.state().flood.every((f) => f === 1), `全区画満水 ${sim.state().flood}`);
  assert.ok(!Number.isNaN(sim.state().pitchDeg));
});

test('区画内の水は水面の法線方向に低いセルから埋まり、量が保存される', async () => {
  const sim = await createSim();
  run(sim, 5);
  torpedo(sim);
  run(sim, 30);
  const n = sim.surfaces[2].n;
  const bow = sim.cells.filter((c) => c.comp === 2);
  const full = bow.filter((c) => c.fill === 1), empty = bow.filter((c) => c.fill === 0);
  assert.ok(full.length > 0 && empty.length > 0);
  const maxFull = Math.max(...full.map((c) => n.dot(c.world))), minEmpty = Math.min(...empty.map((c) => n.dot(c.world)));
  assert.ok(maxFull <= minEmpty + 1e-9);
  const vol = bow.reduce((a, c) => a + c.fill, 0) * CELL ** 3;
  assert.ok(Math.abs(vol - sim.water[2]) < 1e-9, 'セルの水量合計 = 区画の浸水量');
});

test('スロッシング: 揺さぶると水面が傾き、やがて水平に戻る', async () => {
  const sim = await createSim();
  run(sim, 5);
  torpedo(sim);
  run(sim, 15);
  sim.body.applyImpulse({ x: 6000, y: 0, z: 0 }, true);
  let maxTilt = 0;
  for (let i = 0; i < 120; i++) { sim.step(); maxTilt = Math.max(maxTilt, Math.abs(sim.surfaces[2].tilt.x)); }
  assert.ok(maxTilt > 0.02, `傾いた ${maxTilt}`);
  const cur = sim.holes.at(-1); cur.area = 0; // 浸水を止めて揺れの減衰だけを見る
  run(sim, 30);
  assert.ok(new Vector3(0, 1, 0).angleTo(sim.surfaces[2].n) < 0.03, `水平に戻る n=${sim.surfaces[2].n.toArray()}`);
});
