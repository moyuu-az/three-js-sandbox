import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Lo from '../src/layout.js';
import { roomRect, pressureSlot, PRES_MIN_H } from '../src/ui/profile.js';

// 区画図の文字の行（船体座標 m、基線）。字の高さは styles.css の #profile .label / .pres（0.42）と .pct（0.5）
const NAME_BASE = (q) => q.y1 - 0.5, PCT_BASE = (q) => q.y0 + 0.2;
const CAP = 0.42 * 0.8, DESC = 0.42 * 0.25, PCT_CAP = 0.5 * 0.8;
const rects = Lo.ROOMS.map((r) => ({ name: r.name, q: roomRect(r) }));

// 空気圧の行が名前の行・浸水率の行のどちらとも重ならず、部屋の中にある
function assertOwnRow(name, q) {
  const s = pressureSlot(q);
  assert.ok(s, `${name}: 空気圧の行が無い`);
  assert.ok(s.y + CAP <= NAME_BASE(q) - DESC + 1e-9, `${name}: 空気圧が名前に重なる`);
  assert.ok(s.y - DESC >= PCT_BASE(q) + PCT_CAP - 1e-9, `${name}: 空気圧が浸水率に重なる`);
  assert.ok(s.x > q.z0 && s.x < q.z1, `${name}: 空気圧が部屋の外`);
}

test('区画図の空気圧: 置ける部屋では名前の下・浸水率の上の別の行にあり、どちらとも重ならない', () => {
  const placed = rects.filter(({ q }) => pressureSlot(q));
  assert.ok(placed.length >= 5, '高い部屋（船倉・機関室・甲板室など）には空気圧の行がある');
  for (const { name, q } of placed) assertOwnRow(name, q);
});

test('区画図の空気圧: 境界の高さ（PRES_MIN_H ちょうど）でも重ならず、それより低ければ行を置かない', () => {
  assertOwnRow('境界', { z0: 0, z1: 3, y0: 0, y1: PRES_MIN_H });
  assert.equal(pressureSlot({ z0: 0, z1: 3, y0: 0, y1: PRES_MIN_H - 0.01 }), null);
});

test('区画図の空気圧: 3 行が入らない低い部屋（上段の居住区の 3 段）には行を置かない（浸水率と同じ高さに重なるため）', () => {
  const low = rects.filter(({ q }) => q.y1 - q.y0 < 1);
  assert.ok(low.length > 0, '上段の居住区は 3 段に分けて低く描く');
  for (const { name, q } of low) assert.equal(pressureSlot(q), null, name);
});
