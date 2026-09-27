// 艦内配置の SSOT: 水密隔壁・甲板・部屋・扉・ハッチ・機器。流体格子（shipgrid.js）と 3D モデル（render/shipModel.js）がここを参照する。
// 座標は hull.js と同じ（+z 船首, +y 上, +x 左舷, 原点 = 船体中央のキール）。
//
// 駆逐艦 島風（1943）。出典と推定の区別:
//   寸法（全長 129.5 m・水線長 126.0 m・幅 11.2 m・深さ 7.02 m・喫水 4.14 m・公試排水量 3,048 t）・機関（ロ号艦本式缶 3 基・
//   タービン 2 基 2 軸）・兵装（12.7 cm 連装砲 3 基・61 cm 五連装魚雷発射管 3 基）は公開資料（Wikipedia 日英・navypedia）。
//   艦内の区画配置の公開資料は見つからなかったので、原型の陽炎型の系譜（缶は 1 基ずつ別の缶室、1・2 号缶の煙路は前部煙突へ、
//   タービンは前後に並ぶ: navypedia）に沿って推定した。隔壁の位置は 1 区画 8〜10 m の推定値。
//   強化（実艦と違う点）: 実艦の共通の機械室を中央の水密隔壁で前後に分け（タービン 1 基ずつ。松型のシフト配置の考え方）、
//   区画をまたぐ水密扉・水密ハッチは既定ですべて閉じる（戦闘配置）。
import { Z_MIN, Z_MAX, TANK_TOP, FC_Z, deckY, upperY } from './hull.js';

const INF = 99;
export const LOWER = 3.6; // 下甲板（機関区画の前後。上甲板との間が居住区、下が弾薬庫・倉庫）
// 水密隔壁（二重底から上甲板まで）。船首から: 衝突隔壁 / 倉庫 / 弾薬庫 / 糧食庫 / 重油タンク | 缶室 3 / 機械室 2 | 補機室 /
// 重油タンク / 弾薬庫 / 倉庫 / 操舵機室。z = FC_Z の隔壁の上は船首楼の後端壁（外殻）
export const BULKHEADS = [58, 50, 40, 30, FC_Z, 12, 3, -6, -14, -22, -30, -38, -48, -57];
const [K1, K2, K3, K4, K5, K6, K7, K8, K9, K10, K11, K12, K13, K14] = BULKHEADS;
export const MACHINERY = { z: [K10, K5] }; // 缶室・機械室（下甲板が無く、二重底から上甲板まで吹き抜け）

// 水密区画（UI の区画表示と説明用）。船首楼（上甲板より上）は隔壁甲板より上なので 1 つにまとめる
export const COMPARTMENTS = [
  { id: 'FP', name: '船首区画', z: [K1, Z_MAX] },
  { id: 'F1', name: '前部倉庫区画', z: [K2, K1] },
  { id: 'F2', name: '前部弾薬庫区画', z: [K3, K2] },
  { id: 'F3', name: '前部糧食庫区画', z: [K4, K3] },
  { id: 'F4', name: '前部重油タンク区画', z: [K5, K4] },
  { id: 'B1', name: '第1缶室', z: [K6, K5] },
  { id: 'B2', name: '第2缶室', z: [K7, K6] },
  { id: 'B3', name: '第3缶室', z: [K8, K7] },
  { id: 'E1', name: '前部機械室', z: [K9, K8] },
  { id: 'E2', name: '後部機械室', z: [K10, K9] },
  { id: 'A1', name: '補機室区画', z: [K11, K10] },
  { id: 'A2', name: '後部重油タンク区画', z: [K12, K11] },
  { id: 'A3', name: '後部弾薬庫区画', z: [K13, K12] },
  { id: 'A4', name: '後部倉庫区画', z: [K14, K13] },
  { id: 'AP', name: '操舵機室', z: [Z_MIN, K14] },
  { id: 'FC', name: '船首楼', z: [FC_Z, Z_MAX] },
];

// 部屋（MAX_ROOMS − 1 = 31 まで）。box の y の 'upper' は上甲板、'deck' は最も上の甲板（船首楼では船首楼甲板）。先に書いたものが優先される
const hold = (name, comp, z) => ({ name, comp, box: { x: [-INF, INF], y: [TANK_TOP, LOWER], z } });
const tween = (name, comp, z) => ({ name, comp, box: { x: [-INF, INF], y: [LOWER, 'upper'], z } });
const full = (name, comp, z) => ({ name, comp, box: { x: [-INF, INF], y: [TANK_TOP, 'upper'], z } });
export const ROOMS = [
  full('錨鎖庫', 'FP', [K1, Z_MAX]),
  full('前部倉庫', 'F1', [K2, K1]), // 船首は船底が高く狭いので下甲板で分けない
  hold('前部弾薬庫', 'F2', [K3, K2]), tween('前部兵員室 1', 'F2', [K3, K2]),
  hold('前部糧食庫', 'F3', [K4, K3]), tween('前部兵員室 2', 'F3', [K4, K3]),
  tween('発電機室', 'F4', [K5, K4]), // 下は重油タンク（OBSTACLES）
  full('第1缶室', 'B1', [K6, K5]), full('第2缶室', 'B2', [K7, K6]), full('第3缶室', 'B3', [K8, K7]),
  full('前部機械室', 'E1', [K9, K8]), full('後部機械室', 'E2', [K10, K9]),
  hold('補機室', 'A1', [K11, K10]), tween('後部兵員室 1', 'A1', [K11, K10]),
  tween('後部兵員室 2', 'A2', [K12, K11]), // 下は重油タンク
  hold('後部弾薬庫', 'A3', [K13, K12]), tween('士官室', 'A3', [K13, K12]),
  hold('後部倉庫', 'A4', [K14, K13]), tween('艦長室', 'A4', [K14, K13]),
  full('操舵機室', 'AP', [Z_MIN, K14]),
  { name: '船首楼 前部', comp: 'FC', box: { x: [-INF, INF], y: ['upper', 'deck'], z: [K3, Z_MAX] } },
  { name: '船首楼 後部', comp: 'FC', box: { x: [-INF, INF], y: ['upper', 'deck'], z: [FC_Z, K3] } },
];

// 扉とハッチ（艦内の仕切りの開口）。wt = 水密（開閉できる。既定は閉 = 戦闘配置）。box はこの範囲の壁・甲板を抜く。
// 流体格子（h = 0.5 m）で 3 格子点の幅になるよう、実物（幅 0.6〜0.7 m）より大きい。2 点（幅 1.1 m）だと粒子が壁から離れる分で
// 通り道が細り、扉の両側の水位がそろうのに 25 秒でも足りない（dev/fluid-selftest の「扉」「空気圧」）
const wtDoor = (id, name, z, y0, x = 0) => ({ id, name, wt: true, open: false, box: { x: [x - 0.8, x + 0.8], y: [y0, y0 + 1.9], z: [z - 0.3, z + 0.3] } });
const yAround = (y) => (typeof y === 'number' ? [y - 0.4, y + 0.4] : [`${y}-0.4`, `${y}+0.4`]);
const hatch = (id, name, y, z, x, wt = false) => ({ id, name, ...(wt ? { wt, open: false } : {}), box: { x: [x - 0.6, x + 0.6], y: yAround(y), z: [z - 0.6, z + 0.6] } });
export const DOORS = [
  wtDoor('D1', '水密扉 前部倉庫↔前部兵員室 1', K2, LOWER),
  wtDoor('D2', '水密扉 前部兵員室 1↔2', K3, LOWER),
  wtDoor('D3', '水密扉 前部↔後部機械室', K9, TANK_TOP, -1.8),
  wtDoor('D4', '水密扉 後部兵員室 1↔2', K11, LOWER),
  wtDoor('D5', '水密扉 後部兵員室 2↔士官室', K12, LOWER),
  wtDoor('D6', '水密扉 士官室↔艦長室', K13, LOWER),
  hatch('D7', '水密ハッチ 前部兵員室 1↔船首楼', 'upper', 45, 1.6, true),
  hatch('D8', '水密ハッチ 前部兵員室 2↔船首楼', 'upper', 35, 1.6, true),
  // 以下は常に開いている（非水密）。下甲板の昇降口: 同じ水密区画の中の上下の部屋をつなぐ
  hatch('h2', '前部弾薬庫 揚弾口', LOWER, 44, 0),
  hatch('h3', '前部糧食庫 昇降口', LOWER, 35, -1.6),
  hatch('h4', '補機室 昇降口', LOWER, -26, 1.6),
  hatch('h5', '後部弾薬庫 揚弾口', LOWER, -43, 0),
  hatch('h6', '後部倉庫 昇降口', LOWER, -52, -1.6),
  { id: 'c1', name: '船首楼 仕切り扉', box: { x: [-0.55, 0.55], y: ['upper', 'upper+1.9'], z: [K3 - 0.3, K3 + 0.3] } },
];

// 構造の板（1 格子点の厚さで固体になる）。axis の座標 at、span の範囲。y の at に 'upper' を使うと上甲板（舷弧に沿う）
export const PLATES = [
  ...BULKHEADS.map((z) => ({ axis: 'z', at: z, span: { x: [-INF, INF], y: [TANK_TOP, 'upper'] } })),
  { axis: 'y', at: LOWER, span: { x: [-INF, INF], z: [K5, K2] } }, // 下甲板（前部）
  { axis: 'y', at: LOWER, span: { x: [-INF, INF], z: [K14, K10] } }, // 下甲板（後部）
  { axis: 'y', at: 'upper', span: { x: [-INF, INF], z: [FC_Z, Z_MAX] } }, // 船首楼の下の上甲板（隔壁甲板）
  { axis: 'z', at: K3, span: { x: [-INF, INF], y: ['upper', 'deck'] } }, // 船首楼の仕切り（非水密）
];

// 機器・タンク（水が入らない塊）。缶は ロ号艦本式缶（幅 ~4 m・高さ ~5 m の推定）、タービンと減速装置は 1 軸分ずつ
export const OBSTACLES = [
  { name: '重油タンク', box: { x: [-INF, INF], y: [TANK_TOP, LOWER], z: [K5, K4] } },
  { name: '重油タンク', box: { x: [-INF, INF], y: [TANK_TOP, LOWER], z: [K12, K11] } },
  { name: 'ボイラー', box: { x: [-2.0, 2.0], y: [TANK_TOP, 5.8], z: [K6 + 2.0, K5 - 1.6] } },
  { name: 'ボイラー', box: { x: [-2.0, 2.0], y: [TANK_TOP, 5.8], z: [K7 + 2.0, K6 - 1.6] } },
  { name: 'ボイラー', box: { x: [-2.0, 2.0], y: [TANK_TOP, 5.8], z: [K8 + 2.0, K7 - 1.6] } },
  // 前部・後部機械室の間の隔壁（水密扉 D3）沿いは 2 m 空ける（通路）。扉のすぐ裏に機械の塊があると、水が細いすき間を回り込むしか
  // なく、扉を開けても両室の水位がそろわない（dev/fluid-selftest の「扉」）
  { name: 'タービン', box: { x: [0.4, 3.4], y: [TANK_TOP, 3.4], z: [K9 + 2.0, K8 - 1.0] } },
  { name: 'タービン', box: { x: [-3.4, -0.4], y: [TANK_TOP, 3.4], z: [K10 + 1.0, K9 - 2.0] } },
  { name: '弾薬', box: { x: [-3.0, 3.0], y: [TANK_TOP, 2.6], z: [K3 + 1.2, K2 - 1.2] } },
  { name: '弾薬', box: { x: [-3.0, 3.0], y: [TANK_TOP, 2.6], z: [K13 + 1.2, K12 - 1.2] } },
];

// 船外への開口（常設）。center は開口の中心、normal は船外向き、u/v は開口面の軸、half は半幅
const deckHole = (id, name, kind, z, x, open, half = [0.6, 0.6]) => ({ id, name, kind, open, center: [x, deckY(z), z], normal: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1], half });
const fcDoor = (id, name, x) => ({ id, name, kind: 'door', open: true, center: [x, upperY(FC_Z) + 1.0, FC_Z], normal: [0, 0, -1], u: [1, 0, 0], v: [0, 1, 0], half: [0.55, 0.95] });
export const SEA_OPENINGS = [
  deckHole('o1', '船首楼 前部 昇降口', 'hatch', 47, -1.6, true),
  fcDoor('o2', '船首楼 後端 左舷扉', 3.2),
  fcDoor('o3', '船首楼 後端 右舷扉', -3.2),
  // 缶は運転中、燃焼用の空気を缶室へ大量に送り込む（缶室を密閉して送風機で加圧する）。給気口は閉じない前提で既定は開
  deckHole('o4', '第1缶室 給気口', 'vent', 16.5, 3.8, true, [0.6, 0.9]),
  deckHole('o5', '第2缶室 給気口', 'vent', 7.5, -3.8, true, [0.6, 0.9]),
  deckHole('o6', '第3缶室 給気口', 'vent', -1.5, 3.8, true, [0.6, 0.9]),
  deckHole('o7', '前部機械室 天窓', 'hatch', -10, -2.6, true, [0.8, 1.2]),
  deckHole('o8', '後部機械室 天窓', 'hatch', -18, 2.6, false, [0.8, 1.2]),
  deckHole('o9', '後部兵員室 昇降口', 'hatch', -27, -2.4, true),
  deckHole('o10', '士官室 昇降口', 'hatch', -45, 2.4, true),
  deckHole('o11', '操舵機室 ハッチ', 'hatch', -60, 0, false),
];

// 外板が破れる内外の圧力差 [Pa]（外向きの破裂・内向きの圧潰とも）。推定値:
//   外板は高張力鋼（D 鋼、降伏点が軟鋼の ~1.4 倍）の 8〜12 mm で肋骨間隔も狭い。塑性崩壊まで ~0.4 MPa（前の 30 m 級の貨物船の 0.3 MPa より強い）。
//   上甲板 ~0.25 MPa。閉じたハッチ蓋・水密扉は締め付け金具（ドッグ）で押さえるので最も弱いが、隔壁甲板の水頭に耐える設計で ~0.1 MPa
export const STRENGTH = { hull: 400e3, deck: 250e3, closure: 100e3 };

// 'upper' / 'deck' / 'upper+Δ' / 'upper-Δ' を z での高さに解決する
export function resolveY(v, z) {
  if (typeof v === 'number') return v;
  // 数値の部分は厳密に（'upper+1.2.3' を Number() が NaN にすると、比較が全部偽になって板・部屋が黙って消える）
  const m = /^(upper|deck)(?:([+-])(\d+(?:\.\d+)?))?$/.exec(v);
  if (!m) throw new Error(`layout: unknown y spec ${v}`);
  const base = m[1] === 'upper' ? upperY(z) : deckY(z);
  return m[2] ? base + (m[2] === '+' ? 1 : -1) * Number(m[3]) : base;
}

export function inBox(box, x, y, z, pad = 0) {
  return x >= box.x[0] - pad && x <= box.x[1] + pad && z >= box.z[0] - pad && z <= box.z[1] + pad &&
    y >= resolveY(box.y[0], z) - pad && y <= resolveY(box.y[1], z) + pad;
}

// 位置が属する部屋の番号（無ければ -1）
export function roomAt(x, y, z) {
  for (let r = 0; r < ROOMS.length; r++) if (inBox(ROOMS[r].box, x, y, z)) return r;
  return -1;
}

export const compOfRoom = (r) => ROOMS[r].comp;
