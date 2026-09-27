// 艦の 3D モデル（駆逐艦 島風）。船体は hull.js、艦内配置は layout.js から作る（どちらも物理・流体格子と共通の SSOT）。
// 隔壁・甲板は流体格子の板と同じ位置（snapPlane）に置き、水が壁にめり込んで見えないようにする。
// 上部構造と兵装（艦橋・煙突・主砲・魚雷発射管・マスト）は描画だけ（浸水の対象ではない）。top にまとめ、甲板を外す表示では隠す。
import * as THREE from 'three/webgpu';
import {
  texture, uv, frontFacing, select, vec2, vec3, vec4, color, float, positionLocal, mix, smoothstep, Fn, Discard, uniform, dot, abs, fract,
  pow, clamp, max, normalLocal, normalView, positionView, normalize,
} from 'three/tsl';
import * as H from '../hull.js';
import * as Lo from '../layout.js';
import { snapPlane } from '../shipgrid.js';
import * as TX from './textures.js';
import { V3, grid, orient, plate, box, rod, batcher } from './geo.js';

const INF = 99;
const T_PLATE = 0.06; // 隔壁・壁の見た目の厚さ
const T_DECK = 0.08;

// 表は模様、裏（断面表示で見える切り口や外板の内側）は単色にする材質
function mat({ map = null, tint = '#ffffff', back = '#5d6368', roughness = 0.7, metalness = 0.1, bumpMap = null, bumpScale = 1, roughnessMap = null, repeat = null, emissive = null, transparent = false }) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness, metalness, side: THREE.DoubleSide, transparent });
  const base = map ? texture(map, repeat ? uv().mul(vec2(...repeat)) : uv()).rgb.mul(color(tint)) : color(tint);
  m.colorNode = select(frontFacing, base, color(back));
  if (bumpMap) { m.bumpMap = bumpMap; m.bumpScale = bumpScale; }
  if (roughnessMap) m.roughnessMap = roughnessMap;
  if (emissive) m.emissiveNode = color(emissive);
  return m;
}

// ---------- 透視表示 ----------
// 外殻（外板・甲板・船首楼の後端壁）のうち、カメラの側を向いた面だけを透かし、艦内の部屋・隔壁・機器・水はそのまま 3D で見せる
// （Sims の「壁を下げる」表示や、技術図解の ghosted view と同じ考え方）。
// 判定は「その面の船外向きの向き · (カメラ − 点) > 0」。外板は幾何の法線、厚みのある壁（両面が別の面）や甲板（上下 2 枚）は
// 面ごとに決まった船外向きを使う（幾何の法線だと裏の面がカメラを向かず、残って視界を塞ぐ）
// xv: その艦の透視の状態 { on, camLocal }（buildShipModel ごとに作る。モジュールで共有すると、2 隻目の setXray が 1 隻目も切り替える）
const ghostHere = (xv, outward) => xv.on.greaterThan(0.5).and(dot(outward ? vec3(...outward) : normalLocal, xv.camLocal.sub(positionLocal)).greaterThan(0));
// 材質に「透かす面では描かない」を足す（元の色の計算は保つ）
function ghostify(m, xv, outward = null) {
  const base = m.colorNode ?? color(m.color);
  m.colorNode = Fn(() => { Discard(ghostHere(xv, outward)); return base; })();
  return m;
}
// 透かした面に重ねるガラス: 縁で明るいフレネルと、肋骨（1.2 m）・水線（0.5 m）または甲板の継ぎ目の細い線。加算で重ねる
function ghostGlass(xv, outward = null) {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
  const line = (v, step, w) => float(1).sub(smoothstep(w * 0.4, w, abs(fract(v.div(step).add(0.5)).sub(0.5)).mul(step)));
  m.colorNode = Fn(() => {
    Discard(ghostHere(xv, outward).not());
    const p = positionLocal;
    const flat = outward && outward[1] > 0.5; // 甲板: 前後と左右の継ぎ目
    // 縦の線は z に並べる（肋骨）。z を向いた面（船首楼の後端壁）は z が一定なので x に並べる
    // （z のままだと面全体が線の上になり、一様に明るく光る）
    const across = outward ? (Math.abs(outward[2]) > 0.5 ? p.x : p.z) : select(abs(normalLocal.z).greaterThan(0.9), p.x, p.z);
    const lines = flat ? max(line(p.z, 2.4, 0.05), line(p.x, 1.4, 0.04).mul(0.6)) : max(line(across, 1.2, 0.05), line(p.y, 0.5, 0.03).mul(0.55));
    const fres = pow(float(1).sub(abs(dot(normalView, normalize(positionView)))), 3);
    const a = clamp(float(0.025).add(fres.mul(0.3)).add(lines.mul(0.2)), 0, 1);
    return vec4(vec3(0.5, 0.82, 1.0), a);
  })();
  return m;
}

// 断面 z の高さ比 t（0 船底 → 1 甲板）での半幅と高さ。船首では幅が出る最下点 t0 から張り直す
function rawSection(z, t) {
  const k = H.keelY(z), d = H.deckY(z), y = k + (d - k) * t;
  return { y, hb: Math.max(0, H.halfBreadth(z, Math.min(d - 1e-6, Math.max(k + 1e-6, y)))) };
}
function bottomT(z) {
  if (rawSection(z, 0).hb > 1e-3) return 0;
  if (rawSection(z, 1).hb <= 1e-3) return 1;
  let lo = 0, hi = 1;
  for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (rawSection(z, m).hb > 1e-3) hi = m; else lo = m; }
  return hi;
}
const section = (z, t) => { const t0 = bottomT(z); return rawSection(z, t0 + (1 - t0) * t); };
const hbAt = (z, y) => Math.max(0, H.halfBreadth(z, Math.min(H.deckY(z) - 1e-6, y)));

// 断面 z の、高さ y0..y1・幅 x0..x1 の範囲の外形（船体の内側に少し入れる）
function sectionOutline(z, y0, y1, x0 = -INF, x1 = INF, inset = 0.03, n = 24) {
  const left = [], right = [];
  for (let i = 0; i <= n; i++) {
    const y = y0 + ((y1 - y0) * i) / n;
    const hb = hbAt(z, y) - inset;
    if (hb <= 0) continue;
    left.push([Math.max(x0, -hb), y]);
    right.push([Math.min(x1, hb), y]);
  }
  return [...left, ...right.reverse()];
}
const rect = (a0, a1, b0, b1) => [[a0, b0], [a1, b0], [a1, b1], [a0, b1]];

// 兵装・上部構造の配置（船体座標 z）。島風の写真・図面の比率からの推定値
export const TOPSIDE = {
  turrets: [{ z: 41.5, facing: 1 }, { z: -35.5, facing: -1, base: 1.9 }, { z: -43.8, facing: -1 }], // 12.7 cm 連装砲（1 番は船首楼、2 番は背負い式）
  torpedoes: [5.0, -7.5, -17.0], // 61 cm 五連装魚雷発射管（中心線上）
  funnels: [{ z: 12.4, r: [1.35, 2.3], h: 9.6 }, { z: -1.6, r: [1.45, 2.4], h: 9.2 }], // 前部煙突は 1・2 号缶、後部は 3 号缶
  bridge: { z: [24.8, 32.6] },
  foremast: 23.6,
  mainmast: -26.5,
};

export function buildShipModel({ h, draft }) {
  const group = new THREE.Group(); // 剛体に合わせて動かす
  const cut = new THREE.ClippingGroup(); // 断面表示で切る部分（船体・艦内・上部構造）
  cut.clippingPlanes = [new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0)];
  cut.enabled = false;
  cut.clipShadows = true; // 切り取った半分が影を落とすと、断面から見た艦内が真っ暗になる
  group.add(cut);
  const top = new THREE.Group(); // 上部構造・兵装（甲板を外す表示で隠す）
  cut.add(top);
  const B = batcher(), BT = batcher();
  const snapZ = (z) => snapPlane(z, 'z', h), snapY = (y) => snapPlane(y, 'y', h);
  const lower = snapY(Lo.LOWER);
  const upY = (z) => H.upperY(z), dkY = (z) => H.deckY(z);

  // ---------- 材質 ----------
  const hullTex = TX.hullTextures(draft);
  const grayTex = TX.paintTexture('#4a5156', { rust: 10, panels: 128 }); // 軍艦色（呉海軍工廠の灰色に近い暗い灰）
  const M = {
    hull: mat({ map: hullTex.map, bumpMap: hullTex.bumpMap, bumpScale: 2, roughnessMap: hullTex.roughnessMap, roughness: 1, metalness: 0.25, back: '#7b7f82' }),
    deck: (() => { const t = TX.steelDeckTexture('#5e564d'); return mat({ map: t.map, bumpMap: t.bumpMap, bumpScale: 1.2, repeat: [1, 1], roughness: 0.8, metalness: 0.15, back: '#7b7f82' }); })(),
    checker: (() => { const t = TX.checkerPlateTexture(); return mat({ map: t.map, bumpMap: t.bumpMap, bumpScale: 2, roughness: 0.45, metalness: 0.7, back: '#55595c' }); })(),
    primer: mat({ map: TX.paintTexture('#8f9496', { rust: 20 }), roughness: 0.75, metalness: 0.2, back: '#6a6f72' }),
    bulkhead: mat({ map: TX.paintTexture('#b9bcb8', { rust: 12 }), roughness: 0.7, metalness: 0.15, back: '#7d8285' }),
    cabin: mat({ map: TX.paintTexture('#d8d4c6', { rust: 0, panels: 170 }), roughness: 0.8, back: '#9d9687' }),
    floor: mat({ map: TX.floorTexture('#6b4f3a'), roughness: 0.6, back: '#5a5246' }),
    gray: mat({ map: grayTex, roughness: 0.6, metalness: 0.25, back: '#5d6368' }),
    red: mat({ tint: '#8e2b22', roughness: 0.6, back: '#6d2019' }),
    steel: mat({ tint: '#50565c', roughness: 0.45, metalness: 0.75, back: '#3d4246' }),
    dark: mat({ tint: '#1a1c1e', roughness: 0.9, back: '#1a1c1e' }),
    engine: mat({ tint: '#5e7f8e', roughness: 0.4, metalness: 0.5, back: '#4a6570' }),
    boiler: mat({ tint: '#9aa0a2', roughness: 0.8, metalness: 0.2, back: '#6f7577' }),
    yellow: mat({ tint: '#d2a21c', roughness: 0.5, metalness: 0.3, back: '#a47d15' }),
    brass: mat({ tint: '#b08d57', roughness: 0.3, metalness: 1, back: '#8a6d42' }),
    wood: mat({ tint: '#8a6a45', roughness: 0.8, back: '#6b5236' }),
    shell: mat({ tint: '#b6a25a', roughness: 0.35, metalness: 0.8, back: '#8a7a40' }),
    fabric: mat({ tint: '#c9c2ad', roughness: 0.95, back: '#9d9784' }),
    glass: new THREE.MeshPhysicalNodeMaterial({ color: 0x0d1b26, roughness: 0.05, metalness: 0.2, clearcoat: 1, side: THREE.DoubleSide }),
    lamp: new THREE.MeshStandardNodeMaterial({ color: 0xfff1d0, emissive: 0xffe2b0, emissiveIntensity: 2.5, side: THREE.DoubleSide }),
    funnel: mat({ map: TX.funnelTexture(), roughness: 0.55, metalness: 0.2, back: '#333' }),
    rope: new THREE.LineBasicNodeMaterial({ color: 0x1b1b1b }),
  };
  // 透視表示で透かす外殻: 外板（幾何の法線）・甲板（上向き）・船首楼の後端壁（後ろ向き）
  const xv = { on: uniform(0), camLocal: uniform(new THREE.Vector3()) };
  const OUT = { px: [1, 0, 0], nx: [-1, 0, 0], nz: [0, 0, -1], up: [0, 1, 0] };
  const fcWall = (() => { const m = mat({ roughness: 0.6, metalness: 0.25, back: '#5d6368' }); m.colorNode = M.gray.colorNode; return m; })();
  const ghostOf = new Map([[M.hull, null], [M.deck, OUT.up], [fcWall, OUT.nz]]); // 材質 → 船外向き（null = 幾何の法線）
  for (const [m, o] of ghostOf) ghostify(m, xv, o);
  // 肋骨（外板の内側の帯）と甲板の下の梁も外殻と一緒に透かす（残すと手前に柵のように並んで艦内を隠す。線はガラスの側に描く）
  const frameMat = {};
  for (const k of ['px', 'nx', 'up']) { frameMat[k] = mat({ roughness: 0.75, metalness: 0.2, back: '#6a6f72' }); frameMat[k].colorNode = M.primer.colorNode; ghostify(frameMat[k], xv, OUT[k]); }

  // ---------- 船体外板 ----------
  // 断面は等間隔 + 船首楼の後端の両側（段を垂直に立てる）
  const NT = 32, ZS = H.stations(260);
  const sidePoint = (side, z, j) => { const s = section(z, j / NT); return [side * s.hb, s.y, z, ...TX.hullUV(side, z, s.y)]; };
  const hullGeos = [
    orient(grid(ZS.length - 1, NT, (i, j) => sidePoint(1, ZS[i], j)), () => V3(1, 0, 0)),
    orient(grid(ZS.length - 1, NT, (i, j) => sidePoint(-1, ZS[i], j)), () => V3(-1, 0, 0)),
    orient(grid(ZS.length - 1, 6, (i, j) => { const z = ZS[i], s = section(z, 0), x = -s.hb + (2 * s.hb * j) / 6; return [x, s.y, z, ...TX.hullUV(1, z, s.y)]; }), () => V3(0, -1, 0)),
  ];
  const hullMeshes = [];
  for (const g of hullGeos) {
    const m = new THREE.Mesh(g, M.hull);
    m.castShadow = m.receiveShadow = true;
    cut.add(m);
    hullMeshes.push(m);
  }
  // 船首楼の後端壁（上甲板から船首楼甲板まで、外殻の一部）。扉 o2・o3 は穴
  const doorOf = (id) => Lo.SEA_OPENINGS.find((o) => o.id === id);
  {
    const z = H.FC_Z + 1e-3, outline = sectionOutline(z, upY(H.FC_Z), dkY(z) - 0.005, -INF, INF, 0.0);
    const holes = ['o2', 'o3'].map((id) => { const o = doorOf(id); return rect(o.center[0] - o.half[0], o.center[0] + o.half[0], o.center[1] - o.half[1], o.center[1] + o.half[1]); });
    const g = plate(outline, holes, 0.1, (a, b, c) => [a, b, H.FC_Z + c], 0.25);
    const m = new THREE.Mesh(g, fcWall);
    m.castShadow = m.receiveShadow = true;
    cut.add(m);
    hullMeshes.push(m);
  }

  // ---------- 甲板（厚さ = 上下 2 枚の面。断面で見ると板厚が見える） ----------
  // grid で (z, 横) に張り、holes の範囲の四角形は抜く
  function deckSurface(z0, z1, yOf, holes, material, nz = 180, nx = 28) {
    for (const [dy, side] of [[0, 1], [-T_DECK, -1]]) {
      const hbOf = (z) => Math.max(0, hbAt(z, yOf(z) - 0.01) - 0.01);
      const g = grid(nz, nx, (i, j) => {
        const z = z0 + ((z1 - z0) * i) / nz, hb = hbOf(z), x = -hb + (2 * hb * j) / nx;
        return [x, yOf(z) + dy, z, x / 3, z / 3];
      }, (i, j) => {
        const z = z0 + ((z1 - z0) * (i + 0.5)) / nz, hb = hbOf(z), x = -hb + (2 * hb * (j + 0.5)) / nx;
        return holes.some((r) => x > r.x[0] && x < r.x[1] && z > r.z[0] && z < r.z[1]);
      });
      B.add(material, orient(g, () => V3(0, side, 0)));
    }
  }
  const openingRect = (o) => ({ x: [o.center[0] - o.half[0], o.center[0] + o.half[0]], z: [o.center[2] - o.half[1], o.center[2] + o.half[1]] });
  const deckHoles = Lo.SEA_OPENINGS.filter((o) => o.normal[1] > 0.5).map(openingRect);
  // 板を上下に貫くハッチ（艦内の昇降口・水密ハッチ）: その高さの甲板の穴
  const hatchesAt = (yOf) => Lo.DOORS.filter((d) => { const zc = (d.box.z[0] + d.box.z[1]) / 2, y = yOf(zc); return Lo.resolveY(d.box.y[0], zc) < y && Lo.resolveY(d.box.y[1], zc) > y && d.box.z[1] - d.box.z[0] > 1; })
    .map((d) => ({ x: d.box.x, z: d.box.z }));
  // 露天甲板: 後部の上甲板と船首楼甲板（段で分ける）
  deckSurface(H.Z_MIN + 0.02, H.FC_Z - 0.002, (z) => dkY(z) + 0.002, deckHoles, M.deck, 360, 30);
  deckSurface(H.FC_Z + 0.002, H.Z_MAX - 0.05, (z) => dkY(z) + 0.002, deckHoles, M.deck, 180, 30);
  // 船首楼の下の上甲板（隔壁甲板、艦内）
  const upperIn = (z) => snapPlane(upY(z), 'y', h) + T_DECK / 2;
  deckSurface(snapZ(H.FC_Z) + 0.05, Lo.BULKHEADS[0] + 6, upperIn, hatchesAt(upY), M.floor, 120, 24);
  // 下甲板（前部・後部）と二重底の天板（缶室・機械室は縞鋼板）
  const lowerHoles = hatchesAt(() => Lo.LOWER);
  for (const p of Lo.PLATES.filter((q) => q.axis === 'y' && q.at === Lo.LOWER)) deckSurface(snapZ(p.span.z[0]), snapZ(p.span.z[1]), () => lower + T_DECK / 2, lowerHoles, M.floor, 60, 24);
  const tankZ = (z) => H.keelY(z) < H.TANK_TOP - 0.1;
  let tz0 = H.Z_MIN; while (!tankZ(tz0)) tz0 += 0.05;
  let tz1 = H.Z_MAX; while (!tankZ(tz1)) tz1 -= 0.05;
  const [mz0, mz1] = Lo.MACHINERY.z;
  deckSurface(tz0, mz0, () => H.TANK_TOP, [], M.primer, 60, 18);
  deckSurface(mz0, mz1, () => H.TANK_TOP, [], M.checker, 90, 18);
  deckSurface(mz1, tz1, () => H.TANK_TOP, [], M.primer, 60, 18);

  // ---------- 骨組み: 外板内側の肋骨（フレーム）と甲板下のビーム。断面・透視で艦らしい内部に見せる（描画は 1.2 m ごと） ----------
  const crosses = (holes, z) => holes.some((r) => z > r.z[0] - 0.05 && z < r.z[1] + 0.05);
  for (let z = H.Z_MIN + 1.2; z < H.Z_MAX - 0.6; z += 1.2) {
    if (Lo.BULKHEADS.some((b) => Math.abs(b - z) < 0.3)) continue;
    const y0 = Math.max(H.TANK_TOP, H.keelY(z) + 0.05), y1 = dkY(z) - 0.08;
    if (hbAt(z, (y0 + y1) / 2) < 0.8) continue;
    for (const sgn of [1, -1]) {
      const pts = [];
      for (let k = 0; k <= 12; k++) { const y = y0 + ((y1 - y0) * k) / 12; pts.push([sgn * (hbAt(z, y) - 0.02), y]); }
      const strip = pts.map(([x, y]) => [x - sgn * 0.18, y]).reverse(); // 外板に沿った帯（奥行き 0.18 m）
      B.add(sgn > 0 ? frameMat.px : frameMat.nx, plate([...pts, ...strip], [], 0.04, (a, b, c) => [a, b, z + c], 0.3));
    }
    const yd = dkY(z) - 0.12, hb = hbAt(z, yd) - 0.05;
    if (hb > 0.5 && !crosses(deckHoles, z)) B.add(frameMat.up, box(2 * hb, 0.2, 0.1, 0, yd, z));
    if (z > H.FC_Z) { const yu = snapY(upY(z)) - 0.12, hu = hbAt(z, yu) - 0.05; if (hu > 0.5) B.add(M.primer, box(2 * hu, 0.18, 0.09, 0, yu, z)); }
  }

  // ---------- 隔壁・仕切り（layout.PLATES の z の板）。扉・ハッチの位置は穴にする ----------
  const overlap = (a, b) => a && b && Math.min(a[1], b[1]) > Math.max(a[0], b[0]);
  // 高さも板の範囲と重なる扉だけ（z = K3 には水密隔壁の扉 D2 と、その上の船首楼の仕切り扉 c1 が同じ z にある。
  // 範囲外の穴を渡すと、押し出しが穴の側面だけを宙に作り、もう一方の板の穴の側面と重なってちらつく）
  const yRange = (r, z) => [Lo.resolveY(r[0], z), Lo.resolveY(r[1], z)];
  const doorHoles = (p) => Lo.DOORS.filter((d) => {
    const r = d.box[p.axis];
    if (!(p.at >= r[0] && p.at <= r[1])) return false;
    if (p.axis === 'z' && !overlap(yRange(d.box.y, p.at), yRange(p.span.y, p.at))) return false;
    return ['x', 'z'].filter((a) => a !== p.axis).every((a) => !p.span[a] || overlap(d.box[a], p.span[a]));
  });
  for (const p of Lo.PLATES.filter((q) => q.axis === 'z')) {
    const z = snapZ(p.at);
    const y0 = Math.max(Lo.resolveY(p.span.y[0], z), H.keelY(z)), y1 = Lo.resolveY(p.span.y[1], z);
    const watertight = p.span.y[0] === H.TANK_TOP;
    const outline = sectionOutline(z, y0, y1 - 0.01);
    if (outline.length < 3) continue;
    const holes = doorHoles(p).map((d) => rect(d.box.x[0], d.box.x[1], Lo.resolveY(d.box.y[0], z) + 0.01, Lo.resolveY(d.box.y[1], z)));
    B.add(watertight ? M.bulkhead : M.cabin, plate(outline, holes, T_PLATE, (a, b, c) => [a, b, z + c], 0.3));
    // 補強材（縦の平鋼、0.6 m ごと）。水密隔壁の片面だけ
    if (watertight) for (let x = -5.4; x <= 5.4; x += 0.6) {
      if (Math.abs(x) > hbAt(z, (y0 + y1) / 2) - 0.15) continue;
      if (doorHoles(p).some((d) => x > d.box.x[0] - 0.1 && x < d.box.x[1] + 0.1)) continue;
      B.add(M.bulkhead, box(0.03, y1 - y0 - 0.1, 0.16, x, (y0 + y1) / 2, z - 0.11));
    }
  }

  // ---------- 扉・ハッチ（水密は開閉できる） ----------
  const doors = new Map();
  const animated = (id, pivot, openAngle, axis, open) => {
    const d = { pivot, target: 0, angle: 0, openAngle, axis };
    d.set = (o) => { d.target = o ? d.openAngle : 0; };
    d.set(open);
    doors.set(id, d);
  };
  function hingedDoor(id, w, hgt, pos, openSign, material, open) {
    const pivot = new THREE.Group();
    pivot.position.copy(pos);
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(w, hgt, 0.05), material);
    leaf.position.set(w / 2, hgt / 2, 0);
    leaf.castShadow = leaf.receiveShadow = true;
    pivot.add(leaf);
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.3, 0.12), M.yellow); // 締め付けハンドル
    handle.position.set(w * 0.85, hgt * 0.5, 0);
    pivot.add(handle);
    cut.add(pivot);
    animated(id, pivot, openSign * 1.75, 'y', open);
  }
  // ハッチ: コーミング（縁の立ち上がり）と、前の辺を軸に後ろの辺が持ち上がる蓋（軸は +x 回りなので開く角度は正。負だと蓋が穴の中へ垂れ下がる）
  function hatchLid(id, x, y, z, a, b, open, coaming = 0.45, material = M.gray) {
    for (const [w, d, cx, cz] of [[2 * a + 0.1, 0.05, x, z - b - 0.025], [2 * a + 0.1, 0.05, x, z + b + 0.025], [0.05, 2 * b, x - a - 0.025, z], [0.05, 2 * b, x + a + 0.025, z]]) B.add(material, box(w, coaming, d, cx, y + coaming / 2, cz));
    const pivot = new THREE.Group();
    pivot.position.set(x, y + coaming, z + b + 0.05);
    const lid = new THREE.Mesh(new THREE.BoxGeometry(2 * a + 0.1, 0.06, 2 * b + 0.1), material);
    lid.position.set(0, 0, -(b + 0.05));
    lid.castShadow = true;
    pivot.add(lid);
    cut.add(pivot);
    if (id) animated(id, pivot, 1.9, 'x', open);
  }
  for (const d of Lo.DOORS.filter((x) => x.wt)) {
    const zc = (d.box.z[0] + d.box.z[1]) / 2, xc = (d.box.x[0] + d.box.x[1]) / 2;
    const y0 = Lo.resolveY(d.box.y[0], zc), y1 = Lo.resolveY(d.box.y[1], zc);
    if (d.box.z[1] - d.box.z[0] > 1) { // 水平のハッチ（上甲板の水密ハッチ）
      const y = snapY((y0 + y1) / 2) + T_DECK / 2;
      hatchLid(d.id, xc, y, zc, (d.box.x[1] - d.box.x[0]) / 2, (d.box.z[1] - d.box.z[0]) / 2, d.open, 0.3, M.steel);
      continue;
    }
    const z = snapZ(zc), w = d.box.x[1] - d.box.x[0];
    for (const xx of [d.box.x[0] - 0.02, d.box.x[1] + 0.02]) B.add(M.steel, box(0.08, y1 - y0, 0.14, xx, (y0 + y1) / 2, z)); // 枠
    B.add(M.steel, box(w + 0.16, 0.08, 0.14, xc, y1 + 0.02, z));
    hingedDoor(d.id, w, y1 - y0 - 0.02, V3(d.box.x[0], y0 + 0.01, z + 0.06), -1, M.steel, d.open);
  }
  // 艦内の常開のハッチ（昇降口・揚弾口）: 縁とラッタル
  for (const d of Lo.DOORS.filter((x) => !x.wt && x.box.z[1] - x.box.z[0] > 1)) {
    const zc = (d.box.z[0] + d.box.z[1]) / 2, xc = (d.box.x[0] + d.box.x[1]) / 2, y = lower + T_DECK / 2;
    const a = (d.box.x[1] - d.box.x[0]) / 2, b = (d.box.z[1] - d.box.z[0]) / 2;
    for (const [w, dd, cx, cz] of [[2 * a, 0.05, xc, zc - b], [2 * a, 0.05, xc, zc + b], [0.05, 2 * b, xc - a, zc], [0.05, 2 * b, xc + a, zc]]) B.add(M.yellow, box(w, 0.9, dd, cx, y + 0.45, cz));
    for (const s of [-0.3, 0.3]) B.add(M.steel, rod(V3(xc + s, H.TANK_TOP, zc - b + 0.15), V3(xc + s, y + 0.9, zc - b + 0.15), 0.025));
    for (let yy = H.TANK_TOP + 0.3; yy < y; yy += 0.3) B.add(M.steel, rod(V3(xc - 0.3, yy, zc - b + 0.15), V3(xc + 0.3, yy, zc - b + 0.15), 0.015));
  }
  // 船外への開口: 露天甲板のハッチ・天窓・缶室の給気口（蓋が開閉する）と、船首楼の後端の扉
  for (const o of Lo.SEA_OPENINGS) {
    const [cx, cy, cz] = o.center, [a, b] = o.half;
    if (o.kind === 'door') { hingedDoor(o.id, 2 * a, 2 * b, V3(cx - a, cy - b, cz - 0.06), 1, M.gray, o.open); continue; }
    if (o.kind === 'vent') {
      // 缶室の給気口: 煙突の脇の箱形の給気筒。蓋は上の口。
      // 浸水の入口（SEA_OPENINGS）なので上部構造（top）には入れない: 入れると「上部構造」を隠したとき、甲板の穴の上に蓋だけが浮く
      const hgt = 2.4;
      for (const [w, d, x, z] of [[2 * a + 0.2, 0.1, cx, cz - b - 0.05], [2 * a + 0.2, 0.1, cx, cz + b + 0.05], [0.1, 2 * b, cx - a - 0.05, cz], [0.1, 2 * b, cx + a + 0.05, cz]]) B.add(M.gray, box(w, hgt, d, x, cy + hgt / 2, z));
      for (let y = cy + 0.5; y < cy + hgt - 0.3; y += 0.3) B.add(M.dark, box(0.02, 0.06, 2 * b, cx + Math.sign(cx) * (a + 0.11), y, cz)); // 外側のルーバー
      hatchLid(o.id, cx, cy + hgt - 0.1, cz, a, b, o.open, 0.1, M.gray);
      continue;
    }
    hatchLid(o.id, cx, cy, cz, a, b, o.open, o.half[1] > 1 ? 0.7 : 0.45, M.gray);
  }

  // ---------- 艦内の設備 ----------
  const obst = (name) => Lo.OBSTACLES.filter((o) => o.name === name).map((o) => o.box);
  const mid = (r) => (r[0] + r[1]) / 2, len = (r) => r[1] - r[0];
  // 缶（ロ号艦本式缶）: 缶胴・水ドラム・焚口（前面）と、上の煙路（前部煙突へは 1・2 号缶、後部煙突へは 3 号缶）
  const [f1, f2] = TOPSIDE.funnels;
  obst('ボイラー').forEach((b, i) => {
    const zc = mid(b.z), top = b.y[1];
    B.add(M.boiler, box(len(b.x) - 0.1, top - H.TANK_TOP - 0.6, len(b.z) - 0.1, 0, (H.TANK_TOP + top - 0.6) / 2, zc));
    B.add(M.boiler, new THREE.CylinderGeometry(0.75, 0.75, len(b.z) - 0.2, 20).rotateX(Math.PI / 2).translate(0, top - 0.5, zc)); // 蒸気ドラム
    for (const s of [-1, 1]) B.add(M.boiler, new THREE.CylinderGeometry(0.4, 0.4, len(b.z) - 0.2, 14).rotateX(Math.PI / 2).translate(s * 1.5, H.TANK_TOP + 0.5, zc)); // 水ドラム
    for (let k = 0; k < 3; k++) B.add(M.dark, box(0.5, 0.45, 0.06, -1 + k, H.TANK_TOP + 1.6, b.z[0] - 0.02)); // 焚口
    const f = i < 2 ? f1 : f2;
    // 煙路。斜めの部分と、甲板の下の縦の部分に分ける: 斜めの円柱のまま甲板まで伸ばすと、傾いた端面の縁（最大で半径 0.75 m 上）が
    // 甲板から突き出て、上部構造を隠したときに見える
    const ez = f.z + (i === 0 ? 0.9 : i === 1 ? -0.9 : 0), ey = upY(f.z);
    B.add(M.steel, rod(V3(0, top - 0.2, zc), V3(0, ey - 0.9, ez), 0.75, 16));
    B.add(M.steel, rod(V3(0, ey - 0.9, ez), V3(0, ey - 0.1, ez), 0.75, 16));
    B.add(M.lamp, box(0.4, 0.03, 0.4, 3.3, upY(zc) - 0.1, zc));
  });
  // 主機（タービンと減速装置、1 軸分ずつ）と推進軸（船尾へ）
  const props = [];
  obst('タービン').forEach((b, i) => {
    const xc = mid(b.x), zc = mid(b.z);
    B.add(M.engine, new THREE.CylinderGeometry(0.9, 0.9, len(b.z) * 0.45, 20).rotateX(Math.PI / 2).translate(xc, H.TANK_TOP + 1.3, b.z[1] - len(b.z) * 0.25)); // 高圧・中圧
    B.add(M.engine, new THREE.CylinderGeometry(1.15, 1.15, len(b.z) * 0.35, 20).rotateX(Math.PI / 2).translate(xc, H.TANK_TOP + 1.45, zc - len(b.z) * 0.05)); // 低圧
    B.add(M.engine, box(len(b.x) - 0.1, b.y[1] - H.TANK_TOP - 0.2, 1.6, xc, (H.TANK_TOP + b.y[1]) / 2, b.z[0] + 0.9)); // 減速装置
    B.add(M.steel, box(0.9, 0.9, len(b.z) - 1, xc - Math.sign(xc) * 1.8, H.TANK_TOP + 0.45, zc)); // 復水器
    const sx = 2.8 * Math.sign(xc), prop = { x: sx, y: 1.9, z: -51.5 };
    B.add(M.steel, rod(V3(xc, H.TANK_TOP + 0.9, b.z[0]), V3(sx, prop.y, prop.z + 0.6), 0.16, 12)); // 推進軸
    B.add(M.gray, rod(V3(sx, prop.y, prop.z + 3), V3(sx * 0.35, H.keelY(prop.z + 3) + 0.4, prop.z + 3.2), 0.12, 8)); // 軸ブラケット
    props.push(prop);
    B.add(M.lamp, box(0.4, 0.03, 0.4, 0, upY(zc) - 0.1, zc));
  });
  // 弾薬庫: 弾と装薬の棚
  for (const b of obst('弾薬')) {
    for (let x = b.x[0] + 0.3; x < b.x[1] - 0.3; x += 0.9) for (let z = b.z[0] + 0.4; z < b.z[1] - 0.3; z += 1.2) {
      B.add(M.wood, box(0.8, 0.08, 1.1, x + 0.4, b.y[1] - 0.05, z + 0.55));
      for (let k = 0; k < 4; k++) B.add(M.shell, new THREE.CylinderGeometry(0.07, 0.07, 0.6, 8).translate(x + 0.15 + k * 0.17, b.y[1] + 0.3, z + 0.55));
    }
  }
  // 重油タンクの天板（下甲板と同じ高さ）
  for (const b of obst('重油タンク')) B.add(M.primer, box(2 * hbAt(mid(b.z), Lo.LOWER) - 0.2, 0.1, len(b.z) - 0.2, 0, Lo.LOWER - 0.05, mid(b.z)));
  // 居住区（兵員室・士官室・艦長室）: 吊り床（ハンモック）の棒・衣嚢棚・食卓、天井灯
  for (const r of Lo.ROOMS.filter((x) => /兵員室|士官室|艦長室/.test(x.name))) {
    const z0 = r.box.z[0] + 0.8, z1 = r.box.z[1] - 0.8, zc = mid(r.box.z);
    const yf = typeof r.box.y[0] === 'number' ? snapY(r.box.y[0]) + T_DECK / 2 : upperIn(zc);
    const yc = Lo.resolveY(r.box.y[1], zc) - 0.15;
    for (const s of [-1, 1]) {
      const xo = s * (hbAt(zc, yf + 1) - 0.6);
      B.add(M.cabin, box(0.5, 1.6, z1 - z0, xo, yf + 0.8, zc)); // 衣嚢棚・ロッカー
      if (/兵員室/.test(r.name)) for (let z = z0; z < z1; z += 1.6) B.add(M.steel, rod(V3(xo - s * 0.4, yc - 0.3, z), V3(-xo * 0.1, yc - 0.3, z), 0.02)); // 吊り床の棒
      else for (let z = z0; z < z1 - 1.8; z += 2.6) { B.add(M.wood, box(0.9, 0.4, 1.9, xo - s * 0.8, yf + 0.3, z + 1)); B.add(M.fabric, box(0.85, 0.1, 1.85, xo - s * 0.8, yf + 0.55, z + 1)); }
    }
    for (let z = z0 + 0.6; z < z1; z += 3.2) {
      B.add(M.wood, box(1.2, 0.05, 2.2, 0, yf + 0.75, z));
      B.add(M.steel, box(0.08, 0.7, 0.08, 0, yf + 0.38, z));
      B.add(M.lamp, box(0.3, 0.03, 0.3, 0, yc + 0.1, z));
    }
  }
  // 船首楼の兵員室
  for (let z = H.FC_Z + 2; z < 55; z += 3.4) {
    const yf = upperIn(z), hb = hbAt(z, yf + 1) - 0.6;
    if (hb < 1) continue;
    B.add(M.wood, box(1.2, 0.05, 2.2, 0, yf + 0.75, z));
    for (const s of [-1, 1]) B.add(M.cabin, box(0.5, 1.6, 2.6, s * hb, yf + 0.8, z));
    B.add(M.lamp, box(0.3, 0.03, 0.3, 0, dkY(z) - 0.12, z));
  }
  // 発電機室・補機室: 発電機とポンプ
  for (const name of ['発電機室', '補機室']) {
    const r = Lo.ROOMS.find((x) => x.name === name).box, zc = mid(r.z);
    const yf = typeof r.y[0] === 'number' ? (r.y[0] === Lo.LOWER ? lower + T_DECK / 2 : H.TANK_TOP) : upperIn(zc);
    for (const s of [-1, 1]) {
      B.add(M.yellow, box(1.4, 1.3, 3.2, s * 2.2, yf + 0.65, zc));
      B.add(M.engine, new THREE.CylinderGeometry(0.45, 0.45, 1.2, 16).rotateX(Math.PI / 2).translate(s * 2.2, yf + 0.9, zc + 2.2));
    }
    B.add(M.steel, box(0.5, 1.8, 1.4, 0, yf + 0.9, r.z[1] - 1.2)); // 配電盤
  }
  // 操舵機室: 舵頭と油圧シリンダ
  const rz = -59.2;
  B.add(M.engine, new THREE.CylinderGeometry(0.22, 0.22, 2.6, 16).translate(0, H.keelY(rz) + 1.6, rz));
  B.add(M.yellow, box(2.6, 0.4, 0.4, 0, H.keelY(rz) + 2.4, rz));
  // 錨鎖庫: 錨鎖の山
  for (let i = 0; i < 10; i++) B.add(M.dark, new THREE.TorusGeometry(0.45 - i * 0.02, 0.07, 6, 16).rotateX(Math.PI / 2).translate(0, H.keelY(60) + 0.6 + i * 0.12, 60));
  // 缶室・機械室の配管と灯
  for (let y = 3.2; y < 5.6; y += 0.45) B.add(M.red, rod(V3(-4.2, y, mz0 + 0.5), V3(-4.2, y, mz1 - 0.5), 0.06));

  // ---------- 舵とプロペラ（2 軸） ----------
  B.add(M.red, box(0.25, 2.8, 2.4, 0, H.keelY(rz) - 1.2, rz)); // 舵
  const propGroups = props.map((p, i) => {
    const g = new THREE.Group();
    g.position.set(p.x, p.y, p.z);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.34, 0.8, 16).rotateX(Math.PI / 2), M.brass);
    g.add(hub);
    for (let k = 0; k < 3; k++) { // 直径 3.6 m の 3 翼
      const blade = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 8), M.brass);
      blade.scale.set(0.5, 0.95, 0.06);
      const a = (k * 2 * Math.PI) / 3;
      blade.position.set(Math.sin(a) * 0.9, Math.cos(a) * 0.9, 0);
      blade.rotation.set(0, (i ? -1 : 1) * 0.5, -a);
      g.add(blade);
    }
    cut.add(g);
    return g;
  });
  B.add(M.red, box(0.3, 0.3, 90, 0, -0.15, -2)); // 平板龍骨

  // ================= 上部構造・兵装（top、描画のみ） =================
  const rail = (a, b, hgt = 1.0) => {
    for (const dy of [0.5, hgt]) BT.add(M.gray, rod(a.clone().add(V3(0, dy, 0)), b.clone().add(V3(0, dy, 0)), 0.02, 5));
    const n = Math.max(1, Math.round(a.distanceTo(b) / 1.5));
    for (let k = 0; k <= n; k++) { const p = a.clone().lerp(b, k / n); BT.add(M.gray, rod(p, p.clone().add(V3(0, hgt, 0)), 0.02, 5)); }
  };
  // 舷側の手すり（露天甲板の縁）
  for (const side of [1, -1]) {
    let prev = null;
    for (const z of [...ZS.filter((_, i) => i % 6 === 0), H.FC_Z - 0.01, H.FC_Z + 0.01].sort((a, b) => a - b)) {
      if (z < H.Z_MIN + 1 || z > H.Z_MAX - 3) { prev = null; continue; }
      const p = V3(side * (hbAt(z, dkY(z) - 0.02) - 0.08), dkY(z), z);
      if (prev && Math.abs(prev.y - p.y) < 1) rail(prev, p);
      prev = p;
    }
  }
  // 12.7 cm 連装砲（D 型の砲室）: 傾いた前面の砲室、2 本の砲身、旋回台
  function turret(z, facing, baseH = 0) {
    const y = dkY(z) + baseH;
    if (baseH) { BT.add(M.gray, box(4.6, baseH, 5.2, 0, y - baseH / 2, z)); rail(V3(-2.3, y, z - 2.6), V3(2.3, y, z - 2.6)); }
    BT.add(M.gray, new THREE.CylinderGeometry(2.0, 2.1, 0.5, 28).translate(0, y + 0.25, z));
    const out = [[-2.6, 0], [1.9, 0], [2.6, 1.1], [2.1, 2.35], [-2.6, 2.35]];
    BT.add(M.gray, plate(out, [], 4.0, (a, b, c) => [c, y + 0.45 + b, z + facing * a], 0.3));
    for (const s of [-0.62, 0.62]) {
      BT.add(M.steel, rod(V3(s, y + 1.3, z + facing * 2.2), V3(s, y + 1.55, z + facing * 8.6), 0.1, 10));
      BT.add(M.gray, rod(V3(s, y + 1.3, z + facing * 1.9), V3(s, y + 1.35, z + facing * 3.2), 0.24, 12)); // 砲身の根元（防盾から出る部分）
    }
    BT.add(M.dark, box(3.2, 0.25, 0.4, 0, y + 2.9, z - facing * 1.8)); // 測距儀の出っ張り
  }
  for (const t of TOPSIDE.turrets) turret(t.z, t.facing, t.base ?? 0);
  // 61 cm 五連装魚雷発射管（防盾付き）
  for (const z of TOPSIDE.torpedoes) {
    const y = dkY(z);
    BT.add(M.gray, new THREE.CylinderGeometry(1.7, 1.9, 0.9, 28).translate(0, y + 0.45, z));
    for (let k = -2; k <= 2; k++) BT.add(M.steel, new THREE.CylinderGeometry(0.34, 0.34, 8.6, 14).rotateX(Math.PI / 2).translate(k * 0.74, y + 1.35, z));
    BT.add(M.gray, plate([[-2.0, 0], [2.0, 0], [2.0, 1.6], [1.4, 2.0], [-1.4, 2.0], [-2.0, 1.6]], [], 3.2, (a, b, c) => [a, y + 0.9 + b, z + c], 0.3)); // 防盾
  }
  // 煙突（楕円・後傾）と基部のケーシング
  const funnelTops = TOPSIDE.funnels.map((f) => {
    const y0 = upY(f.z);
    BT.add(M.gray, box(2 * f.r[0] + 1.2, 1.6, 2 * f.r[1] + 1.6, 0, y0 + 0.8, f.z));
    const m = new THREE.Mesh(new THREE.CylinderGeometry(1, 1.08, f.h, 40, 1, true), M.funnel);
    m.scale.set(f.r[0], 1, f.r[1]);
    m.position.set(0, y0 + 1.2 + f.h / 2, f.z);
    m.rotation.x = -0.14;
    m.castShadow = true;
    top.add(m);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(1.02, 1.02, 0.25, 40, 1, true), M.dark); // 雨除けの縁
    cap.position.y = f.h / 2 - 0.1;
    m.add(cap);
    const t = new THREE.Object3D();
    t.position.set(0, f.h / 2 + 0.3, 0);
    m.add(t);
    return t;
  });
  // 艦橋（船首楼甲板の上、3 層）: 下の 2 層は箱、羅針艦橋は窓の帯、屋上に射撃指揮装置と測距儀
  {
    const [bz0, bz1] = TOPSIDE.bridge.z, y0 = dkY(bz0);
    BT.add(M.gray, box(6.6, 2.4, bz1 - bz0, 0, y0 + 1.2, (bz0 + bz1) / 2));
    BT.add(M.gray, box(5.8, 2.3, bz1 - bz0 - 1.2, 0, y0 + 3.55, (bz0 + bz1) / 2 - 0.3));
    const y2 = y0 + 4.7, cz = (bz0 + bz1) / 2 - 0.8;
    BT.add(M.gray, box(5.4, 0.9, 4.4, 0, y2 + 0.45, cz)); // 羅針艦橋の腰壁
    BT.add(M.gray, box(8.2, 0.12, 1.6, 0, y2 + 0.9, cz + 1.2)); // 張り出し（ウイング）
    for (let k = 0; k < 7; k++) { const g = new THREE.PlaneGeometry(0.7, 0.8).rotateX(-0.2); g.translate(-2.4 + k * 0.8, y2 + 1.35, cz + 2.2); BT.add(M.glass, g); }
    for (const s of [-1, 1]) BT.add(M.gray, box(0.1, 1.8, 4.4, s * 2.7, y2 + 0.9, cz));
    BT.add(M.gray, box(5.8, 0.15, 4.8, 0, y2 + 1.85, cz)); // 天蓋
    BT.add(M.gray, box(2.0, 1.4, 2.2, 0, y2 + 2.6, cz - 0.4)); // 九四式高射装置
    BT.add(M.steel, box(4.4, 0.35, 0.45, 0, y2 + 3.2, cz - 0.4)); // 測距儀
  }
  // 前檣（三脚）と電探、後檣
  const fmz = TOPSIDE.foremast, fmy = dkY(fmz), fTop = fmy + 17;
  BT.add(M.gray, rod(V3(0, fmy, fmz), V3(0, fTop, fmz - 0.8), 0.18, 10));
  for (const s of [-1, 1]) BT.add(M.gray, rod(V3(s * 2.2, fmy, fmz - 3.2), V3(0, fmy + 11, fmz - 0.55), 0.13, 8));
  BT.add(M.gray, box(2.2, 0.12, 2.2, 0, fmy + 11, fmz - 0.6)); // 見張所
  BT.add(M.gray, rod(V3(-2.8, fmy + 14, fmz - 0.7), V3(2.8, fmy + 14, fmz - 0.7), 0.06)); // 桁
  BT.add(M.dark, box(1.4, 1.4, 0.5, 0, fmy + 12.2, fmz - 0.2)); // 二二号電探
  for (const s of [-0.45, 0.45]) BT.add(M.steel, new THREE.CylinderGeometry(0.28, 0.12, 0.9, 12).rotateX(Math.PI / 2).translate(s, fmy + 12.2, fmz + 0.4));
  const mmz = TOPSIDE.mainmast, mmy = dkY(mmz);
  // 後部の甲板室（探照灯台・機銃座）と後檣
  BT.add(M.gray, box(4.4, 2.3, 7.5, 0, mmy + 1.15, mmz + 1.5));
  BT.add(M.gray, new THREE.CylinderGeometry(0.9, 0.9, 1.4, 20).translate(0, mmy + 3.2, mmz + 3.4));
  BT.add(M.glass, new THREE.CircleGeometry(0.75, 20).translate(0, mmy + 3.3, mmz + 4.31));
  BT.add(M.gray, rod(V3(0, mmy + 2.3, mmz), V3(0, mmy + 13, mmz - 0.6), 0.14, 10));
  BT.add(M.gray, rod(V3(-2.2, mmy + 10, mmz - 0.5), V3(2.2, mmy + 10, mmz - 0.5), 0.05));
  // 25 mm 三連装機銃（艦橋の前・後部甲板室の上・煙突の間）
  const aa = (x, y, z) => {
    BT.add(M.gray, new THREE.CylinderGeometry(0.6, 0.7, 0.5, 16).translate(x, y + 0.25, z));
    for (const s of [-0.2, 0, 0.2]) BT.add(M.steel, rod(V3(x + s, y + 0.8, z), V3(x + s, y + 1.3, z + 2.2), 0.04));
  };
  aa(0, mmy + 2.3, mmz - 1.2); aa(2.4, upY(TOPSIDE.funnels[1].z + 4), TOPSIDE.funnels[1].z + 4.6); aa(-2.4, upY(TOPSIDE.funnels[1].z + 4), TOPSIDE.funnels[1].z + 4.6);
  aa(3.2, dkY(34), 34.5); aa(-3.2, dkY(34), 34.5);
  // 揚錨機（キャプスタン）・錨・係船柱（船首楼）
  for (const s of [1, -1]) {
    const wz = 56, wy = dkY(wz);
    BT.add(M.dark, new THREE.CylinderGeometry(0.45, 0.55, 0.6, 20).translate(s * 1.1, wy + 0.3, wz));
    BT.add(M.dark, rod(V3(s * 1.1, wy + 0.1, wz + 0.4), V3(s * (hbAt(59.5, wy) - 0.2), wy + 0.05, 59.5), 0.06));
    const ay = dkY(59.8) - 1.1;
    BT.add(M.dark, box(0.14, 1.2, 0.8, s * (hbAt(59.8, ay) + 0.05), ay, 59.8)); // 錨（ホースパイプに収まった姿）
  }
  for (const z of [51, 26.5, 15, -20, -50, -61]) for (const s of [1, -1]) {
    const x = s * (hbAt(z, dkY(z) - 0.05) - 0.5), y = dkY(z);
    if (Math.abs(x) < 1) continue;
    for (const dz of [-0.22, 0.22]) BT.add(M.dark, new THREE.CylinderGeometry(0.13, 0.13, 0.5, 12).translate(x, y + 0.25, z + dz));
  }
  // 爆雷投下軌条（艦尾）と短艇（後部煙突の脇）
  for (const s of [1, -1]) {
    const z0 = -63.2, y = dkY(z0);
    BT.add(M.gray, box(0.9, 0.15, 5.5, s * 1.4, y + 0.3, z0 + 2.5));
    for (let k = 0; k < 6; k++) BT.add(M.dark, new THREE.CylinderGeometry(0.3, 0.3, 0.75, 14).rotateZ(Math.PI / 2).translate(s * 1.4, y + 0.7, z0 + 0.6 + k * 0.8));
    const boat = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), M.gray);
    boat.scale.set(0.9, 0.5, 3.6);
    const bz = TOPSIDE.funnels[1].z - 5.8;
    boat.position.set(s * 3.5, upY(bz) + 2.2, bz);
    boat.castShadow = true;
    top.add(boat);
    for (const dz of [-2.4, 2.4]) BT.add(M.gray, rod(V3(s * 4.6, upY(bz), bz + dz), V3(s * 4.2, upY(bz) + 3.2, bz + dz), 0.07));
  }
  // 旗竿と軍艦旗（艦尾）、艦首旗竿
  const pole = V3(0, dkY(H.Z_MIN + 0.8), H.Z_MIN + 0.8);
  BT.add(M.gray, rod(pole, pole.clone().add(V3(0, 4.2, -0.4)), 0.05));
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.6, 10, 5), new THREE.MeshStandardNodeMaterial({ map: TX.flagTexture(), side: THREE.DoubleSide, roughness: 0.9 }));
  flag.position.copy(pole).add(V3(0, 3.3, -1.6));
  flag.rotation.y = Math.PI / 2;
  top.add(flag);
  BT.add(M.gray, rod(V3(0, dkY(H.Z_MAX - 1.2), H.Z_MAX - 1.2), V3(0, dkY(H.Z_MAX - 1.2) + 3, H.Z_MAX - 0.9), 0.04));
  // 空中線（前檣 → 後檣 → 艦尾）
  const rig = [[V3(0, fTop, fmz - 0.8), V3(0, mmy + 13, mmz - 0.6)], [V3(0, fTop - 2, fmz - 0.8), V3(0, dkY(H.Z_MAX - 1.2) + 3, H.Z_MAX - 0.9)], [V3(0, mmy + 13, mmz - 0.6), pole.clone().add(V3(0, 4.2, -0.4))]];
  top.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(rig.flat()), M.rope));

  const built = B.build(cut);
  BT.build(top);

  // 透視表示: 外殻のメッシュに同じ形のガラスを重ねる。透かした面は影も落とさない（落とすと艦内が外殻の影で暗いまま）
  const frameSet = new Set(Object.values(frameMat));
  const shell = [...hullMeshes, ...built].filter((m) => ghostOf.has(m.material) || frameSet.has(m.material));
  const glassMats = new Map();
  const glass = shell.filter((m) => ghostOf.has(m.material)).map((m) => {
    const o = ghostOf.get(m.material), key = String(o);
    if (!glassMats.has(key)) glassMats.set(key, ghostGlass(xv, o));
    const g = new THREE.Mesh(m.geometry, glassMats.get(key));
    g.renderOrder = 6;
    g.visible = false;
    cut.add(g);
    return g;
  });
  function setXray(on) {
    xv.on.value = on ? 1 : 0;
    for (const m of shell) m.castShadow = !on;
    for (const g of glass) g.visible = on;
  }
  // 船体座標のカメラ位置（透かす面の判定に使う。毎フレーム）
  const setViewer = (camLocal) => xv.camLocal.value.copy(camLocal);
  // raycast の当たり（船体座標の点 p）が透視で透けている面か。描画（ghostHere）と同じ向きで判定する:
  // 決まった船外向きを持つ材質（船首楼の後端壁）は、板の裏の面も透けているので、面の法線で判定すると裏の面に当たってしまう
  const outwardOf = new Map([...ghostOf].filter(([, o]) => o).map(([m, o]) => [m, V3(...o)]));
  const toCam = new THREE.Vector3();
  const isGhost = (hit, p) => xv.on.value > 0.5 && !!hit.face && (outwardOf.get(hit.object.material) ?? hit.face.normal).dot(toCam.copy(xv.camLocal.value).sub(p)) > 0;
  // 上部構造・兵装を隠す（甲板を外す表示）
  const setTopside = (on) => { top.visible = on; };

  // ---------- 破口デカール ----------
  const breachMat = new THREE.MeshStandardNodeMaterial({ map: TX.breachTexture(), transparent: true, depthWrite: false, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -4, side: THREE.DoubleSide });
  function addBreachDecal(center, normal, w, hgt) {
    const d = new THREE.Mesh(new THREE.PlaneGeometry(w * 1.6, hgt * 1.6), breachMat);
    const n = V3(...normal);
    d.quaternion.setFromUnitVectors(V3(0, 0, 1), n);
    d.position.set(...center).addScaledVector(n, 0.02);
    cut.add(d);
    return d;
  }

  // 扉・蓋の開閉アニメーションとプロペラ（spin: 回転の速さ [rad/s]）
  function update(dt, spin = 0) {
    for (const d of doors.values()) {
      d.angle += (d.target - d.angle) * Math.min(1, dt * 3);
      if (d.axis === 'x') d.pivot.rotation.x = d.angle; else d.pivot.rotation.y = d.angle;
    }
    propGroups.forEach((g, i) => { g.rotation.z += (i ? -1 : 1) * spin * dt; });
  }

  const materials = new Set([...built.map((m) => m.material), ...Object.values(M), breachMat]);
  return { group, cut, top, hullMeshes, materials, doors, funnelTops, flag, addBreachDecal, update, setXray, setViewer, setTopside, isGhost };
}
