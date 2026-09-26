import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as W from '../src/waves.js';

test('波: 有義波高が指定どおり（4√m₀）で、分散関係 ω² = g k を満たす', () => {
  for (const s of W.SEA_STATES) {
    const ws = W.makeWaves(s.hs, s.tp);
    const m0 = ws.reduce((t, w) => t + (w.amp * w.amp) / 2, 0);
    assert.ok(Math.abs(4 * Math.sqrt(m0) - s.hs) < 1e-9, s.id);
    for (const w of ws) assert.ok(Math.abs(w.omega ** 2 - W.G * w.k) < 1e-9);
    assert.ok(ws.reduce((t, w) => t + w.q * w.k * w.amp, 0) < 1, '波頂がループしない');
  }
});

test('波: 波高 0 なら海面は平ら', () => {
  assert.deepEqual(W.makeWaves(0, 5), []);
  assert.equal(W.heightAt([], 3, 4, 10), 0);
});

test('波: heightAt は水平変位を戻して、変位後の点の高さを返す', () => {
  const ws = W.makeWaves(2.2, 7.5);
  let maxErr = 0;
  for (let i = 0; i < 200; i++) {
    const x0 = (i * 7.3) % 60 - 30, z0 = (i * 3.1) % 50 - 25, t = i * 0.37;
    const d = W.displace(ws, x0, z0, t);
    maxErr = Math.max(maxErr, Math.abs(W.heightAt(ws, x0 + d[0], z0 + d[2], t, 8) - d[1]));
  }
  assert.ok(maxErr < 0.01, `誤差 ${maxErr}`);
});

test('波: 海面は時間とともに動き、平均はほぼ 0', () => {
  const ws = W.makeWaves(0.9, 5.5);
  let sum = 0, n = 0, max = 0;
  for (let t = 0; t < 200; t += 0.25) { const h = W.heightAt(ws, 1, 2, t); sum += h; n++; max = Math.max(max, Math.abs(h)); }
  assert.ok(Math.abs(sum / n) < 0.1, `平均 ${sum / n}`);
  assert.ok(max > 0.3 && max < 1.5, `最大 ${max}`);
});

test('波: 粗い格子の補間は直接計算に近い', () => {
  const ws = W.makeWaves(0.9, 5.5);
  const g = W.createHeightGrid(48, 1.5);
  g.update(ws, 0, 0, 3);
  let e = 0;
  for (let i = 0; i < 100; i++) { const x = (i * 0.37) % 30 - 15, z = (i * 0.91) % 30 - 15; e = Math.max(e, Math.abs(g.sample(x, z) - W.heightAt(ws, x, z, 3))); }
  assert.ok(e < 0.08, `誤差 ${e}`);
});

test('波: 軌道速度は深さとともに減る', () => {
  const ws = W.makeWaves(2.2, 7.5);
  const sp = (d) => { let m = 0; for (let t = 0; t < 20; t += 0.1) { const v = W.orbitalVelocity(ws, 0, 0, t, d); m = Math.max(m, Math.hypot(...v)); } return m; };
  assert.ok(sp(0) > sp(5) && sp(5) > sp(20));
});

test('波: シェーダ用の詰め込みは成分数を上限で切る', () => {
  const p = W.packWaves(W.makeWaves(1, 5, { count: 20 }));
  assert.equal(p.count, W.MAX_WAVES);
  assert.equal(p.a.length, W.MAX_WAVES * 4);
});
