import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Lo from '../src/layout.js';
import { roomRect, pressureSlot, pctBase, PRES_MIN_H, STACK_MIN_H, FONT, NAME_ROW } from '../src/ui/profile.js';

// 区画図の文字の行（船体座標 m、基線）。字の高さは profile.js の FONT（描画も同じ値を属性に入れる）。
// 字の上端は基線の 0.8 字上、下端（ディセンダ）は 0.25 字下とみなす
const NAME_BASE = (q) => q.y1 - NAME_ROW, PCT_BASE = pctBase;
const CAP = FONT.pres * 0.8, DESC = FONT.label * 0.25, PCT_CAP = FONT.pct * 0.8;
const rects = Lo.ROOMS.map((r) => ({ name: r.name, q: roomRect(r) }));

// 空気圧の行が名前の行・浸水率の行のどちらとも重ならず、部屋の中にある
function assertOwnRow(name, q) {
  const s = pressureSlot(q);
  assert.ok(s, `${name}: 空気圧の行が無い`);
  assert.ok(s.y + CAP <= NAME_BASE(q) - DESC + 1e-9, `${name}: 空気圧が名前に重なる`);
  assert.ok(s.y - FONT.pres * 0.25 >= PCT_BASE(q) + PCT_CAP - 1e-9, `${name}: 空気圧が浸水率に重なる`);
  assert.ok(s.x > q.z0 && s.x < q.z1, `${name}: 空気圧が部屋の外`);
}

test('区画図の空気圧: 置ける部屋では名前の下・浸水率の上の別の行にあり、どちらとも重ならない', () => {
  const placed = rects.filter(({ q }) => pressureSlot(q));
  assert.ok(placed.length >= 10, `缶室・機械室・居住区など高い部屋には空気圧の行がある（${placed.length}）`);
  for (const { name, q } of placed) assertOwnRow(name, q);
});

test('区画図の空気圧: 境界の高さ（PRES_MIN_H ちょうど）でも重ならず、それより低ければ行を置かない', () => {
  assertOwnRow('境界', { z0: 0, z1: 8, y0: 0, y1: PRES_MIN_H });
  assert.equal(pressureSlot({ z0: 0, z1: 8, y0: 0, y1: PRES_MIN_H - 0.01 }), null);
});

test('区画図の空気圧: 3 行が入らない低い部屋（下甲板の下の弾薬庫・倉庫）には行を置かない', () => {
  const low = rects.filter(({ q }) => q.y1 - q.y0 < PRES_MIN_H);
  assert.ok(low.some(({ name }) => name === '後部弾薬庫'), '下甲板の下は低い');
  for (const { name, q } of low) assert.equal(pressureSlot(q), null, name);
});

// 字幅の目安: 全角 = 字の大きさ、半角（空白・数字・%）= 0.55 字
const textW = (str, size) => [...str].reduce((s, ch) => s + (/[ -~]/.test(ch) ? 0.55 : 1), 0) * size;

test('区画図の文字: 高い部屋では名前と浸水率を上下の別の行に置き、重ならない', () => {
  const tall = rects.filter(({ q }) => q.y1 - q.y0 >= STACK_MIN_H);
  assert.ok(tall.length >= 18, `${tall.length}`);
  for (const { name, q } of tall) assert.ok(NAME_BASE(q) - DESC >= PCT_BASE(q) + PCT_CAP - 1e-9, `${name}: 名前と浸水率が重なる`);
});

test('区画図の文字: 低い部屋（2 行が入らない）では浸水率を名前と同じ行の右端に置き、横に並べても部屋の幅に収まる', () => {
  const low = rects.filter(({ q }) => q.y1 - q.y0 < STACK_MIN_H);
  assert.ok(low.some(({ name }) => name === '後部倉庫'), '船尾は船底が高く、下甲板の下の倉庫は低い');
  for (const { name, q } of low) {
    assert.equal(PCT_BASE(q), NAME_BASE(q), name);
    assert.ok(textW(name, FONT.label) + textW('100%', FONT.pct) + 1.2 <= q.z1 - q.z0, `${name}: 名前と浸水率が横に並ばない`);
    assert.ok(NAME_BASE(q) - DESC >= q.y0 - 1e-9, `${name}: 名前が部屋の下にはみ出す`);
  }
});

test('区画図の文字: 名前はどの部屋でも部屋の幅に収まる', () => {
  for (const { name, q } of rects) assert.ok(textW(name, FONT.label) + 0.6 <= q.z1 - q.z0, `${name}: 幅が部屋 ${(q.z1 - q.z0).toFixed(1)} m に収まらない`);
});
