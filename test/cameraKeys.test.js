import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flyDelta } from '../src/cameraKeys.js';

const near = (a, b, tol = 1e-9) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) <= tol, `${a} ≠ ${b}`));
const keys = (...k) => new Set(k);
const LOOK_NZ = [0, 0, -1]; // −z を向いたカメラ

test('WASD: W は向いている水平方向、S は逆、D は右、A は左（速さ = 距離 × 0.9 [m/s]）', () => {
  near(flyDelta(keys('KeyW'), LOOK_NZ, 10, 1), [0, 0, -9]);
  near(flyDelta(keys('KeyS'), LOOK_NZ, 10, 1), [0, 0, 9]);
  near(flyDelta(keys('KeyD'), LOOK_NZ, 10, 1), [9, 0, 0]);
  near(flyDelta(keys('KeyA'), LOOK_NZ, 10, 1), [-9, 0, 0]);
});

test('WASD: 見下ろしていても前進は水平（海にもぐらない）。Q E だけが上下', () => {
  const down45 = [0, -Math.SQRT1_2, -Math.SQRT1_2];
  const d = flyDelta(keys('KeyW'), down45, 10, 1);
  assert.equal(d[1], 0);
  near(d, [0, 0, -9]);
  near(flyDelta(keys('KeyE'), down45, 10, 1), [0, 9, 0]);
  near(flyDelta(keys('KeyQ'), down45, 10, 1), [0, -9, 0]);
});

test('WASD: 斜め移動も同じ速さ、Shift で 3 倍、距離に比例して上下限あり', () => {
  const d = flyDelta(keys('KeyW', 'KeyD'), LOOK_NZ, 10, 1);
  assert.ok(Math.abs(Math.hypot(...d) - 9) < 1e-9);
  near(flyDelta(keys('KeyW'), LOOK_NZ, 10, 1, { fast: true }), [0, 0, -27]);
  near(flyDelta(keys('KeyW'), LOOK_NZ, 0.1, 1), [0, 0, -3], 1e-9); // 近すぎても 3 m/s
  near(flyDelta(keys('KeyW'), LOOK_NZ, 1000, 1), [0, 0, -60], 1e-9); // 遠くても 60 m/s
});

test('WASD: 逆向きのキーは打ち消し、関係ないキー・dt ≤ 0 は動かない', () => {
  near(flyDelta(keys('KeyW', 'KeyS'), LOOK_NZ, 10, 1), [0, 0, 0]);
  near(flyDelta(keys('KeyX', 'Space'), LOOK_NZ, 10, 1), [0, 0, 0]);
  near(flyDelta(keys('KeyW'), LOOK_NZ, 10, 0), [0, 0, 0]);
});

test('WASD: 真下を見ているときは fallback（画面の上）を前にし、NaN にならない', () => {
  const d = flyDelta(keys('KeyW'), [0, -1, 0], 10, 1, { fallback: [1, 0, 0] });
  near(d, [9, 0, 0]);
  assert.ok(flyDelta(keys('KeyW', 'KeyA'), [0, -1, 0], 10, 1).every(Number.isFinite));
});

test('WASD: 向きが斜め（+x+z）でも右は向きに垂直', () => {
  const f = [Math.SQRT1_2, 0, Math.SQRT1_2];
  const w = flyDelta(keys('KeyW'), f, 10, 1), dd = flyDelta(keys('KeyD'), f, 10, 1);
  assert.ok(Math.abs(w[0] * dd[0] + w[2] * dd[2]) < 1e-9);
  // 右 = 前 × 上 = (−fz, 0, fx)。−z を向いたカメラの右が +x になるのと同じ右手系
  near(dd, [-9 * Math.SQRT1_2, 0, 9 * Math.SQRT1_2]);
});
