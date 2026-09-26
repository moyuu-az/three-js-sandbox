// GPU 流体（src/gpu/fluid.js）の CPU 側の管理（ディスパッチ数・読み戻し）を、GPU の代わりの偽 renderer で確かめる。
// カーネルの中身は node では動かせない（dev/fluid-selftest.html で確かめる）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFluid, fluidParams } from '../src/gpu/fluid.js';

const DIMS = [8, 8, 8];

// compute の呼び出しを記録し、getArrayBufferAsync は手で解決する Promise を返す renderer
function fakeRenderer() {
  const calls = [], reads = [];
  return {
    calls, reads,
    compute(nodes, count = null) { calls.push({ nodes: Array.isArray(nodes) ? nodes : [nodes], count }); },
    getArrayBufferAsync(attr) {
      let resolve;
      const p = new Promise((r) => { resolve = r; });
      reads.push({ attr, resolve });
      return p;
    },
  };
}
const flush = () => new Promise((r) => setImmediate(r));
// 出ている読み戻し（counters / roomAcc / partials の 3 本）を GPU の counters の値で解決する
async function answer(r, counters) {
  const pending = r.reads.splice(0);
  for (const { attr, resolve } of pending) {
    const a = attr.array;
    if (a.length === 4) resolve(Int32Array.from(counters).buffer);
    else resolve(new a.constructor(a.length).buffer);
  }
  await flush();
}
const make = (r, maxParticles = 1024) => createFluid(r, { dims: DIMS, maxParticles, stiffness: fluidParams(0.3, 8).stiffness });
const pts = (n) => new Float32Array(n * 3).fill(2);
// 1 回のディスパッチで起動されるスレッド数（three の WebGPU バックエンドと同じ計算）
const invocations = (node, count) => {
  const ws = node.workgroupSize.reduce((a, b) => a * b, 1);
  return Math.ceil((count ?? node.count) / ws) * ws;
};

test('流体: 読み戻しで GPU の HIGH が分かったら、粒子カーネルのディスパッチ数（hwUpper）を締める', async () => {
  const r = fakeRenderer(), f = make(r);
  f.init(pts(600));
  f.step(0.004, 1);
  await answer(r, [500, 600, 500, 0]); // 500 個が船外へ出てフリーリストへ
  assert.equal(f.drawCount, 600);
  // 100 個の生成はフリーリストから取られ HIGH は増えない。CPU の上界は 700 まで上がる
  f.step(0.004, 1, [{ opening: 0, count: 100 }]);
  assert.equal(f.drawCount, 700);
  await answer(r, [400, 600, 500, 0]);
  assert.equal(f.drawCount, 600, 'GPU の HIGH が確定したら上界を締める（締めないと生成のたびに P まで膨らむ）');
});

test('流体: 読み戻しの後に投げた生成の分は、締めた上界に残す（生きている粒子をディスパッチから落とさない）', async () => {
  const r = fakeRenderer(), f = make(r);
  f.init(pts(600));
  f.step(0.004, 1); // 読み戻し（HIGH = 600 の時点）を出す
  f.step(0.004, 1, [{ opening: 0, count: 50 }]); // 読み戻しの返事の前に 50 個を末尾へ生成
  assert.equal(r.reads.length, 3, '読み戻しは同時に 1 組だけ');
  await answer(r, [0, 600, 0, 0]);
  assert.ok(f.drawCount >= 650, `上界 ${f.drawCount} は 600 + 50 以上`);
  f.step(0.004, 1);
  const p2g = r.calls.filter((c) => c.nodes.length === 2 && c.count !== null).at(-1);
  assert.ok(p2g.count >= 650, `P2G のディスパッチ数 ${p2g.count}`);
});

test('流体: init の前に出した読み戻しの古い値で、上界と集計を上書きしない', async () => {
  const r = fakeRenderer(), f = make(r);
  f.init(pts(100));
  f.step(0.004, 1); // HIGH = 100 の時点の読み戻し
  f.init(pts(800));
  await answer(r, [0, 100, 7, 0]);
  assert.equal(f.drawCount, 800);
  assert.equal(f.stats, null, 'init 前の集計（別の粒子の集合）を返さない');
  f.step(0.004, 1);
  await answer(r, [0, 800, 0, 0]);
  assert.equal(f.stats.high, 800);
  assert.equal(f.stats.killed, 0);
});

test('流体: 読み戻しは積み上がらない（返事が来るまで次を出さない）', async () => {
  const r = fakeRenderer(), f = make(r);
  f.init(pts(10));
  for (let i = 0; i < 20; i++) f.step(0.004, 2);
  assert.equal(r.reads.length, 3);
  await answer(r, [0, 10, 0, 0]);
  f.step(0.004, 2);
  assert.equal(r.reads.length, 3);
});

test('流体: カウンタの補正（fixCounters）は 1 スレッドだけで動かす（生成数ぶん起動しない）', () => {
  const r = fakeRenderer(), f = make(r);
  f.init(pts(10));
  f.step(0.004, 1, [{ opening: 0, count: 5000 }]);
  const one = r.calls.flatMap((c) => c.nodes.map((n) => ({ n, count: c.count }))).filter(({ n }) => n.workgroupSize.every((s) => s === 1));
  assert.equal(one.length, 1);
  assert.equal(invocations(one[0].n, one[0].count), 1);
});

test('流体: 粒子カーネルは確保した粒子数を超えるスレッドを起動しない（maxParticles は 256 の倍数）', async () => {
  const r = fakeRenderer(), f = make(r, 512);
  assert.throws(() => make(fakeRenderer(), 500));
  f.init(pts(300));
  for (let i = 0; i < 5; i++) f.step(0.004, 1, [{ opening: 0, count: 200 }]);
  await answer(r, [0, 512, 0, 0]);
  f.step(0.004, 1);
  for (const c of r.calls) for (const n of c.nodes) if (n.count === 512) assert.ok(invocations(n, c.count) <= 512, `${invocations(n, c.count)}`);
});
