// 船の 3D モデル。船体は hull.js、船内配置は layout.js から作る（どちらも物理・流体格子と共通の SSOT）。
// 隔壁・甲板・壁は流体格子の板と同じ位置（snapPlane）に置き、水が壁にめり込んで見えないようにする。
import * as THREE from 'three/webgpu';
import { texture, uv, frontFacing, select, vec2, vec3, color, float, positionLocal, mix, smoothstep } from 'three/tsl';
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

export function buildShipModel({ h, draft }) {
  const group = new THREE.Group(); // 剛体に合わせて動かす
  const cut = new THREE.ClippingGroup(); // 断面表示で切る部分（船体・船内・上部構造）
  cut.clippingPlanes = [new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0)];
  cut.enabled = false;
  cut.clipShadows = true; // 切り取った半分が影を落とすと、断面から見た船内が真っ暗になる
  group.add(cut);
  const B = batcher();
  const snapZ = (z) => snapPlane(z, 'z', h), snapX = (x) => snapPlane(x, 'x', h), snapY = (y) => snapPlane(y, 'y', h);
  const deck2 = snapY(Lo.DECK2);

  // ---------- 材質 ----------
  const hullTex = TX.hullTextures(draft);
  const M = {
    hull: mat({ map: hullTex.map, bumpMap: hullTex.bumpMap, bumpScale: 2, roughnessMap: hullTex.roughnessMap, roughness: 1, metalness: 0.25, back: '#7b7f82' }),
    stern: mat({ map: TX.sternTexture(), roughness: 0.55, metalness: 0.25, back: '#7b7f82' }),
    deck: (() => { const t = TX.steelDeckTexture(); return mat({ map: t.map, bumpMap: t.bumpMap, bumpScale: 1.2, repeat: [1, 1], roughness: 0.8, metalness: 0.2, back: '#7b7f82' }); })(),
    checker: (() => { const t = TX.checkerPlateTexture(); return mat({ map: t.map, bumpMap: t.bumpMap, bumpScale: 2, roughness: 0.45, metalness: 0.7, back: '#55595c' }); })(),
    primer: mat({ map: TX.paintTexture('#8f9496', { rust: 30 }), roughness: 0.75, metalness: 0.2, back: '#6a6f72' }),
    bulkhead: mat({ map: TX.paintTexture('#b9bcb8', { rust: 18 }), roughness: 0.7, metalness: 0.15, back: '#7d8285' }),
    cabin: mat({ map: TX.paintTexture('#d8d0bd', { rust: 0, panels: 170 }), roughness: 0.8, back: '#9d9687' }),
    floor: mat({ map: TX.floorTexture(), roughness: 0.6, back: '#5a5246' }),
    white: mat({ map: TX.paintTexture('#ecebe6', { rust: 22 }), roughness: 0.55, metalness: 0.1, back: '#b8b8b2' }),
    green: mat({ map: TX.paintTexture('#3f5a45', { rust: 20 }), roughness: 0.6, metalness: 0.2, back: '#35463a' }),
    red: mat({ tint: '#8e2b22', roughness: 0.6, back: '#6d2019' }),
    steel: mat({ tint: '#50565c', roughness: 0.45, metalness: 0.75, back: '#3d4246' }),
    dark: mat({ tint: '#1a1c1e', roughness: 0.9, back: '#1a1c1e' }),
    engine: mat({ tint: '#5e7f8e', roughness: 0.4, metalness: 0.5, back: '#4a6570' }),
    yellow: mat({ tint: '#d2a21c', roughness: 0.5, metalness: 0.3, back: '#a47d15' }),
    wood: mat({ tint: '#8a6a45', roughness: 0.8, back: '#6b5236' }),
    crate: mat({ map: TX.paintTexture('#9a7b50', { rust: 0, panels: 64 }), roughness: 0.85, back: '#6f5838' }),
    fabric: mat({ tint: '#35507a', roughness: 0.95, back: '#29405f' }),
    glass: (() => { const m = new THREE.MeshPhysicalNodeMaterial({ color: 0x0d1b26, roughness: 0.05, metalness: 0.2, clearcoat: 1, side: THREE.DoubleSide }); return m; })(),
    lamp: (() => { const m = new THREE.MeshStandardNodeMaterial({ color: 0xfff1d0, emissive: 0xffe2b0, emissiveIntensity: 2.5, side: THREE.DoubleSide }); return m; })(),
    funnel: mat({ map: TX.funnelTexture(), roughness: 0.5, metalness: 0.2, back: '#333' }),
    boat: mat({ map: TX.lifeboatTexture(), roughness: 0.5, back: '#b44c14' }),
    bronze: mat({ tint: '#b08d57', roughness: 0.3, metalness: 1, back: '#8a6d42' }),
    rope: new THREE.LineBasicNodeMaterial({ color: 0x1b1b1b }),
  };

  // ---------- 船体外板 ----------
  const NZ = 240, NT = 30, BW = TX.BULWARK;
  const zi = (i) => H.Z_MIN + (H.L * i) / NZ;
  const sidePoint = (side, i, j) => {
    const z = zi(i);
    if (j <= NT) { const s = section(z, j / NT); return [side * s.hb, s.y, z, ...TX.hullUV(side, z, s.y)]; }
    const top = section(z, 1), y = top.y + (BW * (j - NT)) / 3;
    return [side * top.hb * (1 + 0.004 * (j - NT)), y, z, ...TX.hullUV(side, z, y)];
  };
  const hullGeos = [
    orient(grid(NZ, NT + 3, (i, j) => sidePoint(1, i, j)), () => V3(1, 0, 0)),
    orient(grid(NZ, NT + 3, (i, j) => sidePoint(-1, i, j)), () => V3(-1, 0, 0)),
    orient(grid(NZ, 6, (i, j) => { const z = zi(i), s = section(z, 0), x = -s.hb + (2 * s.hb * j) / 6; return [x, s.y, z, ...TX.hullUV(1, z, s.y)]; }), () => V3(0, -1, 0)),
  ];
  const hullMeshes = [];
  for (const g of hullGeos) {
    const m = new THREE.Mesh(g, M.hull);
    m.castShadow = m.receiveShadow = true;
    cut.add(m);
    hullMeshes.push(m);
  }
  // トランサム（船尾の平らな板）: 船名入り
  const transom = orient(grid(NT + 3, 10, (i, j) => {
    const [x, y] = sidePoint(1, 0, i), xx = -x + (2 * x * j) / 10;
    const k = H.keelY(H.Z_MIN), top = H.deckY(H.Z_MIN) + BW;
    return [xx, y, H.Z_MIN, j / 10, (y - k) / (top - k)];
  }), () => V3(0, 0, -1));
  { const m = new THREE.Mesh(transom, M.stern); m.castShadow = m.receiveShadow = true; cut.add(m); hullMeshes.push(m); }
  // ブルワーク上端の縁（手すりの笠木）
  for (const side of [1, -1]) {
    const pts = [];
    for (let i = 0; i <= NZ; i += 2) { const [x, y, z] = sidePoint(side, i, NT + 3); pts.push(V3(x - side * 0.02, y + 0.03, z)); }
    B.add(M.white, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 240, 0.05, 6));
  }

  // ---------- 甲板（厚さ = 上下 2 枚の面。断面で見ると板厚が見える） ----------
  // grid で (z, 横) に張り、holes の範囲の四角形は抜く
  function deckSurface(z0, z1, yOf, holes, material, nz = 180, nx = 28, xLim = null) {
    for (const [dy, side] of [[0, 1], [-T_DECK, -1]]) {
      const hbOf = (z) => Math.max(0, (xLim ? Math.min(xLim, hbAt(z, yOf(z) - 0.01)) : hbAt(z, yOf(z) - 0.01)) - 0.01);
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
  const deckHoles = Lo.SEA_OPENINGS.filter((o) => o.kind === 'hatch').map(openingRect);
  const stair = Lo.DOORS.find((d) => d.id === 'h4');
  deckHoles.push({ x: stair.box.x, z: stair.box.z });
  deckSurface(H.Z_MIN + 0.02, H.Z_MAX - 0.05, (z) => H.deckY(z) + 0.002, deckHoles, M.deck, 240, 32);
  // 二重底の天板（タンクトップ）: 機関室は縞鋼板
  const er = [Lo.BULKHEADS[0], Lo.BULKHEADS[1]];
  const tankZ = (z) => H.keelY(z) < H.TANK_TOP - 0.1;
  let tz0 = H.Z_MIN; while (!tankZ(tz0)) tz0 += 0.05;
  let tz1 = H.Z_MAX; while (!tankZ(tz1)) tz1 -= 0.05;
  const ty = () => H.TANK_TOP;
  deckSurface(tz0, er[0], ty, [], M.primer, 20, 16);
  deckSurface(er[0], er[1], ty, [], M.checker, 40, 16);
  deckSurface(er[1], tz1, ty, [], M.primer, 120, 16);
  // 第 2 甲板（機関室・船倉区画）。ハッチ・ケーシング・ラッタル口は抜く
  const d2holes = Lo.DOORS.filter((d) => typeof d.box.y[0] === 'number' && d.box.y[0] < Lo.DECK2 && d.box.y[1] > Lo.DECK2).map((d) => ({ x: d.box.x, z: d.box.z }));
  deckSurface(snapZ(Lo.BULKHEADS[0]), snapZ(Lo.BULKHEADS[3]), () => deck2 + T_DECK / 2, d2holes, M.primer, 160, 28);
  // 居住区の床（リノリウム）
  deckSurface(snapZ(Lo.BULKHEADS[1]) + 0.05, snapZ(Lo.BULKHEADS[2]) - 0.05, () => deck2 + T_DECK / 2 + 0.01, d2holes, M.floor, 40, 20);
  // 甲板室の床
  deckSurface(Lo.HOUSE.z0 + 0.05, Lo.HOUSE.z1 - 0.05, (z) => H.deckY(z) + 0.012, [{ x: stair.box.x, z: stair.box.z }], M.floor, 30, 20, Lo.HOUSE.hw - 0.05);

  // ---------- 骨組み: 外板内側の肋骨（フレーム）と甲板下のビーム（0.6 m 間隔）。断面表示で船らしい内部に見せる ----------
  for (let z = H.Z_MIN + 0.6; z < H.Z_MAX - 0.4; z += 0.6) {
    if (Lo.BULKHEADS.some((b) => Math.abs(b - z) < 0.2)) continue;
    const y0 = Math.max(H.TANK_TOP, H.keelY(z) + 0.05), y1 = H.deckY(z) - 0.08;
    if (hbAt(z, (y0 + y1) / 2) < 0.6) continue;
    for (const sgn of [1, -1]) {
      const pts = [];
      for (let k = 0; k <= 10; k++) { const y = y0 + ((y1 - y0) * k) / 10; pts.push([sgn * (hbAt(z, y) - 0.02), y]); }
      // 外板に沿った細い帯（奥行き 0.14 m、厚さ 0.03 m）
      const strip = pts.map(([x, y]) => [x - sgn * 0.14, y]).reverse();
      B.add(M.primer, plate([...pts, ...strip], [], 0.03, (a, b, c) => [a, b, z + c], 0.3));
    }
    // 上甲板の下のビーム（甲板室の床下と船室の天井は省略しない。見えるのは断面だけ）
    // 開口（ハッチ・ケーシング・階段）の上を横切るビームは置かない
    const crosses = (holes) => holes.some((r) => z > r.z[0] - 0.05 && z < r.z[1] + 0.05);
    const yd = H.deckY(z) - 0.1, hb = hbAt(z, yd) - 0.05;
    if (hb > 0.5 && !crosses(deckHoles)) B.add(M.primer, box(2 * hb, 0.16, 0.08, 0, yd, z));
    if (z > Lo.BULKHEADS[0] && z < Lo.BULKHEADS[3] && !crosses(d2holes)) { const hb2 = hbAt(z, deck2) - 0.05; if (hb2 > 0.5) B.add(M.primer, box(2 * hb2, 0.14, 0.07, 0, deck2 - 0.11, z)); }
  }

  // ---------- 隔壁・壁（layout.PLATES）。扉・ハッチの位置は穴にする ----------
  // 板 p（面の座標 at）を貫く扉。面の座標が扉の範囲に入り、板の広がりとも重なるものだけ
  const overlap = (a, b) => a && b && Math.min(a[1], b[1]) > Math.max(a[0], b[0]);
  const doorHoles = (p) => Lo.DOORS.filter((d) => {
    const r = d.box[p.axis];
    if (!(p.at >= r[0] && p.at <= r[1])) return false;
    return ['x', 'z'].filter((a) => a !== p.axis).every((a) => !p.span[a] || overlap(d.box[a], p.span[a]));
  });
  const matFor = (p) => (p.span.y && p.span.y[0] === Lo.DECK2 && p.axis !== 'y' ? M.cabin : (p.span.y && p.span.y[0] === 'deck' ? M.cabin : M.bulkhead));
  for (const p of Lo.PLATES) {
    if (p.axis === 'z') {
      const z = snapZ(p.at);
      const y0 = typeof p.span.y[0] === 'number' ? p.span.y[0] : H.deckY(z), y1 = Lo.resolveY(p.span.y[1], z);
      const inHouse = p.span.y[0] === 'deck';
      const x0 = Math.max(p.span.x[0], inHouse ? -Lo.HOUSE.hw : -INF), x1 = Math.min(p.span.x[1], inHouse ? Lo.HOUSE.hw : INF);
      const outline = inHouse ? rect(x0, x1, y0, y1) : sectionOutline(z, Math.max(y0, H.keelY(z)), y1 - 0.01, x0, x1);
      const holes = doorHoles(p).map((d) => rect(Math.max(x0 + 0.05, d.box.x[0]), Math.min(x1 - 0.05, d.box.x[1]), Lo.resolveY(d.box.y[0], z) + 0.01, Lo.resolveY(d.box.y[1], z)));
      B.add(matFor(p), plate(outline, holes, T_PLATE, (a, b, c) => [a, b, z + c], 0.3));
      // 補強材（縦の平鋼、0.6 m ごと）。隔壁の片面だけ
      if (!inHouse && p.span.x[0] === -INF) for (let x = -3.3; x <= 3.3; x += 0.6) {
        const hb = hbAt(z, (y0 + y1) / 2);
        if (Math.abs(x) > hb - 0.1) continue;
        if (doorHoles(p).some((d) => x > d.box.x[0] - 0.1 && x < d.box.x[1] + 0.1)) continue;
        B.add(M.bulkhead, box(0.02, y1 - y0 - 0.1, 0.12, x, (y0 + y1) / 2, z - 0.09));
      }
    } else if (p.axis === 'x') {
      const x = snapX(p.at);
      const zz = [p.span.z[0], p.span.z[1]].map(snapZ);
      const n = 16, outline = [];
      for (let i = 0; i <= n; i++) outline.push([zz[0] + ((zz[1] - zz[0]) * i) / n, Lo.resolveY(p.span.y[0], zz[0])]);
      for (let i = n; i >= 0; i--) { const z = zz[0] + ((zz[1] - zz[0]) * i) / n; outline.push([z, Lo.resolveY(p.span.y[1], z) - 0.01]); }
      const holes = doorHoles(p).map((d) => rect(d.box.z[0], d.box.z[1], Lo.resolveY(d.box.y[0], 0) + 0.01, Lo.resolveY(d.box.y[1], 0)));
      B.add(M.cabin, plate(outline, holes, T_PLATE, (a, b, c) => [x + c, b, a], 0.3));
    }
  }
  // 甲板室の外壁と屋根（扉は穴）
  const hz0 = Lo.HOUSE.z0, hz1 = Lo.HOUSE.z1, hw = Lo.HOUSE.hw, top = Lo.HOUSE.top;
  const doorOf = (id) => Lo.SEA_OPENINGS.find((o) => o.id === id);
  const sideWall = (sgn, hole) => {
    const n = 12, outline = [];
    for (let i = 0; i <= n; i++) { const z = hz0 + ((hz1 - hz0) * i) / n; outline.push([z, H.deckY(z)]); }
    outline.push([hz1, top], [hz0, top]);
    const o = doorOf(hole);
    const holes = [[[o.center[2] - o.half[0], o.center[1] - o.half[1]], [o.center[2] + o.half[0], o.center[1] - o.half[1]], [o.center[2] + o.half[0], o.center[1] + o.half[1]], [o.center[2] - o.half[0], o.center[1] + o.half[1]]]];
    // 窓
    for (let z = hz0 + 0.8; z < hz1 - 0.5; z += 1.3) if (Math.abs(z - o.center[2]) > 1.0) holes.push(rect(z - 0.35, z + 0.35, H.deckY(z) + 1.2, H.deckY(z) + 1.9));
    B.add(M.white, plate(outline, holes, 0.1, (a, b, c) => [sgn * (hw + c), b, a], 0.25));
    for (let z = hz0 + 0.8; z < hz1 - 0.5; z += 1.3) if (Math.abs(z - o.center[2]) > 1.0) {
      const g = new THREE.PlaneGeometry(0.7, 0.7).rotateY((sgn * Math.PI) / 2); g.translate(sgn * hw, H.deckY(z) + 1.55, z); B.add(M.glass, g);
    }
  };
  sideWall(1, 'o3'); sideWall(-1, 'o4');
  { // 前面（扉と窓）・後面
    const o = doorOf('o5'), y0 = H.deckY(hz1);
    const holes = [rect(o.center[0] - o.half[0], o.center[0] + o.half[0], o.center[1] - o.half[1], o.center[1] + o.half[1])];
    for (const x of [-1.8, 1.8]) holes.push(rect(x - 0.4, x + 0.4, y0 + 1.1, y0 + 1.9));
    B.add(M.white, plate(rect(-hw - 0.05, hw + 0.05, y0, top), holes, 0.1, (a, b, c) => [a, b, hz1 + c], 0.25));
    for (const x of [-1.8, 1.8]) { const g = new THREE.PlaneGeometry(0.8, 0.8); g.translate(x, y0 + 1.5, hz1 + 0.01); B.add(M.glass, g); }
    B.add(M.white, plate(rect(-hw - 0.05, hw + 0.05, H.deckY(hz0), top), [], 0.1, (a, b, c) => [a, b, hz0 + c], 0.25));
    B.add(M.white, box(2 * hw + 0.3, 0.12, hz1 - hz0 + 0.3, 0, top + 0.06, (hz0 + hz1) / 2)); // 屋根（= 船橋甲板）
  }

  // ---------- 扉（水密扉は開閉できる。甲板室の外扉も） ----------
  const doors = new Map();
  function hingedDoor(id, w, hgt, pos, axis, openSign, material) {
    const pivot = new THREE.Group();
    pivot.position.copy(pos);
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(axis === 'z' ? w : 0.05, hgt, axis === 'z' ? 0.05 : w), material);
    leaf.position.set(axis === 'z' ? w / 2 : 0, hgt / 2, axis === 'z' ? 0 : w / 2);
    leaf.castShadow = leaf.receiveShadow = true;
    pivot.add(leaf);
    // 取っ手（水密扉のハンドル）
    const handle = new THREE.Mesh(new THREE.BoxGeometry(axis === 'z' ? 0.08 : 0.12, 0.3, axis === 'z' ? 0.12 : 0.08), M.yellow);
    handle.position.set(axis === 'z' ? w * 0.85 : 0, hgt * 0.5, axis === 'z' ? 0 : w * 0.85);
    pivot.add(handle);
    cut.add(pivot);
    const d = { pivot, target: 0, angle: 0, openAngle: openSign * 1.75 };
    d.set = (open) => { d.target = open ? d.openAngle : 0; };
    doors.set(id, d);
    return d;
  }
  for (const d of Lo.DOORS.filter((x) => x.wt)) {
    const z = snapZ((d.box.z[0] + d.box.z[1]) / 2);
    const y0 = Lo.resolveY(d.box.y[0], z), y1 = Lo.resolveY(d.box.y[1], z);
    const w = d.box.x[1] - d.box.x[0];
    // 枠（コーミング）
    for (const [a, b, c, dd] of [[d.box.x[0] - 0.06, y0, 0.08, y1 - y0], [d.box.x[1] - 0.02, y0, 0.08, y1 - y0]]) B.add(M.steel, box(c, dd, 0.14, a + 0.04, b + dd / 2, z));
    B.add(M.steel, box(w + 0.16, 0.08, 0.14, (d.box.x[0] + d.box.x[1]) / 2, y1 + 0.02, z));
    const door = hingedDoor(d.id, w, y1 - y0 - 0.02, V3(d.box.x[0], y0 + 0.01, z + 0.06), 'z', -1, M.steel);
    door.set(d.open);
  }
  for (const id of ['o3', 'o4', 'o5']) {
    const o = doorOf(id);
    const y0 = o.center[1] - o.half[1];
    if (id === 'o5') hingedDoor(id, 2 * o.half[0], 2 * o.half[1], V3(o.center[0] - o.half[0], y0, o.center[2] + 0.06), 'z', 1, M.white).set(o.open);
    else hingedDoor(id, 2 * o.half[0], 2 * o.half[1], V3(o.center[0] + Math.sign(o.center[0]) * 0.06, y0, o.center[2] - o.half[0]), 'x', -Math.sign(o.center[0]), M.white).set(o.open);
  }
  // ハッチの蓋（船首倉庫・昇降口）: 開いた状態で立てる
  for (const o of Lo.SEA_OPENINGS.filter((x) => x.kind === 'hatch')) {
    const [cx, cy, cz] = o.center, [a, b] = o.half;
    for (const [w, d, x, z] of [[2 * a + 0.1, 0.05, cx, cz - b - 0.025], [2 * a + 0.1, 0.05, cx, cz + b + 0.025], [0.05, 2 * b, cx - a - 0.025, cz], [0.05, 2 * b, cx + a + 0.025, cz]]) B.add(M.green, box(w, 0.45, d, x, cy + 0.225, z));
    const pivot = new THREE.Group();
    pivot.position.set(cx, cy + 0.45, cz + b + 0.05);
    const lid = new THREE.Mesh(new THREE.BoxGeometry(2 * a + 0.1, 0.06, 2 * b + 0.1), M.green);
    lid.position.set(0, 0, -(b + 0.05));
    lid.castShadow = true;
    pivot.add(lid);
    cut.add(pivot);
    const d = { pivot, target: 0, angle: 0, openAngle: -1.9, axis: 'x' };
    d.set = (open) => { d.target = open ? d.openAngle : 0; };
    d.set(o.open);
    doors.set(o.id, d);
  }

  // ---------- 船内の設備 ----------
  const B2 = Lo.BULKHEADS;
  // 機関室: 主機（6 気筒）、過給機、排気管（ケーシングを通って煙突へ）、発電機、配管、操作盤
  const eng = Lo.OBSTACLES.find((o) => o.name === '主機関').box;
  const ey1 = eng.y[1];
  B.add(M.engine, box(eng.x[1] - eng.x[0] - 0.1, ey1 - H.TANK_TOP - 0.3, eng.z[1] - eng.z[0] - 0.1, 0, (H.TANK_TOP + ey1 - 0.3) / 2, (eng.z[0] + eng.z[1]) / 2));
  for (let c = 0; c < 6; c++) {
    const z = eng.z[0] + 0.45 + c * ((eng.z[1] - eng.z[0] - 0.9) / 5);
    B.add(M.engine, box(1.1, 0.35, 0.5, 0, ey1 - 0.15, z));
    B.add(M.steel, box(0.9, 0.12, 0.42, 0, ey1 + 0.08, z));
    B.add(M.steel, rod(V3(0.45, ey1 - 0.1, z), V3(0.8, ey1 + 0.2, eng.z[1] - 0.2), 0.06));
  }
  B.add(M.steel, box(0.3, 0.3, eng.z[1] - eng.z[0] - 0.4, 0.85, ey1 + 0.25, (eng.z[0] + eng.z[1]) / 2)); // 排気集合管
  B.add(M.engine, new THREE.CylinderGeometry(0.35, 0.35, 0.6, 20).rotateZ(Math.PI / 2).translate(0.85, ey1 + 0.3, eng.z[1] + 0.1)); // 過給機
  const funnelZ = -10.8;
  B.add(M.steel, rod(V3(0.85, ey1 + 0.3, eng.z[1] + 0.1), V3(0.6, deck2 + 1.0, funnelZ), 0.2, 14));
  B.add(M.steel, rod(V3(0.6, deck2 + 1.0, funnelZ), V3(0.6, 13.2, funnelZ), 0.2, 14));
  const gen = Lo.OBSTACLES.find((o) => o.name === '発電機').box;
  B.add(M.yellow, box(gen.x[1] - gen.x[0] - 0.1, gen.y[1] - gen.y[0] - 0.05, gen.z[1] - gen.z[0] - 0.1, (gen.x[0] + gen.x[1]) / 2, (gen.y[0] + gen.y[1]) / 2, (gen.z[0] + gen.z[1]) / 2));
  for (let y = 1.4; y < 2.8; y += 0.35) B.add(M.red, rod(V3(-2.9, y, B2[0] + 0.4), V3(-2.9, y, B2[1] - 0.4), 0.05)); // 配管
  B.add(M.steel, box(0.5, 1.8, 1.6, -2.4, deck2 + 0.95, -11.3)); // 配電盤
  // 機関室ケーシングの手すり
  const casing = Lo.DOORS.find((d) => d.id === 'h2').box;
  for (const x of casing.x) B.add(M.yellow, rod(V3(x, deck2 + 1.0, casing.z[0]), V3(x, deck2 + 1.0, casing.z[1]), 0.025));
  for (const z of casing.z) B.add(M.yellow, rod(V3(casing.x[0], deck2 + 1.0, z), V3(casing.x[1], deck2 + 1.0, z), 0.025));
  for (const x of casing.x) for (let z = casing.z[0]; z <= casing.z[1] + 0.01; z += 1.15) B.add(M.yellow, rod(V3(x, deck2, z), V3(x, deck2 + 1.0, z), 0.02));
  // 階段（機関室上段 → 甲板室）とラッタル（第2船倉）
  const stairs = (x0, x1, zA, zB, yA, yB, n = 10) => {
    for (let i = 0; i < n; i++) {
      const f = (i + 0.5) / n;
      B.add(M.steel, box(x1 - x0, 0.04, Math.abs(zB - zA) / n * 1.2, (x0 + x1) / 2, yA + (yB - yA) * f, zA + (zB - zA) * f));
    }
    for (const x of [x0, x1]) B.add(M.yellow, rod(V3(x, yA + 0.9, zA), V3(x, yB + 0.9, zB), 0.025));
  };
  stairs(stair.box.x[0] + 0.05, stair.box.x[1] - 0.05, -7.4, stair.box.z[0] + 0.1, deck2, H.deckY(-9.5));
  const lad = Lo.DOORS.find((d) => d.id === 'h1').box;
  for (const x of [lad.x[0] + 0.15, lad.x[1] - 0.15]) B.add(M.steel, rod(V3(x, H.TANK_TOP, lad.z[0] + 0.1), V3(x, deck2 + 0.9, lad.z[0] + 0.1), 0.02));
  for (let y = H.TANK_TOP + 0.3; y < deck2; y += 0.3) B.add(M.steel, rod(V3(lad.x[0] + 0.15, y, lad.z[0] + 0.1), V3(lad.x[1] - 0.15, y, lad.z[0] + 0.1), 0.015));
  // 昇降口の階段（通路 → 上甲板）と甲板上の小屋
  const cw = doorOf('o2');
  stairs(cw.center[0] - 0.35, cw.center[0] + 0.35, cw.center[2] + cw.half[1] - 1.5, cw.center[2] + cw.half[1] - 0.1, deck2, H.deckY(cw.center[2]) - 0.1, 9);
  // 貨物（木箱の山）
  for (const o of Lo.OBSTACLES.filter((x) => x.name === '貨物')) {
    const { x, y, z } = o.box;
    for (let a = x[0]; a < x[1] - 0.2; a += 1.1) for (let c = z[0]; c < z[1] - 0.2; c += 1.5) for (let b = y[0]; b < y[1] - 0.2; b += 0.6) {
      B.add(M.crate, box(Math.min(1.05, x[1] - a) - 0.05, Math.min(0.58, y[1] - b), Math.min(1.45, z[1] - c) - 0.05, a + Math.min(1.05, x[1] - a) / 2, b + Math.min(0.58, y[1] - b) / 2, c + Math.min(1.45, z[1] - c) / 2));
    }
  }
  // 船室: 寝台・ロッカー・机
  for (const r of Lo.ROOMS.filter((x) => x.name.startsWith('船室'))) {
    const side = r.box.x[0] > 0 ? 1 : -1, zc = (r.box.z[0] + r.box.z[1]) / 2, zw = r.box.z[1] - r.box.z[0];
    const xOut = side * (hbAt(zc, deck2 + 1) - 0.5);
    B.add(M.wood, box(0.85, 0.35, Math.min(2.0, zw - 0.3), xOut, deck2 + 0.25, zc));
    B.add(M.fabric, box(0.8, 0.12, Math.min(1.9, zw - 0.4), xOut, deck2 + 0.48, zc));
    B.add(M.wood, box(0.85, 0.06, Math.min(2.0, zw - 0.3), xOut, deck2 + 1.35, zc));
    B.add(M.fabric, box(0.8, 0.1, Math.min(1.9, zw - 0.4), xOut, deck2 + 1.43, zc));
    B.add(M.cabin, box(0.6, 1.8, 0.5, side * 1.1, deck2 + 0.9, r.box.z[1] - 0.35)); // ロッカー
    B.add(M.lamp, box(0.3, 0.03, 0.3, side * 1.8, Lo.resolveY('deck', zc) - 0.03, zc));
  }
  // 食堂: テーブルと長椅子
  const mess = Lo.ROOMS.find((x) => x.name === '食堂').box;
  for (const z of [0.6, 2.6]) {
    B.add(M.wood, box(1.6, 0.05, 0.8, -2.0, deck2 + 0.75, z));
    B.add(M.steel, box(0.08, 0.7, 0.08, -2.0, deck2 + 0.38, z));
    for (const dz of [-0.6, 0.6]) B.add(M.fabric, box(1.5, 0.45, 0.4, -2.0, deck2 + 0.23, z + dz));
  }
  B.add(M.lamp, box(0.4, 0.03, 0.4, -1.9, H.deckY((mess.z[0] + mess.z[1]) / 2) - 0.03, 1.6));
  // 通路の天井灯
  for (let z = -3.8; z < 3.8; z += 1.8) B.add(M.lamp, box(0.25, 0.03, 0.25, 0, H.deckY(z) - 0.03, z));
  // 甲板室: サロン（ソファ・テーブル）と調理室（調理台）
  const fy = (z) => H.deckY(z);
  B.add(M.fabric, box(0.7, 0.45, 2.6, -2.2, fy(-10.5) + 0.23, -10.5));
  B.add(M.fabric, box(2.0, 0.45, 0.7, -1.2, fy(-11.8) + 0.23, -11.9));
  B.add(M.wood, box(1.0, 0.05, 1.6, -1.3, fy(-10.4) + 0.7, -10.4));
  B.add(M.steel, box(0.7, 0.9, 3.2, 2.3, fy(-6) + 0.45, -6.2));
  B.add(M.steel, box(2.4, 0.9, 0.7, 0.9, fy(-5.0) + 0.45, -8.1));
  B.add(M.dark, box(0.66, 0.02, 0.8, 2.3, fy(-6) + 0.91, -5.4));
  for (const z of [-10.5, -6.5]) B.add(M.lamp, box(0.4, 0.03, 0.4, 0, top - 0.03, z));
  // 操舵機室: 舵頭と油圧シリンダ
  B.add(M.engine, new THREE.CylinderGeometry(0.2, 0.2, 2.2, 16).translate(0, 2.4, -13.6));
  B.add(M.yellow, box(2.2, 0.35, 0.35, 0, 2.2, -13.6));
  // 船首倉庫: 錨鎖の山
  for (let i = 0; i < 12; i++) B.add(M.dark, new THREE.TorusGeometry(0.4 - i * 0.02, 0.06, 6, 16).rotateX(Math.PI / 2).translate(0, H.TANK_TOP + 1.2 + i * 0.1, 12.3));

  // ---------- 上甲板の艤装 ----------
  // 第1船倉のハッチコーミングと蓋（閉じている）
  const hc = { x: [-2.3, 2.3], z: [5.2, 10.2] };
  for (const [w, d, x, z] of [[4.7, 0.1, 0, hc.z[0]], [4.7, 0.1, 0, hc.z[1]], [0.1, 5.0, hc.x[0], 7.7], [0.1, 5.0, hc.x[1], 7.7]]) B.add(M.green, box(w, 0.8, d, x, H.deckY(z) + 0.4, z));
  for (let z = hc.z[0]; z < hc.z[1] - 0.1; z += 1.25) {
    B.add(M.green, box(4.7, 0.12, 1.2, 0, H.deckY(7.7) + 0.86, z + 0.62));
    B.add(M.green, box(4.7, 0.08, 0.06, 0, H.deckY(7.7) + 0.95, z + 0.02));
  }
  // デリックポスト（荷役柱）とブーム
  for (const z of [4.4, 11.0]) {
    const y0 = H.deckY(z);
    B.add(M.white, rod(V3(0, y0, z), V3(0, y0 + 6.5, z), 0.22, 16));
    B.add(M.white, rod(V3(-1.2, y0 + 5.8, z), V3(1.2, y0 + 5.8, z), 0.08));
    B.add(M.yellow, rod(V3(0, y0 + 1.2, z + (z < 6 ? 0.25 : -0.25)), V3(0, y0 + 4.0, z < 6 ? 8.5 : 7.8), 0.1));
  }
  // 前部マストと灯
  const fmY = H.deckY(11.0) + 6.5;
  B.add(M.lamp, new THREE.SphereGeometry(0.1, 10, 8).translate(0, fmY + 0.15, 11.0));
  // 揚錨機・錨・係船柱
  const wz = 13.0, wy = H.deckY(wz);
  B.add(M.green, box(1.8, 0.5, 0.8, 0, wy + 0.25, wz));
  for (const s of [1, -1]) {
    B.add(M.steel, new THREE.CylinderGeometry(0.28, 0.28, 0.4, 20).rotateZ(Math.PI / 2).translate(s * 0.6, wy + 0.55, wz));
    B.add(M.dark, rod(V3(s * 0.6, wy + 0.4, wz + 0.3), V3(s * (hbAt(12.7, wy) - 0.2), wy + 0.05, 12.7 - 0.2), 0.05));
    const ax = s * (hbAt(12.7, H.deckY(12.7) - 0.9) + 0.05);
    B.add(M.dark, box(0.12, 0.9, 0.6, ax, H.deckY(12.7) - 0.9, 12.7)); // 錨（ホースパイプに収まった姿）
  }
  for (const z of [13.8, 9.0, 3.8, -4.0, -13.0, -14.3]) for (const s of [1, -1]) {
    const x = s * (hbAt(z, H.deckY(z) - 0.05) - 0.45), y = H.deckY(z);
    for (const dz of [-0.2, 0.2]) B.add(M.dark, new THREE.CylinderGeometry(0.11, 0.11, 0.45, 12).translate(x, y + 0.22, z + dz));
    B.add(M.dark, box(0.3, 0.06, 0.7, x, y + 0.03, z));
  }
  // 通風筒（マッシュルーム型）
  // 通風筒（layout の vent の位置にも置く。沈んだときの浸水経路）
  for (const [x, z] of [[2.4, 1.0], [-2.4, 1.0], [2.4, -2.5], [-2.4, 11.8], ...Lo.SEA_OPENINGS.filter((o) => o.kind === 'vent').map((o) => [o.center[0], o.center[2]])]) {
    const y = H.deckY(z);
    B.add(M.white, new THREE.CylinderGeometry(0.16, 0.16, 0.9, 14).translate(x, y + 0.45, z));
    B.add(M.white, new THREE.CylinderGeometry(0.3, 0.3, 0.15, 16).translate(x, y + 0.95, z));
  }
  // 船尾: 係船機・旗竿・救命浮環
  B.add(M.green, box(1.4, 0.45, 0.7, 0, H.deckY(-14) + 0.23, -14.2));
  const pole = V3(0, H.deckY(H.Z_MIN) + BW, H.Z_MIN + 0.25);
  B.add(M.white, rod(pole, pole.clone().add(V3(0, 1.8, -0.3)), 0.03));
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.6, 10, 5), new THREE.MeshStandardNodeMaterial({ map: TX.flagTexture(), side: THREE.DoubleSide, roughness: 0.9 }));
  flag.position.copy(pole).add(V3(0, 1.45, -0.72));
  flag.rotation.y = Math.PI / 2;
  cut.add(flag);
  const buoyMat = mat({ tint: '#e8561c', roughness: 0.6 });
  for (const [x, z] of [[2.8, -12.0], [-2.8, -12.0], [3.2, 2.0], [-3.2, 2.0]]) B.add(buoyMat, new THREE.TorusGeometry(0.33, 0.08, 8, 20).rotateY(Math.PI / 2).translate(Math.sign(x) * (hbAt(z, H.deckY(z) - 0.1) + 0.02), H.deckY(z) + 0.6, z));

  // ---------- 船橋（2 層目、描画のみ）・煙突・マスト・救命艇 ----------
  const bz0 = -12.0, bz1 = -6.2, bw = 2.5, by0 = top + 0.12, by1 = by0 + 2.4;
  B.add(M.white, box(2 * bw, by1 - by0, bz1 - bz0, 0, (by0 + by1) / 2, (bz0 + bz1) / 2));
  B.add(M.white, box(2 * bw + 2.2, 0.12, 1.6, 0, by1 - 0.5, bz1 - 0.9)); // ウイング
  B.add(M.white, box(2 * bw + 0.8, 0.14, bz1 - bz0 + 0.9, 0, by1 + 0.07, (bz0 + bz1) / 2 + 0.2)); // 屋根
  for (let k = 0; k < 7; k++) { // 前面窓（前傾）
    const g = new THREE.PlaneGeometry(0.62, 0.95); g.rotateX(-0.15); g.translate(-2.1 + k * 0.7, by1 - 0.8, bz1 + 0.02); B.add(M.glass, g);
  }
  for (const s of [1, -1]) for (let k = 0; k < 4; k++) {
    const g = new THREE.PlaneGeometry(0.8, 0.8).rotateY((s * Math.PI) / 2); g.translate(s * (bw + 0.01), by1 - 0.85, bz0 + 1.0 + k * 1.2); B.add(M.glass, g);
  }
  for (const s of [1, -1]) { // 航海灯（左舷 赤 / 右舷 緑）
    const lm = new THREE.MeshStandardNodeMaterial({ color: s > 0 ? 0xff2020 : 0x20ff50, emissive: s > 0 ? 0xff2020 : 0x20ff50, emissiveIntensity: 4 });
    const l = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), lm);
    l.position.set(s * (bw + 1.05), by1 - 0.3, bz1 - 0.9);
    cut.add(l);
  }
  // 煙突（楕円・後傾）
  const funnel = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.9, 3.2, 40, 1, true), M.funnel);
  funnel.scale.x = 0.7;
  funnel.position.set(0, by1 + 1.5, funnelZ);
  funnel.rotation.x = -0.12;
  funnel.castShadow = true;
  cut.add(funnel);
  const funnelTop = new THREE.Object3D();
  funnelTop.position.set(0, 1.7, 0);
  funnel.add(funnelTop);
  B.add(M.dark, new THREE.CylinderGeometry(0.2, 0.2, 0.5, 12).translate(0.2, by1 + 3.1, funnelZ - 0.25));
  // マストとレーダー
  const mz = -7.4, mastTop = by1 + 4.8;
  B.add(M.white, rod(V3(0, by1, mz), V3(0, mastTop, mz), 0.1, 12));
  B.add(M.white, rod(V3(-1.2, mastTop - 1.4, mz), V3(1.2, mastTop - 1.4, mz), 0.05));
  B.add(M.lamp, new THREE.SphereGeometry(0.1, 10, 8).translate(0, mastTop + 0.1, mz));
  const radar = new THREE.Group();
  radar.position.set(0, mastTop - 1.9, mz);
  const radarBar = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.16, 0.2), M.steel);
  radarBar.position.y = 0.2;
  radar.add(radarBar, new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), M.white));
  cut.add(radar);
  const rig = [[V3(0, mastTop, mz), V3(0, fmY, 11.0)], [V3(0, mastTop - 1.4, mz), V3(2.4, top + 0.1, -4.8)], [V3(0, mastTop - 1.4, mz), V3(-2.4, top + 0.1, -4.8)], [V3(0, fmY, 11.0), V3(0, H.deckY(14.6) + BW, 14.6)]];
  const rigLines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(rig.flat()), M.rope);
  cut.add(rigLines);
  // 救命艇とダビット
  for (const s of [1, -1]) {
    const boat = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 14), M.boat);
    boat.scale.set(0.9, 0.55, 2.9);
    boat.position.set(s * 3.1, top + 1.1, -9.3);
    boat.castShadow = true;
    cut.add(boat);
    for (const dz of [-2.0, 2.0]) {
      B.add(M.white, rod(V3(s * 2.4, top + 0.1, -9.3 + dz), V3(s * 2.6, top + 2.2, -9.3 + dz), 0.07));
      B.add(M.white, rod(V3(s * 2.6, top + 2.2, -9.3 + dz), V3(s * 3.2, top + 2.0, -9.3 + dz), 0.06));
    }
  }
  // 手すり（船橋甲板の周囲）
  const railPts = [V3(-bw - 0.3, top + 0.12, hz0 + 0.1), V3(-bw - 0.3, top + 0.12, hz1 - 0.1), V3(bw + 0.3, top + 0.12, hz1 - 0.1), V3(bw + 0.3, top + 0.12, hz0 + 0.1)];
  for (let i = 0; i < railPts.length; i++) {
    const a = railPts[i], b = railPts[(i + 1) % railPts.length];
    for (const dy of [0.5, 1.0]) B.add(M.white, rod(a.clone().add(V3(0, dy, 0)), b.clone().add(V3(0, dy, 0)), 0.025, 6));
    const n = Math.round(a.distanceTo(b) / 1.2);
    for (let k = 0; k <= n; k++) { const p = a.clone().lerp(b, k / n); B.add(M.white, rod(p, p.clone().add(V3(0, 1.0, 0)), 0.02, 6)); }
  }

  // ---------- 舵とプロペラ ----------
  B.add(M.red, box(0.18, 2.2, 1.5, 0, 1.6, -14.6));
  const prop = new THREE.Group();
  prop.position.set(0, 1.35, -13.75);
  cut.add(prop);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.25, 0.5, 16).rotateX(Math.PI / 2), M.bronze);
  prop.add(hub);
  for (let k = 0; k < 4; k++) {
    const blade = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 8), M.bronze);
    blade.scale.set(0.28, 0.7, 0.05);
    const a = (k * Math.PI) / 2;
    blade.position.set(Math.sin(a) * 0.6, Math.cos(a) * 0.6, 0);
    blade.rotation.set(0, 0.45, -a);
    prop.add(blade);
  }
  B.add(M.steel, rod(V3(0, 1.35, -12.5), V3(0, 1.35, -13.6), 0.14, 12));
  // 船底の縦材（キール）
  B.add(M.red, box(0.25, 0.25, 22, 0, -0.12, -1));

  const built = B.build(cut);

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

  // 扉の開閉アニメーション
  function update(dt) {
    for (const d of doors.values()) {
      d.angle += (d.target - d.angle) * Math.min(1, dt * 3);
      if (d.axis === 'x') d.pivot.rotation.x = d.angle; else d.pivot.rotation.y = d.angle;
    }
  }

  const materials = new Set([...built.map((m) => m.material), ...Object.values(M), breachMat]);
  return { group, cut, hullMeshes, materials, doors, radar, prop, funnelTop, flag, addBreachDecal, update };
}
