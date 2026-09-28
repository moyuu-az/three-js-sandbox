import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion, Vector3 } from 'three';
import { createSim, SEABED_Y, DESIGN_DRAFT, SHIP_MASS, ENVELOPE_VOLUME, RHO, SHIP_COM, GM, CELL, DT } from '../src/sim.js';
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

test('艦型: 外殻の体積は予備浮力を持ち、設計喫水の排水量（公試排水量 3,048 t の ±3%）が艦の重さ', () => {
  assert.ok(ENVELOPE_VOLUME * RHO > SHIP_MASS * 2, `外殻 ${ENVELOPE_VOLUME} m³`);
  assert.ok(Math.abs(SHIP_MASS / 3048e3 - 1) < 0.03, `${SHIP_MASS}`);
});

test('艦型: 重心の高さ KG = KM − GM（駆逐艦の典型 4〜5 m）、前後は浮心の位置', () => {
  // 浮力セル（sim と同じ大きさ）で求めた KM から。細かいセルとの差（~0.07 m）を許容に入れると、船型を変えたときに誤って通る
  const d = H.displacement(H.buildCells(CELL), CELL, DESIGN_DRAFT);
  const km = d.kb + H.waterplaneInertia(DESIGN_DRAFT) / d.v;
  assert.ok(Math.abs(SHIP_COM[1] - (km - GM)) < 1e-9, `KG ${SHIP_COM[1]} vs KM − GM ${km - GM}`);
  const fine = H.displacement(H.buildCells(0.25), 0.25, DESIGN_DRAFT);
  assert.ok(Math.abs(d.kb - fine.kb) < 0.1, `KB はセルの大きさで 0.1 m 以上変わらない: ${d.kb} / ${fine.kb}`);
  assert.ok(SHIP_COM[1] > 4 && SHIP_COM[1] < 5, `KG ${SHIP_COM[1]}`);
  assert.ok(Math.abs(SHIP_COM[2] - d.lcb) < 1e-9, `LCG ${SHIP_COM[2]} LCB ${d.lcb}`);
});

test('水線面の二次モーメント: 水線面を 2 次元に刻んだ ∬ x² dA と一致し、同じ長さ・幅の箱 l b³ / 12 より小さい', () => {
  // waterplaneInertia は断面ごとの (2/3) b³ の和。式を使わずに水線面の内側の点の x² を足した値と比べる
  const I = H.waterplaneInertia(DESIGN_DRAFT);
  let ref = 0;
  const dx = 0.02, dz = 0.1;
  for (let z = H.Z_MIN + dz / 2; z < H.Z_MAX; z += dz) {
    const b = H.halfBreadth(z, DESIGN_DRAFT);
    if (b > 0) for (let x = -H.B / 2 + dx / 2; x < H.B / 2; x += dx) if (Math.abs(x) <= b) ref += x * x * dx * dz;
  }
  assert.ok(Math.abs(I / ref - 1) < 0.005, `I_T ${I} / ∬x²dA ${ref}`);
  const box = (H.L * H.B ** 3) / 12;
  assert.ok(I > 0.4 * box && I < box, `I_T ${I} / 箱 ${box}`);
  // 水線より上（船外）なら 0、幅が 0 の船底より下も 0
  assert.equal(H.waterplaneInertia(H.Y_MAX + 1), 0);
  assert.equal(H.waterplaneInertia(-0.1), 0);
});

test('復原性: 傾斜試験（重心の高さに片舷へ重りを載せる）で測った GM が、KG の元にした GM と合う', async () => {
  // tan φ = w·x / (Δ·GM)。GM は SHIP_COM の式の中の値ではなく、浮力セルと剛体の釣り合いから出てくる値を見る
  const sim = await createSim();
  run(sim, 2);
  const w = 30e3, x = 5;
  sim.setWater({ mass: w, com: [x, SHIP_COM[1], SHIP_COM[2]], inertia: [0, 0, 0, 0, 0, 0] });
  run(sim, 40);
  const phi = (Math.abs(sim.state().rollDeg) * Math.PI) / 180;
  assert.ok(sim.state().rollDeg < 0, '重りの舷（+x、左舷）へ傾く');
  const gm = (w * x) / ((SHIP_MASS + w) * Math.tan(phi));
  assert.ok(Math.abs(gm / GM - 1) < 0.15, `傾斜試験の GM ${gm} / 設定 ${GM}`);
});

test('静水: 無傷なら設計喫水で水平に浮き続ける', async () => {
  const sim = await createSim();
  run(sim, 30);
  const s = sim.state();
  assert.ok(Math.abs(s.draft - DESIGN_DRAFT) < 0.05, `喫水 ${s.draft}`);
  assert.ok(Math.abs(s.pitchDeg) < 0.3 && Math.abs(s.rollDeg) < 0.3, `${s.pitchDeg} ${s.rollDeg}`);
});

test('静水: 斜め（60°）を向いた艦も設計喫水で水平に浮く（海面の格子は艦の向きに沿う）', async () => {
  const sim = await createSim({ waves: W.makeWaves(0.25, 4.0) });
  const a = (60 * Math.PI) / 180;
  sim.body.setRotation({ x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) }, true);
  run(sim, 20);
  const s = sim.state();
  assert.ok(Math.abs(s.draft - DESIGN_DRAFT) < 0.15, `喫水 ${s.draft}`);
  assert.ok(Math.abs(s.pitchDeg) < 0.5 && Math.abs(s.rollDeg) < 0.5, `${s.pitchDeg} ${s.rollDeg}`);
});

test('波の格子: 艦がどの姿勢（回頭・横倒し・艦首が上がって沈む・艦首が真上）でも、船体の全体で海面を直接計算に近く返す', async () => {
  // 格子は艦の向きに沿った長方形で、外の点は端の値になる。艦のどこかが格子の外に出ると、そこの浮力が波を感じなくなる。
  // 穏やかな海の喫水だけでは端の値との差が見えないので、船体を囲む箱の角・辺で海面そのものを比べる。
  // 波は直交する 2 成分（波長 24 m・振幅 1 m・尖り 0）: 補間の誤差（~0.07 m）と、格子から 1〜2 m はみ出した点の端の値の誤差（~0.4 m）が
  // はっきり分かれる（makeWaves の海では格子の幅を ±10 m に縮めても 0.1 m 未満の差しか出ない）
  const k = (2 * Math.PI) / 24;
  const wave = (a) => ({ dx: Math.cos(a), dz: Math.sin(a), k, omega: Math.sqrt(W.G * k), phase: a, amp: 1, q: 0 });
  const waves = [wave(0.3), wave(0.3 + Math.PI / 2)];
  const axis = (x, y, z, deg) => new Quaternion().setFromAxisAngle(new Vector3(x, y, z), (deg * Math.PI) / 180);
  const yaw = axis(0, 1, 0, 60);
  const poses = {
    回頭: yaw,
    横倒し: yaw.clone().multiply(axis(0, 0, 1, 90)),
    '艦首が上がって沈む': axis(0, 1, 0, 150).multiply(axis(1, 0, 0, -45)),
    艦首が真上: yaw.clone().multiply(axis(1, 0, 0, -90)), // 艦首の向きが水平面で決まらない
  };
  for (const [name, q] of Object.entries(poses)) {
    const sim = await createSim({ waves });
    sim.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    sim.step(); // 海面の格子は step の頭で、その時刻（sim.time − DT）について作る
    let e = 0;
    for (const x of [-H.B / 2, H.B / 2]) for (const y of [0, H.Y_MAX]) for (let z = H.Z_MIN; z <= H.Z_MAX; z += 2) {
      const w = sim.toWorld([x, y, z]);
      e = Math.max(e, Math.abs(sim.sea(w[0], w[2]) - W.heightAt(waves, w[0], w[2], sim.time - DT, 3)));
    }
    assert.ok(e < 0.15, `${name}: 誤差 ${e.toFixed(3)} m（振幅 1 m の 2 成分）`);
  }
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
