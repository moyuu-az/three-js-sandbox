// 船内配置の SSOT: 水密隔壁・甲板・部屋・扉・ハッチ・機器。流体格子（shipgrid.js）と 3D モデル（render/interior.js）がここを参照する。
// 座標は hull.js と同じ（+z 船首, +y 上, +x 左舷, 原点 = 船体中央のキール）。
import { Z_MIN, Z_MAX, TANK_TOP, deckY } from './hull.js';

const INF = 99;
export const DECK2 = 3.0; // 第 2 甲板
export const BULKHEADS = [-12.5, -4.5, 4.0, 11.5]; // 水密隔壁（上甲板まで達する）
// 甲板室（上甲板の上、船尾寄り）。この 1 層目までを浸水の対象にする（船橋は描画のみ）
export const HOUSE = { z0: -12.5, z1: -4.5, hw: 2.7, top: 7.75 };
export const houseFloor = (z) => deckY(z);

// 水密区画（UI の区画表示と説明用）
export const COMPARTMENTS = [
  { id: 'AP', name: '船尾区画', z: [Z_MIN, BULKHEADS[0]] },
  { id: 'ER', name: '機関室区画', z: [BULKHEADS[0], BULKHEADS[1]] },
  { id: 'H2', name: '第2船倉・居住区画', z: [BULKHEADS[1], BULKHEADS[2]] },
  { id: 'H1', name: '第1船倉区画', z: [BULKHEADS[2], BULKHEADS[3]] },
  { id: 'FP', name: '船首区画', z: [BULKHEADS[3], Z_MAX] },
  { id: 'DH', name: '甲板室', z: [HOUSE.z0, HOUSE.z1] },
];

// 部屋。box の y 上限 'deck' は上甲板の下面まで。先に書いたものが優先される
const B2 = BULKHEADS;
export const ROOMS = [
  { name: '操舵機室', comp: 'AP', box: { x: [-INF, INF], y: [TANK_TOP, 'deck'], z: [Z_MIN, B2[0]] } },
  { name: '機関室', comp: 'ER', box: { x: [-INF, INF], y: [TANK_TOP, 'deck'], z: [B2[0], B2[1]] } },
  { name: '第2船倉', comp: 'H2', box: { x: [-INF, INF], y: [TANK_TOP, DECK2], z: [B2[1], B2[2]] } },
  { name: '通路', comp: 'H2', box: { x: [-0.6, 0.6], y: [DECK2, 'deck'], z: [B2[1], B2[2]] } },
  { name: '船室 左1', comp: 'H2', box: { x: [0.6, INF], y: [DECK2, 'deck'], z: [B2[1], -1.7] } },
  { name: '船室 左2', comp: 'H2', box: { x: [0.6, INF], y: [DECK2, 'deck'], z: [-1.7, 1.2] } },
  { name: '船室 左3', comp: 'H2', box: { x: [0.6, INF], y: [DECK2, 'deck'], z: [1.2, B2[2]] } },
  { name: '船室 右1', comp: 'H2', box: { x: [-INF, -0.6], y: [DECK2, 'deck'], z: [B2[1], -0.3] } },
  { name: '食堂', comp: 'H2', box: { x: [-INF, -0.6], y: [DECK2, 'deck'], z: [-0.3, B2[2]] } },
  { name: '第1船倉', comp: 'H1', box: { x: [-INF, INF], y: [TANK_TOP, 'deck'], z: [B2[2], B2[3]] } },
  { name: '船首倉庫', comp: 'FP', box: { x: [-INF, INF], y: [TANK_TOP, 'deck'], z: [B2[3], Z_MAX] } },
  { name: 'サロン', comp: 'DH', box: { x: [-HOUSE.hw, HOUSE.hw], y: ['deck', HOUSE.top], z: [HOUSE.z0, -8.5] } },
  { name: '調理室', comp: 'DH', box: { x: [-HOUSE.hw, HOUSE.hw], y: ['deck', HOUSE.top], z: [-8.5, HOUSE.z1] } },
];

// 扉とハッチ（船内の仕切りの開口）。wt = 水密扉（開閉できる）。box はこの範囲の壁・甲板を抜く
export const DOORS = [
  { id: 'D1', name: '水密扉 機関室↔通路', wt: true, open: true, box: { x: [-0.4, 0.4], y: [DECK2, DECK2 + 2.0], z: [B2[1] - 0.2, B2[1] + 0.2] } },
  { id: 'D2', name: '水密扉 通路↔第1船倉', wt: true, open: false, box: { x: [-0.4, 0.4], y: [DECK2, DECK2 + 2.0], z: [B2[2] - 0.2, B2[2] + 0.2] } },
  { id: 'D3', name: '水密扉 機関室↔操舵機室', wt: true, open: false, box: { x: [-2.2, -1.4], y: [TANK_TOP, TANK_TOP + 2.0], z: [B2[0] - 0.2, B2[0] + 0.2] } },
  // 以下は常に開いている（非水密）
  { id: 'c1', name: '船室 左1 扉', box: { x: [0.4, 0.8], y: [DECK2, DECK2 + 1.9], z: [-3.5, -2.7] } },
  { id: 'c2', name: '船室 左2 扉', box: { x: [0.4, 0.8], y: [DECK2, DECK2 + 1.9], z: [-0.65, 0.15] } },
  { id: 'c3', name: '船室 左3 扉', box: { x: [0.4, 0.8], y: [DECK2, DECK2 + 1.9], z: [2.2, 3.0] } },
  { id: 'c4', name: '船室 右1 扉', box: { x: [-0.8, -0.4], y: [DECK2, DECK2 + 1.9], z: [-2.8, -2.0] } },
  { id: 'c5', name: '食堂 扉', box: { x: [-0.8, -0.4], y: [DECK2, DECK2 + 1.9], z: [1.5, 2.3] } },
  { id: 'h1', name: '船倉ラッタル口', box: { x: [-0.5, 0.5], y: [DECK2 - 0.3, DECK2 + 0.3], z: [-3.9, -3.1] } },
  { id: 'h2', name: '機関室ケーシング', box: { x: [-1.6, 1.6], y: [DECK2 - 0.3, DECK2 + 0.3], z: [-10.8, -6.2] } },
  { id: 'h3', name: '第1船倉 中甲板ハッチ', box: { x: [-2.0, 2.0], y: [DECK2 - 0.3, DECK2 + 0.3], z: [5.5, 10.0] } },
  { id: 'h4', name: '甲板室 階段', box: { x: [1.2, 2.2], y: [4.5, 5.8], z: [-10.0, -9.0] } },
  { id: 'h5', name: '甲板室 内扉', box: { x: [-0.45, 0.45], y: ['deck', 'deck+2.0'], z: [-8.7, -8.3] } },
];

// 構造の板（1 格子点の厚さで固体になる）。axis の座標 at、span の範囲。at: 'deck' は上甲板（舷弧に沿う）
export const PLATES = [
  ...BULKHEADS.map((z) => ({ axis: 'z', at: z, span: { x: [-INF, INF], y: [TANK_TOP, 'deck'] } })),
  { axis: 'y', at: DECK2, span: { x: [-INF, INF], z: [B2[0], B2[3]] } }, // 第 2 甲板（機関室・船倉区画）
  { axis: 'x', at: 0.6, span: { y: [DECK2, 'deck'], z: [B2[1], B2[2]] } }, // 通路の壁
  { axis: 'x', at: -0.6, span: { y: [DECK2, 'deck'], z: [B2[1], B2[2]] } },
  { axis: 'z', at: -1.7, span: { x: [0.6, INF], y: [DECK2, 'deck'] } }, // 船室の仕切り
  { axis: 'z', at: 1.2, span: { x: [0.6, INF], y: [DECK2, 'deck'] } },
  { axis: 'z', at: -0.3, span: { x: [-INF, -0.6], y: [DECK2, 'deck'] } },
  { axis: 'deck', span: { x: [-HOUSE.hw, HOUSE.hw], z: [HOUSE.z0, HOUSE.z1] } }, // 甲板室の床（上甲板）
  { axis: 'z', at: -8.5, span: { x: [-HOUSE.hw, HOUSE.hw], y: ['deck', HOUSE.top] } }, // 甲板室の仕切り
];

// 機器・貨物（水が入らない塊）
export const OBSTACLES = [
  { name: '主機関', box: { x: [-1.1, 1.1], y: [TANK_TOP, 2.6], z: [-10.5, -6.5] } },
  { name: '発電機', box: { x: [1.8, 2.8], y: [TANK_TOP, 1.9], z: [-8.0, -5.8] } },
  { name: '貨物', box: { x: [-3.0, -1.0], y: [TANK_TOP, 2.1], z: [-3.0, 0.0] } },
  { name: '貨物', box: { x: [0.6, 2.8], y: [TANK_TOP, 2.4], z: [5.0, 8.0] } },
  { name: '貨物', box: { x: [-2.8, -0.6], y: [TANK_TOP, 1.8], z: [7.0, 10.0] } },
];

// 船外への開口（常設）。center は開口の中心、normal は船外向き、u/v は開口面の軸、half は半幅
export const SEA_OPENINGS = [
  { id: 'o1', name: '船首倉庫ハッチ', kind: 'hatch', open: true, center: [0, deckY(12.8), 12.8], normal: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1], half: [0.45, 0.45] },
  { id: 'o2', name: '居住区 昇降口', kind: 'hatch', open: true, center: [0, deckY(3.3), 3.3], normal: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1], half: [0.45, 0.4] },
  { id: 'o3', name: '甲板室 左舷扉', kind: 'door', open: true, center: [HOUSE.hw, deckY(-7) + 1.3, -7], normal: [1, 0, 0], u: [0, 0, 1], v: [0, 1, 0], half: [0.45, 1.0] },
  { id: 'o4', name: '甲板室 右舷扉', kind: 'door', open: true, center: [-HOUSE.hw, deckY(-7) + 1.3, -7], normal: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0], half: [0.45, 1.0] },
  { id: 'o5', name: '甲板室 前面扉', kind: 'door', open: true, center: [0, deckY(HOUSE.z1) + 1.3, HOUSE.z1], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], half: [0.45, 1.0] },
  // 通風筒（甲板上のきのこ形の筒の下の開口）。沈んで船尾が立ったとき、最後に機関室・操舵機室へ水が入る経路
  { id: 'o6', name: '機関室 通風筒', kind: 'vent', open: true, center: [3.05, deckY(-6.2), -6.2], normal: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1], half: [0.25, 0.25] },
  { id: 'o7', name: '操舵機室 通風筒', kind: 'vent', open: true, center: [1.5, deckY(-13.8), -13.8], normal: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1], half: [0.25, 0.25] },
];

// 外板が破れる内外の圧力差 [Pa]（外向きの破裂・内向きの圧潰とも）。長さ 30 m 級の鋼船の目安:
//   外板（肋骨 0.6 m 間隔・板厚 8〜10 mm）は塑性崩壊まで ~0.3 MPa、上甲板 ~0.15 MPa、甲板室の壁（板厚 5 mm 程度）~60 kPa。
//   閉じたハッチ蓋・扉・通風筒の蓋は締め付け金具が先に外れるので最も弱い（~50 kPa）
export const STRENGTH = { hull: 300e3, deck: 150e3, house: 60e3, closure: 50e3 };

// 'deck' / 'deck+Δ' を z での高さに解決する
export function resolveY(v, z) {
  if (typeof v === 'number') return v;
  if (v === 'deck') return deckY(z);
  const m = /^deck\+([\d.]+)$/.exec(v);
  if (m) return deckY(z) + Number(m[1]);
  throw new Error(`layout: unknown y spec ${v}`);
}

export function inBox(box, x, y, z, pad = 0) {
  return x >= box.x[0] - pad && x <= box.x[1] + pad && z >= box.z[0] - pad && z <= box.z[1] + pad &&
    y >= resolveY(box.y[0], z) - pad && y <= resolveY(box.y[1], z) + pad;
}

export const inHouse = (x, y, z) => Math.abs(x) <= HOUSE.hw && z >= HOUSE.z0 && z <= HOUSE.z1 && y >= deckY(z) && y <= HOUSE.top;

// 位置が属する部屋の番号（無ければ -1）
export function roomAt(x, y, z) {
  for (let r = 0; r < ROOMS.length; r++) if (inBox(ROOMS[r].box, x, y, z)) return r;
  return -1;
}

export const compOfRoom = (r) => ROOMS[r].comp;
