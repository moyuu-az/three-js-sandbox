import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as V from '../src/voxel.js';
import * as Lo from '../src/layout.js';
import * as H from '../src/hull.js';
import { buildShipGrid, breachAt, ruptureAt } from '../src/shipgrid.js';

const h = 0.3;
const R = (name) => Lo.ROOMS.findIndex((r) => r.name === name);
const nodeIn = (g, name) => { for (let n = 0; n < g.N; n++) if (g.type[n] === V.NODE_FLUID && g.room[n] === R(name)) return n; throw new Error(name); };
// start から水が届く部屋の集合
function reach(g, start) {
  const seen = V.flood(g, start);
  const rooms = new Set();
  for (let n = 0; n < g.N; n++) if (seen[n] && g.room[n] !== V.NO_ROOM) rooms.add(Lo.ROOMS[g.room[n]].name);
  return rooms;
}
const allClosed = {
  doors: Object.fromEntries(Lo.DOORS.filter((d) => d.wt).map((d) => [d.id, false])),
  seaOpenings: Object.fromEntries(Lo.SEA_OPENINGS.map((o) => [o.id, false])),
};

test('格子: どの部屋にも水の入る格子点があり、部屋の無い水の格子点は無い', () => {
  const { grid, capacity } = buildShipGrid(h);
  Lo.ROOMS.forEach((r, i) => assert.ok(capacity[i] > 5, `${r.name} の容積 ${capacity[i]}`));
  for (let n = 0; n < grid.N; n++) if (grid.type[n] === V.NODE_FLUID) assert.notEqual(grid.room[n], V.NO_ROOM);
});

test('格子: 船外の格子点が船体を 1 層以上囲んでいる（粒子が格子の端に届かない）', () => {
  const { grid } = buildShipGrid(h);
  const [nx, ny, nz] = grid.dims;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (i && j && k && i < nx - 1 && j < ny - 1 && k < nz - 1) continue;
    assert.equal(grid.type[grid.index(i, j, k)], V.NODE_EXTERIOR);
  }
});

test('格子: 水密扉と開口を全部閉じると、水密区画どうしは水が通らない', () => {
  const { grid } = buildShipGrid(h, allClosed);
  const byComp = (c) => new Set(Lo.ROOMS.filter((r) => r.comp === c).map((r) => r.name));
  // 甲板室は機関室と階段でつながる（甲板より上の経路）。それ以外の区画は閉じている
  assert.deepEqual(reach(grid, nodeIn(grid, '第1船倉')), byComp('H1'));
  assert.deepEqual(reach(grid, nodeIn(grid, '船首倉庫')), byComp('FP'));
  assert.deepEqual(reach(grid, nodeIn(grid, '操舵機室')), byComp('AP'));
  assert.deepEqual(reach(grid, nodeIn(grid, '第2船倉')), byComp('H2'));
  assert.deepEqual(reach(grid, nodeIn(grid, '機関室')), new Set([...byComp('ER'), ...byComp('DH')]));
});

test('格子: 既定では水密扉 D1 だけ開いていて、第2船倉の水は通路 → 機関室 → 甲板室へ回る', () => {
  const { grid } = buildShipGrid(h);
  const r = reach(grid, nodeIn(grid, '第2船倉'));
  for (const name of ['通路', '船室 左1', '食堂', '機関室', 'サロン', '調理室']) assert.ok(r.has(name), name);
  for (const name of ['第1船倉', '船首倉庫', '操舵機室']) assert.ok(!r.has(name), name);
});

test('格子: 水密扉を開けると隣の区画とつながる', () => {
  const closed = buildShipGrid(h, allClosed).grid;
  const open = buildShipGrid(h, { ...allClosed, doors: { ...allClosed.doors, D3: true } }).grid;
  assert.ok(!reach(closed, nodeIn(closed, '機関室')).has('操舵機室'));
  assert.ok(reach(open, nodeIn(open, '機関室')).has('操舵機室'));
});

test('格子: 隔壁・甲板は 1 格子点の厚さ', () => {
  const { grid } = buildShipGrid(h, allClosed);
  const [, , nz] = grid.dims;
  const [i, j] = grid.toGrid(0, 2, 0).map(Math.floor);
  let run = 0, maxRun = 0;
  for (let k = 0; k < nz; k++) {
    const [, , z] = grid.pos(i, j, k);
    if (z < -12 || z > 11) continue; // 機器の無い x = 0, y = 2 の線上では隔壁だけが固体
    const t = grid.type[grid.index(i, j, k)];
    if (t === V.NODE_SOLID && !Lo.OBSTACLES.some((o) => Lo.inBox(o.box, 0, 2, z, h))) { run++; maxRun = Math.max(maxRun, run); } else run = 0;
  }
  assert.equal(maxRun, 1);
});

test('格子: 常設の開口は開いていれば船内側と船外側の格子点を持つ', () => {
  const { grid, openings } = buildShipGrid(h);
  assert.equal(openings.length, Lo.SEA_OPENINGS.length);
  for (const o of openings) {
    let inn = 0, out = 0;
    for (let n = 0; n < grid.N; n++) { if (grid.type[n] === V.NODE_OPENING_IN + o.k) inn++; if (grid.type[n] === V.NODE_OPENING_OUT + o.k) out++; }
    assert.ok(inn > 0 && out > 0, `${o.name} in=${inn} out=${out}`);
  }
  assert.equal(buildShipGrid(h, allClosed).openings.length, 0);
});

test('破口: 隔壁をまたぐと部屋ごとに分かれ、面積の合計は破口の面積', () => {
  const b = breachAt(3.5, 2.0, Lo.BULKHEADS[2], 2.0, 1.2);
  const { openings } = buildShipGrid(h, { ...allClosed, breaches: [b] });
  const names = openings.map((o) => Lo.ROOMS[o.room].name).sort();
  assert.deepEqual(names, ['第1船倉', '第2船倉']);
  const sum = openings.reduce((s, o) => s + o.area, 0);
  assert.ok(Math.abs(sum - 2.4) < 1e-9, `面積 ${sum}`);
  for (const o of openings) assert.ok(o.normal[0] > 0.9, '左舷の外向き法線');
});

test('破口: 右舷・喫水線下の破口は右舷向きで、その部屋の格子点に開く', () => {
  const b = breachAt(-3.5, 1.8, 7.5);
  assert.ok(b.normal[0] < -0.9);
  const { grid, openings } = buildShipGrid(h, { ...allClosed, breaches: [b] });
  assert.equal(openings.length, 1);
  assert.equal(Lo.ROOMS[openings[0].room].name, '第1船倉');
  // 破口を通って船内と船外がつながる（船外側の格子点に水が届く）
  const seen = V.flood(grid, nodeIn(grid, '第1船倉'));
  let reachesOut = false;
  for (let n = 0; n < grid.N; n++) if (seen[n] && grid.type[n] >= V.NODE_OPENING_OUT) reachesOut = true;
  assert.ok(reachesOut);
});

test('破口: 船体の外の点（法線が決まらない）で作った破口は格子を変えない', () => {
  const base = buildShipGrid(h, allClosed).grid;
  for (const [x, y, z] of [[3.5, 6.5, 0], [3, 1.5, 15.5]]) {
    assert.equal(H.halfBreadth(z, y), -1);
    const { grid, openings } = buildShipGrid(h, { ...allClosed, breaches: [breachAt(x, y, z)] });
    assert.equal(openings.length, 0, `${[x, y, z]}`);
    assert.deepEqual(grid.type, base.type, `${[x, y, z]} で格子が変わった`);
  }
});

test('距離場・滑り境界: 隔壁の法線は z 軸、第 2 甲板は y 軸、隣の水の格子点までの距離は 1', () => {
  const { grid } = buildShipGrid(h, allClosed);
  const pk = V.packForGpu(grid);
  const [i, j, k] = grid.toGrid(0, 2.0, Lo.BULKHEADS[2]).map(Math.floor);
  const bulk = grid.index(i, j, k);
  assert.equal(grid.type[bulk], V.NODE_SOLID);
  assert.deepEqual(Array.from(pk.info.slice(4 * bulk, 4 * bulk + 3)), [0, 0, 1]);
  const [a, b, c] = grid.toGrid(0, Lo.DECK2, 0.5).map(Math.floor);
  const deck = grid.index(a, b, c);
  assert.equal(grid.type[deck], V.NODE_SOLID);
  assert.deepEqual(Array.from(pk.info.slice(4 * deck, 4 * deck + 3)), [0, 1, 0]);
  const above = grid.index(a, b + 1, c);
  assert.equal(grid.type[above], V.NODE_FLUID);
  assert.ok(Math.abs(pk.dist[above] - 1) < 1e-6);
  assert.ok(pk.sdf[4 * above + 1] > 0.9, '距離場の勾配は床から上向き');
});

test('格子: 二重底（タンクトップより下）は固体で浸水しない', () => {
  const { grid } = buildShipGrid(h);
  for (let n = 0; n < grid.N; n++) {
    const [x, y, z] = grid.pos(...grid.coords(n));
    if (H.inside(x, y, z) && y < H.TANK_TOP) assert.equal(grid.type[n], V.NODE_SOLID);
  }
});

test('格子: 格子間隔を変えても（品質プリセット）水密区画は閉じたまま', () => {
  for (const hh of [0.25, 0.28, 0.33]) {
    const { grid } = buildShipGrid(hh, allClosed);
    const r = reach(grid, nodeIn(grid, '第1船倉'));
    assert.deepEqual([...r], ['第1船倉'], `h=${hh}`);
    const e = reach(grid, nodeIn(grid, '第2船倉'));
    assert.ok(!e.has('機関室') && !e.has('第1船倉'), `h=${hh} ${[...e]}`);
  }
});

// ---------- 空気圧・水圧による破断の穴 ----------
const unit = (v) => Math.abs(Math.hypot(...v) - 1) < 1e-6;
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

test('破断: 上甲板の穴は上向きの面、u・v・法線は直交する単位ベクトルで、その部屋の開口になる（名前・種類を引き継ぐ）', () => {
  const z = 7.5, p = [1.0, H.deckY(z), z];
  const b = ruptureAt(p, [0, 1, 0], 0.8, { kind: 'rupture', name: '破裂（第1船倉）' });
  assert.deepEqual(b.normal, [0, 1, 0]);
  for (const v of [b.u, b.v, b.normal]) assert.ok(unit(v));
  assert.ok(Math.abs(dot3(b.u, b.v)) < 1e-9 && Math.abs(dot3(b.u, b.normal)) < 1e-9 && Math.abs(dot3(b.v, b.normal)) < 1e-9);
  const { openings } = buildShipGrid(h, { ...allClosed, breaches: [b] });
  const o = openings.filter((x) => x.kind === 'rupture');
  assert.ok(o.length >= 1);
  assert.equal(Lo.ROOMS[o[0].room].name, '第1船倉');
  assert.equal(o[0].name, '破裂（第1船倉）');
  assert.ok(Math.abs(o.reduce((s, x) => s + x.area, 0) - 0.64) < 1e-9, '面積 0.8 × 0.8');
});

test('破断: 舷側の穴は船体の曲面の法線（外向き）を使い、格子の向き（±x）とほぼ同じ向き', () => {
  const z = 2, y = 2.2, x = -H.halfBreadth(z, y);
  const b = ruptureAt([x, y, z], [-1, 0, 0], 0.8);
  assert.ok(unit(b.normal) && b.normal[0] < -0.8, `${b.normal}`);
  assert.deepEqual(b.normal.map((c) => +c.toFixed(9)), H.surfaceNormal(x, y, z).map((c) => +c.toFixed(9)));
  const { openings } = buildShipGrid(h, { ...allClosed, breaches: [b] });
  assert.ok(openings.some((o) => o.kind === 'breach' && Lo.ROOMS[o.room].comp === 'H2'), '魚雷と同じ breach 扱い（種類を渡さなければ）');
});

test('破断: 甲板室の壁の穴は格子の向きのまま（船体の曲面の法線を使わない）', () => {
  const b = ruptureAt([Lo.HOUSE.hw, H.deckY(-10) + 1.5, -10], [1, 0, 0], 0.8);
  assert.deepEqual(b.normal, [1, 0, 0]);
});

// ---------- 開口の数の上限 ----------
test('上限: 開口が MAX_OPENINGS を超えたら、入らなかった片の数を dropped で知らせる（破断を開ける前に確かめるため）', () => {
  // 既定で開いている甲板の開口 8 つ + シナリオの破口 5 つ（複数の部屋にまたがるものがある）で 16 を超える
  const sc = [[-1, 1.8, 7.8, 1.6, 1.2], [1, 1.8, Lo.BULKHEADS[2], 2.4, 1.4], [-1, 2.7, -0.3, 3.2, 2.6], [1, 1.6, -8.5, 1.8, 1.3], [-1, 2.4, 11.2, 3.4, 1.8]];
  const breaches = sc.map(([s, y, z, w, hh]) => breachAt(s * H.halfBreadth(z, y), y, z, w, hh));
  const full = buildShipGrid(h, { breaches });
  assert.equal(full.openings.length, V.MAX_OPENINGS);
  assert.ok(full.dropped > 0, `${full.dropped}`);
  // 入りきらない片は格子にも開口として残らない（開口の番号は 0..15 だけ）
  for (let n = 0; n < full.grid.N; n++) {
    const t = full.grid.type[n];
    if (t >= V.NODE_OPENING_IN) assert.ok((t - V.NODE_OPENING_IN) % 32 < V.MAX_OPENINGS);
  }
  // 収まっていれば 0
  const fits = buildShipGrid(h, { breaches: breaches.slice(0, 1) });
  assert.equal(fits.dropped, 0);
  assert.equal(buildShipGrid(h, allClosed).dropped, 0);
});
