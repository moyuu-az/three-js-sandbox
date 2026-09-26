import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as V from '../src/voxel.js';

function randomGrid(dims, p, seed = 1) {
  const g = V.createGrid({ h: 1, origin: [0, 0, 0], dims });
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let n = 0; n < g.N; n++) g.type[n] = rnd() < p ? V.NODE_SOLID : V.NODE_FLUID;
  return g;
}

test('距離場: 総当たりの最近傍距離と一致する', () => {
  for (const [dims, p] of [[[9, 7, 5], 0.05], [[6, 11, 4], 0.3], [[5, 5, 13], 0.01]]) {
    const g = randomGrid(dims, p, dims[0] * 31 + dims[1]);
    const solids = [];
    for (let n = 0; n < g.N; n++) if (g.type[n] === V.NODE_SOLID) solids.push(g.coords(n));
    const d = V.distanceField(g);
    for (let n = 0; n < g.N; n++) {
      const [i, j, k] = g.coords(n);
      const t = Math.min(...solids.map(([a, b, c]) => Math.hypot(i - a, j - b, k - c)));
      assert.ok(Math.abs(d[n] - t) < 1e-5, `${[i, j, k]} ${d[n]} vs ${t}`);
    }
  }
});

test('距離場: 固体が無いときも有限の値（GPU に ∞ を渡さない）', () => {
  const g = V.createGrid({ h: 1, origin: [0, 0, 0], dims: [4, 4, 4] });
  g.type.fill(V.NODE_FLUID);
  const d = V.distanceField(g);
  assert.ok(d.every((x) => Number.isFinite(x) && x > 10));
  const pk = V.packForGpu(g);
  assert.ok(pk.sdf.every(Number.isFinite) && pk.info.every(Number.isFinite));
});

test('滑り境界: 片側だけ水なら水側の軸、角は 0（速度を止める）', () => {
  const g = V.createGrid({ h: 1, origin: [0, 0, 0], dims: [5, 5, 5] });
  g.type.fill(V.NODE_FLUID);
  for (let i = 0; i < 5; i++) for (let k = 0; k < 5; k++) g.type[g.index(i, 0, k)] = V.NODE_SOLID; // 床
  for (let j = 0; j < 5; j++) for (let k = 0; k < 5; k++) g.type[g.index(0, j, k)] = V.NODE_SOLID; // 壁
  const pk = V.packForGpu(g);
  const n = (i, j, k) => Array.from(pk.info.slice(4 * g.index(i, j, k), 4 * g.index(i, j, k) + 3));
  assert.deepEqual(n(2, 0, 2), [0, 1, 0]);
  assert.deepEqual(n(0, 2, 2), [1, 0, 0]);
  assert.deepEqual(n(0, 0, 2), [0, 0, 0]);
  assert.deepEqual(n(2, 2, 2), [0, 0, 0], '水の格子点は法線なし');
});

test('連結: 壁で仕切ると届かず、穴を開けると届く', () => {
  const g = V.createGrid({ h: 1, origin: [0, 0, 0], dims: [6, 3, 3] });
  g.type.fill(V.NODE_FLUID);
  for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) g.type[g.index(3, j, k)] = V.NODE_SOLID;
  assert.equal(V.flood(g, g.index(0, 1, 1))[g.index(5, 1, 1)], 0);
  g.type[g.index(3, 1, 1)] = V.NODE_OPENING_IN;
  assert.equal(V.flood(g, g.index(0, 1, 1))[g.index(5, 1, 1)], 1);
});
