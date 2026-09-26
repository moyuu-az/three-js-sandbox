import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/coupling.js';
import * as MP from '../src/massprops.js';

// 格子点ごとの質量 masses（[i, j, k, m]）から、GPU と同じ形のモーメントを作る
function gpuMoments(masses, dims) {
  const c = dims.map((d) => d / 2);
  const m = new Array(10).fill(0);
  for (const [i, j, k, w] of masses) {
    const r = [i + 0.5 - c[0], j + 0.5 - c[1], k + 0.5 - c[2]];
    m[0] += w; m[1] += w * r[0]; m[2] += w * r[1]; m[3] += w * r[2];
    m[4] += w * r[0] ** 2; m[5] += w * r[1] ** 2; m[6] += w * r[2] ** 2;
    m[7] += w * r[0] * r[1]; m[8] += w * r[1] * r[2]; m[9] += w * r[2] * r[0];
  }
  return { moments: m, center: c };
}

test('連成: GPU の格子モーメントを船体座標・kg に直すと、直接計算した質量特性と一致する', () => {
  const spec = { origin: [-4, -0.5, -15.5], h: 0.3 }, dims = [28, 30, 104];
  const masses = [[3, 5, 10, 2.5], [20, 7, 60, 1], [14, 20, 90, 4], [9, 3, 33, 0.7]];
  const { moments, center } = gpuMoments(masses, dims);
  const mp = 3.4; // 粒子 1 個の質量 [kg]
  const got = C.waterMassProps(moments, center, spec, mp);
  // 直接: 格子点の船体座標で積算
  let M = 0; const s1 = [0, 0, 0], s2 = [0, 0, 0, 0, 0, 0];
  for (const [i, j, k, w] of masses) {
    const p = [spec.origin[0] + (i + 0.5) * spec.h, spec.origin[1] + (j + 0.5) * spec.h, spec.origin[2] + (k + 0.5) * spec.h];
    const dm = w * mp;
    M += dm; for (let a = 0; a < 3; a++) s1[a] += dm * p[a];
    s2[0] += dm * p[0] ** 2; s2[1] += dm * p[1] ** 2; s2[2] += dm * p[2] ** 2;
    s2[3] += dm * p[0] * p[1]; s2[4] += dm * p[1] * p[2]; s2[5] += dm * p[2] * p[0];
  }
  const want = MP.fromMoments(M, s1, s2);
  assert.ok(Math.abs(got.mass - want.mass) < 1e-9);
  got.com.forEach((v, i) => assert.ok(Math.abs(v - want.com[i]) < 1e-9, `com ${i}`));
  got.inertia.forEach((v, i) => assert.ok(Math.abs(v - want.inertia[i]) < 1e-6 * Math.max(1, Math.abs(want.inertia[i])), `I ${i}: ${v} vs ${want.inertia[i]}`));
});

test('連成: 水が無ければ質量 0（剛体の質量特性を壊さない）', () => {
  const r = C.waterMassProps(new Array(10).fill(0), [1, 1, 1], { origin: [0, 0, 0], h: 1 }, 1);
  assert.deepEqual(r, { mass: 0, com: [0, 0, 0], inertia: [0, 0, 0, 0, 0, 0] });
});

test('連成: 開口部の設定は格子単位で、噴流は外向き法線の逆（船内向き）', () => {
  const spec = { origin: [-4, -0.5, -15.5], h: 0.25 };
  const o = { normal: [1, 0, 0], spawn: { center: [3.2, 1.5, 2.0], ax: [0, 0, 0.5], ay: [0, 0.25, 0] } };
  const p = C.openingParams(o, { mode: 1, speed: 5 }, spec);
  assert.deepEqual(p.inflow, [-20, -0, -0]);
  assert.deepEqual(p.center, [(3.2 + 4) / 0.25, (1.5 + 0.5) / 0.25, (2 + 15.5) / 0.25]);
  assert.deepEqual(p.ax, [0, 0, 2]);
  assert.deepEqual(p.ay, [0, 1, 0]);
});
