// 区画図（側面図）。部屋ごとの浸水率、海面の位置、水密扉（クリックで開閉）、破口を表示する。
// 座標は船体座標の (z, y) をそのまま SVG の (x, −y) に使う（単位 m）
import * as H from '../hull.js';
import * as Lo from '../layout.js';

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent = null) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.append(e);
  return e;
};

// 側面図の中での部屋の矩形（部屋はどれも艦の全幅なので、側面では重ならない）。船首・船尾の端は外形の線の内側に収める
export function roomRect(r) {
  const b = r.box;
  const z0 = Math.max(b.z[0], H.Z_MIN + 1.2), z1 = Math.min(b.z[1], H.Z_MAX - 2.5);
  const zc = (z0 + z1) / 2;
  return { z0, z1, y0: Math.max(Lo.resolveY(b.y[0], zc), H.keelY(zc)), y1: Lo.resolveY(b.y[1], zc) };
}

// 部屋の中の文字（船体座標 m）。字の大きさ（SSOT: 描画とテストが使う）と行の位置（基線）:
// 名前は上端から NAME_ROW 下、浸水率は下端から PCT_ROW 上。空気圧は名前の下の行（同じ行の右端だと幅の狭い部屋で名前に重なる）。
// 3 行が入らない部屋（下甲板の下の弾薬庫・倉庫）は空気圧の文字を出さず、部屋の色とツールチップで示す。
// 名前と浸水率の 2 行も入らない低い部屋（船尾の倉庫）は浸水率を名前と同じ行の右端に出す
export const FONT = { label: 0.9, pct: 1.0, pres: 0.9 };
export const NAME_ROW = 1.0, PCT_ROW = 0.35;
export const STACK_MIN_H = NAME_ROW + FONT.label * 0.25 + PCT_ROW + FONT.pct * 0.8; // 名前と浸水率を上下に分けて置ける高さ
// 浸水率の行の基線: 高い部屋は下端から PCT_ROW 上、低い部屋は名前と同じ行
export const pctBase = (q) => (q.y1 - q.y0 >= STACK_MIN_H ? q.y0 + PCT_ROW : q.y1 - NAME_ROW);
export const PRES_ROW = 2.05; // 空気圧の行: 上端から
export const PRES_MIN_H = 3.43; // これより低い部屋には空気圧の行を置かない（名前・空気圧・浸水率の 3 行が入る高さ）
export function pressureSlot(q) {
  return q.y1 - q.y0 >= PRES_MIN_H ? { x: q.z0 + 0.3, y: q.y1 - PRES_ROW } : null;
}

export function createProfile(svg, { onDoor }) {
  svg.setAttribute('viewBox', `${H.Z_MIN - 1.5} ${-H.Y_MAX - 1.2} ${H.L + 3} ${H.Y_MAX + 2.4}`);
  const g = el('g', { transform: 'scale(1,-1)' }, svg); // y を上向きに
  // 船体の外形
  const pts = [];
  for (const z of H.stations(520)) pts.push([z, H.deckY(z)]);
  for (let z = H.Z_MAX; z >= H.Z_MIN; z -= 0.25) { let y = H.keelY(z); if (H.halfBreadth(z, y + 0.01) < 0) { y = H.keelY(z) + 0.01; while (y < H.deckY(z) && H.halfBreadth(z, y) < 0) y += 0.05; } pts.push([z, y]); }
  el('path', { class: 'hull', d: 'M' + pts.map((p) => p.join(',')).join('L') + 'Z' }, g);

  const rooms = Lo.ROOMS.map((r, i) => {
    const q = roomRect(r);
    const rect = el('rect', { class: 'room', x: q.z0, y: q.y0, width: q.z1 - q.z0, height: q.y1 - q.y0 }, g);
    const fill = el('rect', { class: 'fill', x: q.z0, y: q.y0, width: q.z1 - q.z0, height: 0 }, g);
    const title = el('title', {}, rect); title.textContent = r.name;
    const lab = el('text', { class: 'label', x: q.z0 + 0.3, y: -(q.y1 - NAME_ROW), 'font-size': FONT.label, transform: 'scale(1,-1)' }, g);
    lab.textContent = r.name;
    const pct = el('text', { class: 'pct', x: q.z1 - 0.3, y: -pctBase(q), 'font-size': FONT.pct, 'text-anchor': 'end', transform: 'scale(1,-1)' }, g);
    // 閉じ込められた空気の圧力（ゲージ、bar）。大きいときだけ名前の下に出す（行が無い部屋はツールチップだけ）
    const slot = pressureSlot(q);
    const pres = slot && el('text', { class: 'pres', x: slot.x, y: -slot.y, 'font-size': FONT.pres, transform: 'scale(1,-1)' }, g);
    return { i, q, rect, fill, pct, pres, title, name: r.name };
  });
  for (const z of Lo.BULKHEADS) el('line', { class: 'bulk', x1: z, x2: z, y1: Math.max(H.TANK_TOP, H.keelY(z)), y2: H.upperY(z) }, g);
  el('line', { class: 'bulk', x1: Lo.MACHINERY.z[0], x2: Lo.MACHINERY.z[1], y1: H.TANK_TOP, y2: H.TANK_TOP }, g);
  const wl = el('line', { class: 'wl', x1: H.Z_MIN - 1.5, x2: H.Z_MAX + 1.5 }, g);

  // 扉（水密扉と船外への開口）
  const doors = new Map();
  const addDoor = (id, z, y0, y1, title) => {
    const gg = el('g', { class: 'door' }, g);
    el('rect', { x: z - 0.6, y: y0, width: 1.2, height: y1 - y0, rx: 0.2 }, gg);
    el('title', {}, gg).textContent = title;
    // キーボードでも開閉できるように（左パネルと同じ操作をここからもできる）
    gg.setAttribute('tabindex', '0'); gg.setAttribute('role', 'button'); gg.setAttribute('aria-label', `${title}（開閉）`);
    gg.addEventListener('click', () => onDoor(id));
    gg.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onDoor(id); } });
    doors.set(id, gg);
  };
  for (const d of Lo.DOORS.filter((x) => x.wt)) { const zc = (d.box.z[0] + d.box.z[1]) / 2; addDoor(d.id, zc, Lo.resolveY(d.box.y[0], zc), Lo.resolveY(d.box.y[1], zc), d.name); }
  for (const o of Lo.SEA_OPENINGS) {
    const z = o.center[2], y = o.center[1];
    if (o.normal[1] > 0.5) addDoor(o.id, z, y - 0.3, y + 0.7, o.name); // 露天甲板の開口
    else addDoor(o.id, z + (o.center[0] > 0 ? 0.7 : -0.7), y - o.half[1], y + o.half[1], o.name); // 船首楼の後端の扉（左右の舷で並べる）
  }
  const breachLayer = el('g', {}, g);

  function update({ fills, hot, waterline, doorStates, breaches, pressures = [] }) {
    for (const r of rooms) {
      const f = Math.max(0, Math.min(1, fills[r.i] ?? 0));
      const hh = (r.q.y1 - r.q.y0) * f;
      r.fill.setAttribute('height', hh.toFixed(3));
      r.pct.textContent = f > 0.005 ? `${Math.round(f * 100)}%` : '';
      const p = pressures[r.i] ?? 0;
      const pt = Math.abs(p) >= 0.05 ? `${p > 0 ? '+' : '−'}${Math.abs(p).toFixed(2)} bar` : '';
      if (r.pres) r.pres.textContent = pt;
      const tip = pt ? `${r.name}（空気 ${pt}）` : r.name;
      if (r.title.textContent !== tip) r.title.textContent = tip;
      r.rect.classList.toggle('pressed', p >= 0.05);
      r.rect.classList.toggle('hot', !!hot[r.i]);
    }
    // 横倒し（横傾斜 90°）付近では船体座標への換算が発散する（±Infinity / NaN を属性に入れると SVG のエラーになる）
    const wlOk = waterline && waterline.every(Number.isFinite);
    wl.style.display = wlOk ? '' : 'none';
    if (wlOk) { wl.setAttribute('y1', waterline[0]); wl.setAttribute('y2', waterline[1]); }
    for (const [id, gg] of doors) { const open = !!doorStates[id]; gg.classList.toggle('open', open); gg.classList.toggle('closed', !open); }
    if (breachLayer.childElementCount !== breaches.length) {
      breachLayer.replaceChildren();
      for (const b of breaches) el('ellipse', { class: 'breach', cx: b.center[2], cy: b.center[1], rx: b.half[0], ry: b.half[1] }, breachLayer);
    }
  }
  return { update };
}
