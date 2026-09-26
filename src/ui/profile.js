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

// 側面図の中での部屋の矩形。上段（第 2 甲板より上の居住区）は左舷・通路・右舷の 3 段に分けて描く
export function roomRect(r) {
  const b = r.box;
  const zc = (Math.max(b.z[0], H.Z_MIN) + Math.min(b.z[1], H.Z_MAX)) / 2;
  const z0 = Math.max(b.z[0], H.Z_MIN + 0.3), z1 = Math.min(b.z[1], H.Z_MAX - 0.6);
  let y0 = Lo.resolveY(b.y[0], zc), y1 = Lo.resolveY(b.y[1], zc);
  if (r.comp === 'H2' && y0 === Lo.DECK2) {
    const lane = b.x[0] >= 0.5 ? 2 : b.x[1] <= -0.5 ? 0 : 1; // 0 右舷, 1 通路, 2 左舷
    const hgt = (y1 - y0) / 3;
    y0 = y0 + lane * hgt; y1 = y0 + hgt;
  }
  return { z0, z1, y0, y1 };
}

// 部屋の中の文字の行（船体座標 m、文字の基線）: 名前は上端から 0.5 下、浸水率は下端から 0.2 上。
// 空気圧は名前の下の行に出す（名前と同じ行の右端だと、幅の狭い部屋では名前に、低い部屋では浸水率に重なる）。
// 3 行が入らない低い部屋（上段の居住区の 3 段、高さ 0.67 m）は null: 文字は出さず、部屋の色とツールチップで示す
export const PRES_ROW = 1.0; // 空気圧の行: 上端から
export const PRES_MIN_H = 1.8; // これより低い部屋には空気圧の行を置かない（名前・空気圧・浸水率の 3 行が入る高さ + 余裕）
export function pressureSlot(q) {
  return q.y1 - q.y0 >= PRES_MIN_H ? { x: q.z0 + 0.15, y: q.y1 - PRES_ROW } : null;
}

export function createProfile(svg, { onDoor }) {
  svg.setAttribute('viewBox', `${H.Z_MIN - 0.8} ${-Lo.HOUSE.top - 1.2} ${H.L + 1.6} ${Lo.HOUSE.top + 2.4}`);
  const g = el('g', { transform: 'scale(1,-1)' }, svg); // y を上向きに
  // 船体の外形
  const pts = [];
  for (let z = H.Z_MIN; z <= H.Z_MAX; z += 0.25) pts.push([z, H.deckY(z)]);
  for (let z = H.Z_MAX; z >= H.Z_MIN; z -= 0.25) { let y = H.keelY(z); if (H.halfBreadth(z, y + 0.01) < 0) { y = H.keelY(z) + 0.01; while (y < H.deckY(z) && H.halfBreadth(z, y) < 0) y += 0.05; } pts.push([z, y]); }
  el('path', { class: 'hull', d: 'M' + pts.map((p) => p.join(',')).join('L') + 'Z' }, g);
  el('rect', { class: 'hull', x: Lo.HOUSE.z0, y: H.D + 0.2, width: Lo.HOUSE.z1 - Lo.HOUSE.z0, height: Lo.HOUSE.top - H.D - 0.2 }, g);

  const rooms = Lo.ROOMS.map((r, i) => {
    const q = roomRect(r);
    const rect = el('rect', { class: 'room', x: q.z0, y: q.y0, width: q.z1 - q.z0, height: q.y1 - q.y0 }, g);
    const fill = el('rect', { class: 'fill', x: q.z0, y: q.y0, width: q.z1 - q.z0, height: 0 }, g);
    const title = el('title', {}, rect); title.textContent = r.name;
    const lab = el('text', { class: 'label', x: q.z0 + 0.15, y: -(q.y1 - 0.5), transform: 'scale(1,-1)' }, g);
    lab.textContent = r.name.replace('船室 ', '');
    const pct = el('text', { class: 'pct', x: q.z1 - 0.15, y: -(q.y0 + 0.2), 'text-anchor': 'end', transform: 'scale(1,-1)' }, g);
    // 閉じ込められた空気の圧力（ゲージ、bar）。大きいときだけ名前の下に出す（行が無い部屋はツールチップだけ）
    const slot = pressureSlot(q);
    const pres = slot && el('text', { class: 'pres', x: slot.x, y: -slot.y, transform: 'scale(1,-1)' }, g);
    return { i, q, rect, fill, pct, pres, title, name: r.name };
  });
  for (const z of Lo.BULKHEADS) el('line', { class: 'bulk', x1: z, x2: z, y1: H.TANK_TOP, y2: H.deckY(z) }, g);
  el('line', { class: 'bulk', x1: H.Z_MIN, x2: H.Z_MAX, y1: H.TANK_TOP, y2: H.TANK_TOP }, g);
  const wl = el('line', { class: 'wl', x1: H.Z_MIN - 0.8, x2: H.Z_MAX + 0.8 }, g);

  // 扉（水密扉と船外への開口）
  const doors = new Map();
  const addDoor = (id, z, y0, y1, title) => {
    const gg = el('g', { class: 'door' }, g);
    el('rect', { x: z - 0.28, y: y0, width: 0.56, height: y1 - y0, rx: 0.1 }, gg);
    el('title', {}, gg).textContent = title;
    // キーボードでも開閉できるように（左パネルと同じ操作をここからもできる）
    gg.setAttribute('tabindex', '0'); gg.setAttribute('role', 'button'); gg.setAttribute('aria-label', `${title}（開閉）`);
    gg.addEventListener('click', () => onDoor(id));
    gg.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onDoor(id); } });
    doors.set(id, gg);
  };
  for (const d of Lo.DOORS.filter((x) => x.wt)) addDoor(d.id, (d.box.z[0] + d.box.z[1]) / 2, Lo.resolveY(d.box.y[0], 0), Lo.resolveY(d.box.y[1], 0), d.name);
  for (const o of Lo.SEA_OPENINGS) {
    const z = o.center[2], y = o.center[1];
    if (o.kind === 'hatch' || o.kind === 'vent') addDoor(o.id, z, y - 0.15, y + 0.35, o.name);
    else addDoor(o.id, o.id === 'o5' ? z : z + (o.center[0] > 0 ? 0.35 : -0.35), y - o.half[1], y + o.half[1], o.name);
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
