import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as V from '../src/voxel.js';
import * as Lo from '../src/layout.js';
import * as H from '../src/hull.js';
import { buildShipGrid, breachAt, ruptureAt } from '../src/shipgrid.js';
import * as A from '../src/air.js';

const h = 0.5; // 標準画質の格子間隔
const K = Lo.BULKHEADS;
const R = (name) => Lo.ROOMS.findIndex((r) => r.name === name);
const nodeIn = (g, name) => { for (let n = 0; n < g.N; n++) if (g.type[n] === V.NODE_FLUID && g.room[n] === R(name)) return n; throw new Error(name); };
// start から水が届く部屋の集合
function reach(g, start) {
  const seen = V.flood(g, start);
  const rooms = new Set();
  for (let n = 0; n < g.N; n++) if (seen[n] && g.room[n] !== V.NO_ROOM) rooms.add(Lo.ROOMS[g.room[n]].name);
  return rooms;
}
const byComp = (c) => new Set(Lo.ROOMS.filter((r) => r.comp === c).map((r) => r.name));
// どの部屋から流しても、同じ水密区画の部屋にしか届かない
function assertCompartmentsSealed(grid, msg = '') {
  for (const r of Lo.ROOMS) assert.deepEqual(reach(grid, nodeIn(grid, r.name)), byComp(r.comp), `${msg} ${r.name}`);
}
const allClosed = {
  doors: Object.fromEntries(Lo.DOORS.filter((d) => d.wt).map((d) => [d.id, false])),
  seaOpenings: Object.fromEntries(Lo.SEA_OPENINGS.map((o) => [o.id, false])),
};

test('格子: どの部屋にも水の入る格子点があり、部屋の無い水の格子点は無い', () => {
  const { grid, capacity } = buildShipGrid(h);
  Lo.ROOMS.forEach((r, i) => assert.ok(capacity[i] > 5, `${r.name} の容積 ${capacity[i]}`));
  for (let n = 0; n < grid.N; n++) if (grid.type[n] === V.NODE_FLUID) assert.notEqual(grid.room[n], V.NO_ROOM);
  assert.ok(Lo.ROOMS.length < V.MAX_ROOMS, '部屋の数は MAX_ROOMS − 1（NO_ROOM の分）まで');
});

test('船体: H.Y_MAX は露天甲板で最も高い点（船首楼甲板の艦首）。格子の上端の元', () => {
  for (let z = H.Z_MIN; z <= H.Z_MAX; z += 0.05) assert.ok(H.deckY(z) <= H.Y_MAX + 1e-12, `z=${z}`);
  assert.equal(H.Y_MAX, H.deckY(H.Z_MAX));
});

test('船体: 島風の寸法（全長 129.5 m・幅 11.2 m・深さ 7.02 m）と、喫水 4.14 m で公試排水量 3,048 t に 3% 以内', () => {
  assert.equal(H.L, 129.5);
  assert.equal(H.D, 7.02);
  let bmax = 0;
  for (let z = H.Z_MIN; z < H.Z_MAX; z += 0.25) for (let y = 0; y < H.Y_MAX; y += 0.25) bmax = Math.max(bmax, 2 * H.halfBreadth(z, y));
  assert.ok(Math.abs(bmax - 11.2) < 0.05, `幅 ${bmax}`);
  const cells = H.buildCells(0.25);
  const t = (H.displacement(cells, 0.25, 4.14).v * 1.025) / 1000;
  assert.ok(Math.abs(t / 3.048 - 1) < 0.03, `排水量 ${t} kt`);
});

test('船体: 船首楼の段は後端で垂直に立ち、その前は上甲板より FC_H 高い（半幅は段の前後で連続）', () => {
  assert.equal(H.deckY(H.FC_Z - 1e-6), H.upperY(H.FC_Z - 1e-6));
  assert.ok(Math.abs(H.deckY(H.FC_Z) - H.upperY(H.FC_Z) - H.FC_H) < 1e-9);
  const y = H.upperY(H.FC_Z) - 0.5;
  assert.ok(Math.abs(H.halfBreadth(H.FC_Z - 1e-6, y) - H.halfBreadth(H.FC_Z, y)) < 1e-3);
  assert.equal(H.halfBreadth(H.FC_Z - 0.5, H.upperY(H.FC_Z) + 1), -1, '段の後ろの上甲板より上は船外');
  const zs = H.stations(10);
  assert.ok(zs.includes(H.FC_Z) && zs.includes(H.FC_Z - 1e-3) && zs[0] === H.Z_MIN && zs.at(-1) === H.Z_MAX);
});

test('格子: 船外の格子点が船体を 1 層以上囲んでいる（粒子が格子の端に届かない）', () => {
  const { grid } = buildShipGrid(h);
  const [nx, ny, nz] = grid.dims;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (i && j && k && i < nx - 1 && j < ny - 1 && k < nz - 1) continue;
    assert.equal(grid.type[grid.index(i, j, k)], V.NODE_EXTERIOR);
  }
});

test('格子: 既定（戦闘配置）では水密扉・水密ハッチはすべて閉じていて、どの部屋の水も同じ水密区画の外へ出ない', () => {
  for (const d of Lo.DOORS.filter((x) => x.wt)) assert.equal(d.open, false, d.name);
  assertCompartmentsSealed(buildShipGrid(h).grid, '既定');
  assertCompartmentsSealed(buildShipGrid(h, allClosed).grid, '全閉');
});

test('格子: 水密区画は 15（14 枚の水密隔壁）で、缶室 3・機械室 2 はそれぞれ別の区画', () => {
  assert.equal(K.length, 14);
  assert.equal(Lo.COMPARTMENTS.filter((c) => c.id !== 'FC').length, 15);
  for (const name of ['第1缶室', '第2缶室', '第3缶室', '前部機械室', '後部機械室']) assert.deepEqual(byComp(Lo.ROOMS[R(name)].comp), new Set([name]));
});

test('配置: resolveY は上甲板・最上甲板と ±Δ を z ごとに解決し、書式の誤りは例外にする', () => {
  const z = 45; // 船首楼の範囲（上甲板と最上甲板が違う）
  assert.equal(Lo.resolveY(3.6, z), 3.6);
  assert.equal(Lo.resolveY('upper', z), H.upperY(z));
  assert.equal(Lo.resolveY('deck', z), H.deckY(z));
  assert.ok(Math.abs(Lo.resolveY('upper-0.4', z) - (H.upperY(z) - 0.4)) < 1e-12);
  assert.ok(Math.abs(Lo.resolveY('upper+1.9', z) - (H.upperY(z) + 1.9)) < 1e-12);
  assert.ok(Math.abs(Lo.resolveY('deck-2', -30) - (H.upperY(-30) - 2)) < 1e-12, '船首楼より後ろでは最上甲板 = 上甲板');
  for (const bad of ['main', 'upper+', 'upper+1.2.3', 'upper+.', 'upper 0.4', 'Upper']) assert.throws(() => Lo.resolveY(bad, z), bad);
});

test('格子: 水密扉・水密ハッチは開けると名前の 2 室の区画をつなぎ、閉じれば（既定）つながない（格子間隔 0.42 / 0.5 / 0.6）', () => {
  // 扉ごとの両側の部屋（名前の「A↔B」）。水密の扉を足したらここにも足す（足し忘れは下の件数の比較で落ちる）
  const sides = {
    D1: ['前部倉庫', '前部兵員室 1'], D2: ['前部兵員室 1', '前部兵員室 2'], D3: ['前部機械室', '後部機械室'],
    D4: ['後部兵員室 1', '後部兵員室 2'], D5: ['後部兵員室 2', '士官室'], D6: ['士官室', '艦長室'],
    D7: ['前部兵員室 1', '船首楼 前部'], D8: ['前部兵員室 2', '船首楼 後部'],
  };
  assert.deepEqual(Object.keys(sides).sort(), Lo.DOORS.filter((x) => x.wt).map((x) => x.id).sort());
  for (const hh of [0.42, 0.5, 0.6]) {
    const closed = buildShipGrid(hh, allClosed).grid;
    for (const d of Lo.DOORS.filter((x) => x.wt)) {
      const [a, b] = sides[d.id];
      assert.notEqual(Lo.ROOMS.find((r) => r.name === a).comp, Lo.ROOMS.find((r) => r.name === b).comp, `${d.id} は水密区画の境目`);
      const g = buildShipGrid(hh, { ...allClosed, doors: { ...allClosed.doors, [d.id]: true } }).grid;
      assert.ok(reach(g, nodeIn(g, a)).has(b), `h=${hh} ${d.id}: 開けても ${a} から ${b} へ届かない`);
      assert.ok(!reach(closed, nodeIn(closed, a)).has(b), `h=${hh} ${d.id}: 閉じても ${a} から ${b} へ届く`);
    }
  }
});

test('格子: 水密扉・水密ハッチを開けると隣の区画とつながる', () => {
  const open = (id) => buildShipGrid(h, { ...allClosed, doors: { ...allClosed.doors, [id]: true } }).grid;
  let g = open('D3');
  assert.ok(reach(g, nodeIn(g, '前部機械室')).has('後部機械室'));
  g = open('D7');
  const r = reach(g, nodeIn(g, '前部兵員室 1'));
  assert.ok(r.has('船首楼 前部') && r.has('船首楼 後部') && r.has('前部弾薬庫'), [...r].join());
  g = open('D5');
  assert.ok(reach(g, nodeIn(g, '後部兵員室 2')).has('後部弾薬庫'), '士官室の下の揚弾口から弾薬庫へ');
});

test('格子: 隔壁・甲板は 1 格子点の厚さ', () => {
  const { grid } = buildShipGrid(h, allClosed);
  const [, , nz] = grid.dims;
  const [i, j] = grid.toGrid(0, 6.2, 0).map(Math.floor);
  let run = 0, maxRun = 0, solids = 0;
  for (let k = 0; k < nz; k++) {
    const [, y, z] = grid.pos(i, j, k);
    if (z < -56 || z > 56 || y > H.upperY(z) - 0.3) continue; // x = 0, y = 6.2 の線上（機器より上）では隔壁だけが固体
    const t = grid.type[grid.index(i, j, k)];
    if (t === V.NODE_SOLID) { run++; if (run === 1) solids++; maxRun = Math.max(maxRun, run); } else run = 0;
  }
  assert.equal(maxRun, 1);
  assert.equal(solids, K.filter((z) => Math.abs(z) <= 56).length, '隔壁ごとに 1 点');
});

test('格子: 常設の開口は開いていれば船内側と船外側の格子点を持つ', () => {
  const { grid, openings } = buildShipGrid(h);
  assert.equal(openings.length, Lo.SEA_OPENINGS.filter((o) => o.open).length);
  for (const o of openings) {
    let inn = 0, out = 0;
    for (let n = 0; n < grid.N; n++) { if (grid.type[n] === V.NODE_OPENING_IN + o.k) inn++; if (grid.type[n] === V.NODE_OPENING_OUT + o.k) out++; }
    assert.ok(inn > 0 && out > 0, `${o.name} in=${inn} out=${out}`);
  }
  // 開口は名前の部屋に開く（缶室の給気口は缶室へ、船首楼の扉は船首楼へ）
  const roomOf = (id) => Lo.ROOMS[openings.find((o) => o.id === id).room].name;
  assert.equal(roomOf('o4'), '第1缶室');
  assert.equal(roomOf('o6'), '第3缶室');
  assert.equal(roomOf('o2'), '船首楼 後部');
  assert.equal(buildShipGrid(h, allClosed).openings.length, 0);
});

test('破口: 隔壁をまたぐと部屋ごとに分かれ、面積の合計は破口の面積', () => {
  const b = breachAt(5, 3.0, K[5], 2.0, 1.2);
  const { openings } = buildShipGrid(h, { ...allClosed, breaches: [b] });
  const names = openings.map((o) => Lo.ROOMS[o.room].name).sort();
  assert.deepEqual(names, ['第1缶室', '第2缶室'].sort());
  const sum = openings.reduce((s, o) => s + o.area, 0);
  assert.ok(Math.abs(sum - 2.4) < 1e-9, `面積 ${sum}`);
  for (const o of openings) assert.ok(o.normal[0] > 0.9, '左舷の外向き法線');
});

test('破口: 右舷・喫水線下の破口は右舷向きで、その部屋の格子点に開く', () => {
  const b = breachAt(-5, 1.8, 16.5, 5, 3);
  // ビルジ（船底の立ち上がり）にかかる高さなので、法線は右舷の外向きで少し下を向く
  assert.ok(b.normal[0] < -0.6 && b.normal[1] < 0, `${b.normal}`);
  const { grid, openings } = buildShipGrid(h, { ...allClosed, breaches: [b] });
  assert.deepEqual([...new Set(openings.map((o) => Lo.ROOMS[o.room].name))], ['第1缶室']);
  // 破口を通って艦内と船外がつながる（船外側の格子点に水が届く）
  const seen = V.flood(grid, nodeIn(grid, '第1缶室'));
  let reachesOut = false;
  for (let n = 0; n < grid.N; n++) if (seen[n] && grid.type[n] >= V.NODE_OPENING_OUT) reachesOut = true;
  assert.ok(reachesOut);
});

test('破口: 船体の外の点（法線が決まらない）で作った破口は格子を変えない', () => {
  const base = buildShipGrid(h, allClosed).grid;
  for (const [x, y, z] of [[3.5, 8.0, 0], [3, 1.5, 64]]) {
    assert.equal(H.halfBreadth(z, y), -1);
    const { grid, openings } = buildShipGrid(h, { ...allClosed, breaches: [breachAt(x, y, z)] });
    assert.equal(openings.length, 0, `${[x, y, z]}`);
    assert.deepEqual(grid.type, base.type, `${[x, y, z]} で格子が変わった`);
  }
});

test('距離場・滑り境界: 隔壁の法線は z 軸、下甲板は y 軸、隣の水の格子点までの距離は 1', () => {
  const { grid } = buildShipGrid(h, allClosed);
  const pk = V.packForGpu(grid);
  const [i, j, k] = grid.toGrid(0, 5.0, K[2]).map(Math.floor);
  const bulk = grid.index(i, j, k);
  assert.equal(grid.type[bulk], V.NODE_SOLID);
  assert.deepEqual(Array.from(pk.info.slice(4 * bulk, 4 * bulk + 3)), [0, 0, 1]);
  const [a, b, c] = grid.toGrid(2.0, Lo.LOWER, -40.5).map(Math.floor);
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

test('格子: 格子間隔を変えても（品質プリセット）水密区画は閉じたまま（既定・全閉とも）', () => {
  // 既定では船首楼の後端扉 o2/o3 が開いている。開口の船外側の格子点が段の後ろの上甲板（第1缶室の天井）まで回り込むと、
  // 第1缶室の天井に穴が開いて船首楼とつながる（格子点の並び方で h = 0.5 では出ず、0.42・0.6 で出た）
  for (const hh of [0.42, 0.6]) {
    assertCompartmentsSealed(buildShipGrid(hh).grid, `既定 h=${hh}`);
    assertCompartmentsSealed(buildShipGrid(hh, allClosed).grid, `全閉 h=${hh}`);
  }
});

test('開口: 船外側の格子点は、その開口が開く部屋以外の水の格子点に接しない（段の角で隣の部屋の天井に穴を開けない）', () => {
  const wet = (t) => t === V.NODE_FLUID || (t >= V.NODE_OPENING_IN && t < V.NODE_OPENING_OUT);
  const nbr = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (const hh of [0.42, 0.5, 0.6]) {
    // 常設の開口（既定）と、船首楼の後端壁の上甲板すれすれに開いた破断の穴
    const low = ruptureAt([2, H.upperY(H.FC_Z) + 0.35, H.FC_Z], [0, 0, -1], 0.8, { kind: 'rupture' });
    for (const [label, state] of [['既定', {}], ['後端壁の破断', { ...allClosed, breaches: [low] }]]) {
      const { grid, openings } = buildShipGrid(hh, state);
      const [nx, ny, nz] = grid.dims;
      for (let n = 0; n < grid.N; n++) {
        const t = grid.type[n];
        if (t < V.NODE_OPENING_OUT) continue;
        const o = openings[t - V.NODE_OPENING_OUT];
        const rooms = new Set(openings.filter((x) => x.id === o.id).map((x) => x.room));
        const [i, j, k] = grid.coords(n);
        for (const [a, b, c] of nbr) {
          if (i + a < 0 || j + b < 0 || k + c < 0 || i + a >= nx || j + b >= ny || k + c >= nz) continue;
          const m = grid.index(i + a, j + b, k + c);
          if (wet(grid.type[m])) assert.ok(rooms.has(grid.room[m]), `${label} h=${hh} ${o.name}: 船外側が ${Lo.ROOMS[grid.room[m]]?.name} に接する`);
        }
      }
      // 開口は船外側を失わない（船首楼の後端扉は段の後ろの上甲板の上に船外側がある）
      for (const id of new Set(openings.map((o) => o.id))) {
        const ks = new Set(openings.filter((o) => o.id === id).map((o) => V.NODE_OPENING_OUT + o.k));
        assert.ok(grid.type.some((t) => ks.has(t)), `${label} h=${hh} ${id}: 船外側の格子点が無い`);
      }
    }
  }
});

// ---------- 空気圧・水圧による破断の穴 ----------
const unit = (v) => Math.abs(Math.hypot(...v) - 1) < 1e-6;
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

test('破断: 上甲板の穴は上向きの面、u・v・法線は直交する単位ベクトルで、その部屋の開口になる（名前・種類を引き継ぐ）', () => {
  const z = -40, p = [1.0, H.deckY(z), z];
  const b = ruptureAt(p, [0, 1, 0], 0.8, { kind: 'rupture', name: '破裂（士官室）' });
  assert.deepEqual(b.normal, [0, 1, 0]);
  for (const v of [b.u, b.v, b.normal]) assert.ok(unit(v));
  assert.ok(Math.abs(dot3(b.u, b.v)) < 1e-9 && Math.abs(dot3(b.u, b.normal)) < 1e-9 && Math.abs(dot3(b.v, b.normal)) < 1e-9);
  const { openings } = buildShipGrid(h, { ...allClosed, breaches: [b] });
  const o = openings.filter((x) => x.kind === 'rupture');
  assert.ok(o.length >= 1);
  assert.equal(Lo.ROOMS[o[0].room].name, '士官室');
  assert.equal(o[0].name, '破裂（士官室）');
  assert.ok(Math.abs(o.reduce((s, x) => s + x.area, 0) - 0.64) < 1e-9, '面積 0.8 × 0.8');
});

// 画質ごとの外板の点（格子の作成が重いので 2 つのテストで使い回す）
const envelopes = new Map();
const envelopeAt = (hh) => {
  if (!envelopes.has(hh)) {
    const { grid } = buildShipGrid(hh);
    const env = A.envelopePoints(grid, Lo.ROOMS.length, A.strengthOf([]));
    envelopes.set(hh, Array.from({ length: env.room.length }, (_, i) => A.envelopePoint(env, i)));
  }
  return envelopes.get(hh);
};

test('破断: 外板のどの点の穴も、格子の面の船外向きと同じ側を向く（艦尾の丸い先端で真横を向かない）', () => {
  // 再現: 船体の範囲の外（z < Z_MIN）で数値微分した法線は z 成分が捨てられて ±x になり、艦尾の先端の破断が横向きの穴になった。
  // 甲板の反りの段（格子の面は ±z、船外側の格子点は甲板の上）でも同じく、舷側の法線（±x）の横向きの穴になった
  let tip = 0;
  for (const hh of [0.42, 0.5, 0.6]) {
    let worst = 1, at = null;
    for (const pt of envelopeAt(hh)) {
      const b = ruptureAt(pt.p, pt.n, 0.8);
      const d = dot3(b.normal, pt.n);
      if (d < worst) { worst = d; at = pt; }
      if (pt.p[2] < H.Z_MIN) { tip++; assert.ok(b.normal[2] < -0.9, `h=${hh} 艦尾の先端 ${pt.p} の穴が後ろを向かない: ${b.normal}`); }
    }
    // 正しい曲面の法線でも、段になった格子の面とはほぼ直角（内積 0.007 程度）になることがあるので、しきい値は 0 にする
    assert.ok(worst > 0, `h=${hh} 最悪 ${worst.toFixed(3)} @ ${at?.p.map((v) => v.toFixed(2))} 格子 ${at?.n}`);
  }
  assert.ok(tip > 0, '艦尾の先端（z < Z_MIN）の外板の点が無い（テストの前提。格子の並びによっては無い画質もある）');
});

test('破断: 艦首・艦尾の絞りの舷側では、格子の面が段で ±z を向いていても、穴は外板に沿って横を向く', () => {
  // 再現: 曲面の法線と格子の向きの内積が 0.3 未満なら格子の向きにする判定で、絞りの舷側（外板はほぼ前後方向）の ±z の段の面の
  // 穴が真後ろ・真前を向き、破口のデカールが外板から垂直に突き出た
  for (const hh of [0.42, 0.5, 0.6]) {
    let n = 0;
    for (const pt of envelopeAt(hh)) {
      const [x, y, z] = pt.p;
      if (pt.n[2] === 0) continue;
      const hb = H.halfBreadth(z, y);
      // 外板の上かわずかに内側（甲板・船底から離れた舷側）で、外板がほぼ前後方向（半幅の z 方向の傾きが 0.15 未満 = 約 8.5° 以内）の点。
      // 外板よりわずかに外の段の面は、船内側へ 0.2 m 戻った点が船体の外になり格子の向きのまま（onHull の判定。別の既存の扱い）。
      // 上甲板より上（船首楼の舷側）は、後端壁の近くを格子の向きのままにする判定（fcWall）に入るので見ない
      if (!(Math.abs(x) <= hb && hb - Math.abs(x) < 0.1 && y > H.keelY(z) + 1 && y < H.upperY(z) - 0.5)) continue;
      if (!(Math.abs(H.halfBreadth(z + 0.25, y) - H.halfBreadth(z - 0.25, y)) / 0.5 < 0.15)) continue;
      n++;
      const b = ruptureAt(pt.p, pt.n, 0.8);
      // 外板の前後の傾きが 0.15 未満なので、穴の法線の z 成分も小さい（ビルジでは下向きの成分があるので y は見ない）
      assert.ok(Math.sign(x) * b.normal[0] > 0 && Math.abs(b.normal[2]) < 0.2, `h=${hh} ${pt.p.map((v) => v.toFixed(2))} 格子 ${pt.n}: 穴 ${b.normal.map((v) => v.toFixed(2))}`);
    }
    assert.ok(n > 0, `h=${hh} 絞りの舷側の ±z の段の面が無い（テストの前提）`);
  }
});

test('破断: 舷側の穴は船体の曲面の法線（外向き）を使い、格子の向き（±x）とほぼ同じ向き', () => {
  const z = 2, y = 2.2, x = -H.halfBreadth(z, y);
  const b = ruptureAt([x, y, z], [-1, 0, 0], 0.8);
  assert.ok(unit(b.normal) && b.normal[0] < -0.8, `${b.normal}`);
  assert.deepEqual(b.normal.map((c) => +c.toFixed(9)), H.surfaceNormal(x, y, z).map((c) => +c.toFixed(9)));
  const { openings } = buildShipGrid(h, { ...allClosed, breaches: [b] });
  assert.ok(openings.some((o) => o.kind === 'breach' && Lo.ROOMS[o.room].comp === 'B3'), '魚雷と同じ breach 扱い（種類を渡さなければ）');
});

test('破断: 船首楼の後端壁の穴は格子の向き（後ろ向き）のまま（段の角で船体の曲面の法線を数値微分しない）', () => {
  const b = ruptureAt([2, H.upperY(H.FC_Z) + 1.2, H.FC_Z], [0, 0, -1], 0.8);
  assert.deepEqual(b.normal, [0, 0, -1]);
  const { openings } = buildShipGrid(h, { ...allClosed, breaches: [b] });
  assert.ok(openings.length >= 1 && openings.every((o) => Lo.ROOMS[o.room].name === '船首楼 後部'), openings.map((o) => o.room).join());
});

// ---------- 開口の数の上限 ----------
test('上限: 開口が MAX_OPENINGS を超えたら、入らなかった片の数を dropped で知らせる（破断を開ける前に確かめるため）', () => {
  // 既定で開いている開口 9 つ + 両舷に 1.5 m おきの破口 34 個で上限を超える
  const breaches = [];
  for (let z = -11; z <= 13; z += 1.5) for (const s of [1, -1]) breaches.push(breachAt(s * H.halfBreadth(z, 2), 2, z, 1.0, 0.8));
  const full = buildShipGrid(h, { breaches });
  assert.equal(full.openings.length, V.MAX_OPENINGS);
  assert.ok(full.dropped > 0, `${full.dropped}`);
  // 入りきらない片は格子にも開口として残らない。MAX_OPENINGS = OUT − IN なので、あふれた片を IN + MAX_OPENINGS と書くと
  // 開口 0 の船外側（粒子を消す）になってしまう。種類の番号の範囲だけでは見分けられないので、元の格子点の側で確かめる:
  // 船内側は水の格子点（部屋あり）を開口の部屋のまま、船外側は船外の格子点（部屋なし）だけ
  for (let n = 0; n < full.grid.N; n++) {
    const t = full.grid.type[n], r = full.grid.room[n];
    if (t < V.NODE_OPENING_IN) continue;
    assert.ok(t < V.NODE_OPENING_OUT + V.MAX_OPENINGS, `種類 ${t}`);
    if (t < V.NODE_OPENING_OUT) assert.equal(r, full.openings[t - V.NODE_OPENING_IN].room, `船内側 ${t} の部屋`);
    else assert.equal(r, V.NO_ROOM, `船外側 ${t} に部屋 ${r} の水の格子点が入った`);
  }
  assert.ok(V.MAX_OPENINGS >= 32, '常設 11 + 魚雷の破口 + 破断の余裕');
  // 収まっていれば 0
  const fits = buildShipGrid(h, { breaches: breaches.slice(0, 1) });
  assert.equal(fits.dropped, 0);
  assert.equal(buildShipGrid(h, allClosed).dropped, 0);
});
