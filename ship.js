// 船の 3D モデル。船体形状は hull.js（物理と共通）から作り、上部構造や艤装は見た目だけ（物理は SHIP_MASS に含める）
import * as THREE from 'three';
import * as H from './hull.js';
import * as TX from './textures.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const BULWARK = 0.15; // ブルワーク（舷側の立ち上がり）の高さ

// (i, j) の格子から面を作る。fn(i, j) → [x, y, z, u, v]
function grid(nu, nv, fn) {
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) { const [x, y, z, u, v] = fn(i, j); pos.push(x, y, z); uv.push(u, v); }
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) { const a = i * (nv + 1) + j, b = a + nv + 1; idx.push(a, b, a + 1, b, b + 1, a + 1); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// 面の向き（表裏）を outward 方向に揃える。格子の張り方で向きが変わるので生成後に判定する
function orient(g, outward) {
  const n = g.attributes.normal, p = new THREE.Vector3(), nn = new THREE.Vector3();
  let score = 0;
  for (let k = 0; k < n.count; k++) score += nn.fromBufferAttribute(n, k).dot(outward(p.fromBufferAttribute(g.attributes.position, k)));
  if (score < 0) {
    const idx = g.index.array;
    for (let k = 0; k < idx.length; k += 3) [idx[k + 1], idx[k + 2]] = [idx[k + 2], idx[k + 1]];
    g.index.needsUpdate = true;
    g.computeVertexNormals();
  }
  return g;
}

// 断面 z の高さ比 t（0 船底 → 1 甲板）での半幅と高さ
function rawSection(z, t) {
  const k = H.keelY(z), d = H.deckY(z), y = k + (d - k) * t;
  return { y, hb: Math.max(0, H.halfBreadth(z, Math.min(d - 1e-6, Math.max(k + 1e-6, y)))) };
}
// 船首では船首材の傾きで断面の下側に幅が無い。幅が出る最下点 t0 を探し、t0..1 に段を張り直す
// （幅 0 の段を中心線上に潰すと、船首が階段状の面になる）
function bottomT(z) {
  if (rawSection(z, 0).hb > 1e-3) return 0;
  if (rawSection(z, 1).hb <= 1e-3) return 1;
  let lo = 0, hi = 1;
  for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (rawSection(z, m).hb > 1e-3) hi = m; else lo = m; }
  return hi;
}
function section(z, t) {
  const t0 = bottomT(z);
  return rawSection(z, t0 + (1 - t0) * t);
}

export function buildShip(waterline) {
  const group = new THREE.Group();
  const add = (mesh, parent = group) => { mesh.castShadow = mesh.receiveShadow = true; parent.add(mesh); return mesh; };

  // ---------- 材質 ----------
  const hullTex = TX.hullTextures(waterline);
  const hullMat = new THREE.MeshStandardMaterial({ map: hullTex.map, bumpMap: hullTex.bumpMap, bumpScale: 1.5, roughness: 0.55, metalness: 0.2 });
  const innerMat = new THREE.MeshStandardMaterial({ map: TX.paintTexture('#5b6166'), roughness: 0.85, side: THREE.BackSide });
  const bulkheadMat = new THREE.MeshStandardMaterial({ map: TX.paintTexture('#8d9398'), roughness: 0.8, side: THREE.DoubleSide });
  const deckTex = TX.deckTexture();
  const deckMat = new THREE.MeshStandardMaterial({ map: deckTex, roughness: 0.85, metalness: 0 });
  const paintMat = new THREE.MeshStandardMaterial({ map: TX.paintTexture(), roughness: 0.6, metalness: 0.1, side: THREE.DoubleSide }); // 断面表示で切り口の内側も見せる
  const greenMat = new THREE.MeshStandardMaterial({ map: TX.paintTexture('#4d5e50'), roughness: 0.7, metalness: 0.2 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x0b1a26, roughness: 0.05, metalness: 0.9 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 1 });
  const steelMat = new THREE.MeshStandardMaterial({ color: 0x3a3f44, roughness: 0.5, metalness: 0.7 });
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xeeeeea, roughness: 0.5, metalness: 0.2 });
  const bronzeMat = new THREE.MeshStandardMaterial({ color: 0xb08d57, roughness: 0.3, metalness: 1 });

  // ---------- 船体 ----------
  const NZ = 160, NT = 24;
  const zi = (i) => H.Z_MIN + (H.L * i) / NZ;
  // 舷側: 船底 → 甲板（NT 段）→ ブルワーク上端（+2 段）
  const sidePoint = (side, i, j) => {
    const z = zi(i);
    if (j <= NT) { const s = section(z, j / NT); return [side * s.hb, s.y, z, ...TX.hullUV(side, z, s.y)]; }
    const top = section(z, 1), y = top.y + (BULWARK * (j - NT)) / 2;
    return [side * top.hb, y, z, ...TX.hullUV(side, z, y)];
  };
  const hullGeos = [
    orient(grid(NZ, NT + 2, (i, j) => sidePoint(1, i, j)), () => V(1, 0, 0)),
    orient(grid(NZ, NT + 2, (i, j) => sidePoint(-1, i, j)), () => V(-1, 0, 0)),
    // 船底（平らな部分）
    orient(grid(NZ, 4, (i, j) => {
      const z = zi(i), s = section(z, 0), x = -s.hb + (2 * s.hb * j) / 4;
      return [x, s.y, z, ...TX.hullUV(1, z, s.y)];
    }), () => V(0, -1, 0)),
    // トランサム（船尾の平らな板）
    orient(grid(NT + 2, 8, (i, j) => {
      const [x, y] = sidePoint(1, 0, i), xx = -x + (2 * x * j) / 8;
      return [xx, y, H.Z_MIN, ...TX.hullUV(1, H.Z_MIN + 0.3, y)];
    }), () => V(0, 0, -1)),
  ];
  const hullMeshes = []; // 舷側・船底・トランサム（魚雷の命中判定用。甲板は含めない）
  for (const g of hullGeos) {
    hullMeshes.push(add(new THREE.Mesh(g, hullMat)));
    add(new THREE.Mesh(g, innerMat)); // 断面表示で見える船内側
  }
  // 甲板
  const deckGeo = orient(grid(NZ, 10, (i, j) => {
    const z = zi(i), s = section(z, 1), x = -s.hb + (2 * s.hb * j) / 10;
    return [x, s.y + 0.002, z, x / 1.2, z / 1.2];
  }), () => V(0, 1, 0));
  add(new THREE.Mesh(deckGeo, deckMat));
  add(new THREE.Mesh(deckGeo, innerMat));
  // 水密隔壁（外からは見えない。断面表示用）
  for (const bz of H.BULKHEADS) {
    add(new THREE.Mesh(grid(NT, 8, (i, j) => {
      const s = section(bz, i / NT), x = -s.hb + (2 * s.hb * j) / 8;
      return [x * 0.998, s.y, bz, x, s.y];
    }), bulkheadMat));
  }

  const box = (w, h, d, mat, x, y, z, parent = group) => { const m = add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat), parent); m.position.set(x, y, z); return m; };
  const cyl = (r0, r1, h, mat, seg = 16) => new THREE.Mesh(new THREE.CylinderGeometry(r0, r1, h, seg), mat);
  // 2 点を結ぶ円柱（索具・パイプ・手すり用）
  const rod = (a, b, r, mat, parent = group) => {
    const m = add(cyl(r, r, a.distanceTo(b), mat, 6), parent);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(V(0, 1, 0), b.clone().sub(a).normalize());
    return m;
  };

  // ---------- 開口部（hull.js の HATCHES と同じ位置。物理ではここから水が入る） ----------
  for (const h of H.HATCHES) {
    if (h.type !== 'hatch') continue;
    const y = H.deckY(h.z), s = h.size, t = 0.03, ch = 0.1;
    box(s + 2 * t, ch, t, greenMat, 0, y + ch / 2, h.z - s / 2 - t / 2);
    box(s + 2 * t, ch, t, greenMat, 0, y + ch / 2, h.z + s / 2 + t / 2);
    box(t, ch, s, greenMat, -s / 2 - t / 2, y + ch / 2, h.z);
    box(t, ch, s, greenMat, s / 2 + t / 2, y + ch / 2, h.z);
    const hole = add(new THREE.Mesh(new THREE.PlaneGeometry(s, s), darkMat));
    hole.rotation.x = -Math.PI / 2;
    hole.position.set(0, y + 0.006, h.z);
    // 開いたハッチの蓋（前側のヒンジで立てた状態）
    const hinge = new THREE.Group();
    hinge.position.set(0, y + ch, h.z + s / 2 + t);
    hinge.rotation.x = -1.35;
    group.add(hinge);
    box(s + 0.04, 0.025, s + 0.04, greenMat, 0, 0, -(s + 0.04) / 2, hinge);
  }

  // ---------- 上部構造（船尾寄り） ----------
  const houseZ0 = -3.05, houseZ1 = -1.5, houseW = 1.7, houseH = 0.55;
  const baseY = H.deckY(houseZ1);
  box(houseW, houseH, houseZ1 - houseZ0, paintMat, 0, baseY + houseH / 2, (houseZ0 + houseZ1) / 2);
  const roofY = baseY + houseH;
  box(houseW + 0.06, 0.03, houseZ1 - houseZ0 + 0.06, paintMat, 0, roofY, (houseZ0 + houseZ1) / 2);
  // 前面の扉（開いている）。hull.js の door 開口（z ≈ 上部構造の前面）に対応する見た目
  const doorW = 0.26, doorH = 0.42;
  const doorway = add(new THREE.Mesh(new THREE.PlaneGeometry(doorW, doorH), darkMat));
  doorway.position.set(0, baseY + doorH / 2, houseZ1 + 0.003);
  const leafHinge = new THREE.Group();
  leafHinge.position.set(doorW / 2, baseY, houseZ1 + 0.01);
  leafHinge.rotation.y = 1.9;
  group.add(leafHinge);
  box(doorW, doorH, 0.02, paintMat, -doorW / 2, doorH / 2, 0, leafHinge);
  // 側面の舷窓
  for (const side of [1, -1]) for (let z = houseZ0 + 0.2; z < houseZ1 - 0.1; z += 0.3) {
    const p = add(new THREE.Mesh(new THREE.CircleGeometry(0.045, 16), glassMat));
    p.position.set(side * (houseW / 2 + 0.002), baseY + 0.33, z);
    p.rotation.y = (side * Math.PI) / 2;
  }
  // 船橋
  const brZ0 = -2.6, brZ1 = -1.6, brW = 1.4, brH = 0.45;
  box(brW, brH, brZ1 - brZ0, paintMat, 0, roofY + brH / 2, (brZ0 + brZ1) / 2);
  box(brW + 0.14, 0.035, brZ1 - brZ0 + 0.16, paintMat, 0, roofY + brH + 0.017, (brZ0 + brZ1) / 2 + 0.03); // 庇
  for (let k = 0; k < 5; k++) { // 前面の窓
    const w = add(new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.17), glassMat));
    w.position.set(-0.52 + k * 0.26, roofY + 0.28, brZ1 + 0.003);
  }
  for (const side of [1, -1]) for (let k = 0; k < 3; k++) { // 側面の窓
    const w = add(new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.15), glassMat));
    w.position.set(side * (brW / 2 + 0.003), roofY + 0.28, brZ0 + 0.22 + k * 0.28);
    w.rotation.y = (side * Math.PI) / 2;
  }
  // ブリッジウイング + 航海灯（左舷 赤 / 右舷 緑）
  box(2.1, 0.035, 0.34, paintMat, 0, roofY + 0.02, brZ1 - 0.2);
  for (const side of [1, -1]) {
    box(0.03, 0.12, 0.34, paintMat, side * 1.035, roofY + 0.08, brZ1 - 0.2);
    const light = new THREE.Mesh(new THREE.SphereGeometry(0.025, 10, 8), new THREE.MeshBasicMaterial({ color: side > 0 ? 0xff2222 : 0x22ff55 }));
    light.position.set(side * 1.06, roofY + 0.16, brZ1 - 0.2);
    group.add(light);
  }
  // マストとレーダー
  const mastTopY = roofY + brH + 0.95;
  rod(V(0, roofY + brH, -2.25), V(0, mastTopY, -2.25), 0.025, whiteMat);
  rod(V(-0.35, mastTopY - 0.3, -2.25), V(0.35, mastTopY - 0.3, -2.25), 0.012, whiteMat);
  const radar = new THREE.Group();
  radar.position.set(0, mastTopY - 0.5, -2.25);
  group.add(radar);
  box(0.06, 0.08, 0.06, steelMat, 0, 0, 0, radar);
  box(0.55, 0.035, 0.05, steelMat, 0, 0.06, 0, radar);
  const mastLight = new THREE.Mesh(new THREE.SphereGeometry(0.025, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffee }));
  mastLight.position.set(0, mastTopY + 0.02, -2.25);
  group.add(mastLight);
  // 煙突（後ろに傾ける）
  const funnel = add(cyl(0.2, 0.25, 0.8, new THREE.MeshStandardMaterial({ map: TX.funnelTexture(), roughness: 0.55, metalness: 0.2 }), 32));
  funnel.scale.x = 0.75;
  funnel.position.set(0, roofY + 0.38, -2.85);
  funnel.rotation.x = -0.12;
  const funnelTop = new THREE.Object3D();
  funnelTop.position.set(0, 0.42, 0);
  funnel.add(funnelTop);
  // 救命艇とダビット
  const boatMat = new THREE.MeshStandardMaterial({ map: TX.lifeboatTexture(), roughness: 0.5 });
  for (const side of [1, -1]) {
    const boat = add(new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), boatMat));
    boat.scale.set(0.13, 0.09, 0.4);
    boat.position.set(side * 0.66, roofY + 0.17, -2.72);
    for (const dz of [-0.28, 0.28]) {
      rod(V(side * 0.5, roofY, -2.72 + dz), V(side * 0.52, roofY + 0.32, -2.72 + dz), 0.012, whiteMat);
      rod(V(side * 0.52, roofY + 0.32, -2.72 + dz), V(side * 0.7, roofY + 0.3, -2.72 + dz), 0.012, whiteMat);
    }
  }

  // ---------- 前部マストとデリック（荷役装置） ----------
  const fmZ = 1.05, fmY = H.deckY(fmZ);
  rod(V(0, fmY, fmZ), V(0, fmY + 1.5, fmZ), 0.035, whiteMat);
  rod(V(-0.3, fmY + 1.2, fmZ), V(0.3, fmY + 1.2, fmZ), 0.015, whiteMat);
  const boomEnd = V(0, fmY + 0.75, 2.05);
  rod(V(0, fmY + 0.2, fmZ + 0.03), boomEnd, 0.025, steelMat);
  const rig = new THREE.LineBasicMaterial({ color: 0x222222 });
  const lines = [[V(0, fmY + 1.5, fmZ), boomEnd], [V(0, fmY + 1.5, fmZ), V(0.9, H.deckY(0.2), 0.2)], [V(0, fmY + 1.5, fmZ), V(-0.9, H.deckY(0.2), 0.2)],
    [V(0, fmY + 1.5, fmZ), V(0, H.deckY(3.7) + 0.1, 3.7)], [V(0, mastTopY, -2.25), V(0, fmY + 1.4, fmZ)]];
  group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(lines.flat()), rig));

  // ---------- 前甲板: 揚錨機と錨鎖 ----------
  const wlZ = 3.15, wlY = H.deckY(wlZ);
  box(0.5, 0.08, 0.16, steelMat, 0, wlY + 0.04, wlZ);
  for (const side of [1, -1]) {
    const drum = add(cyl(0.055, 0.055, 0.12, steelMat, 16));
    drum.rotation.z = Math.PI / 2;
    drum.position.set(side * 0.17, wlY + 0.11, wlZ);
    const hawse = V(side * (section(3.4, 1).hb - 0.08), H.deckY(3.4) + 0.01, 3.4);
    rod(V(side * 0.17, wlY + 0.1, wlZ + 0.04), hawse, 0.012, darkMat);
  }

  // ---------- 係船柱（ボラード） ----------
  for (const z of [3.55, 1.8, -0.6, -3.65]) for (const side of [1, -1]) {
    const x = side * (section(z, 1).hb - 0.14), y = H.deckY(z);
    for (const dz of [-0.04, 0.04]) { const b = add(cyl(0.022, 0.022, 0.07, steelMat, 10)); b.position.set(x, y + 0.035, z + dz); }
    box(0.06, 0.012, 0.13, steelMat, x, y + 0.006, z);
  }

  // ---------- 手すり（ブルワークの上） ----------
  for (const side of [1, -1]) {
    const pts = [];
    for (let z = H.Z_MIN + 0.05; z < H.Z_MAX - 0.3; z += 0.2) {
      const s = section(z, 1);
      if (s.hb < 0.05) continue;
      pts.push(V(side * (s.hb - 0.01), s.y + BULWARK, z));
    }
    for (const p of pts) rod(p, p.clone().add(V(0, 0.12, 0)), 0.006, whiteMat);
    for (const dy of [0.06, 0.12]) {
      const curve = new THREE.CatmullRomCurve3(pts.map((p) => p.clone().add(V(0, dy, 0))));
      add(new THREE.Mesh(new THREE.TubeGeometry(curve, 200, 0.007, 5), whiteMat));
    }
  }
  // 船尾の手すり（トランサム上）
  const sternHb = section(H.Z_MIN + 0.05, 1).hb, sternY = H.deckY(H.Z_MIN) + BULWARK;
  for (const dy of [0.06, 0.12]) rod(V(-sternHb, sternY + dy, H.Z_MIN + 0.05), V(sternHb, sternY + dy, H.Z_MIN + 0.05), 0.007, whiteMat);

  // ---------- 船尾旗 ----------
  const poleBase = V(0, H.deckY(H.Z_MIN) + 0.1, H.Z_MIN + 0.12);
  rod(poleBase, poleBase.clone().add(V(0, 0.55, -0.1)), 0.008, whiteMat);
  const flag = add(new THREE.Mesh(new THREE.PlaneGeometry(0.27, 0.18, 8, 4), new THREE.MeshStandardMaterial({ map: TX.flagTexture(), side: THREE.DoubleSide, roughness: 0.9 })));
  flag.position.copy(poleBase).add(V(0, 0.45, -0.22));
  flag.rotation.y = Math.PI / 2;

  // ---------- 舵とプロペラ ----------
  box(0.03, 0.28, 0.24, paintMat.clone(), 0, -0.52, -3.86).material.color.set(0x7d2a20);
  const prop = new THREE.Group();
  prop.position.set(0, -0.53, -3.62);
  group.add(prop);
  add(cyl(0.035, 0.035, 0.1, bronzeMat, 12), prop).rotation.x = Math.PI / 2;
  for (let k = 0; k < 4; k++) {
    const blade = add(new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), bronzeMat), prop);
    blade.scale.set(0.05, 0.14, 0.012);
    const a = (k * Math.PI) / 2;
    blade.position.set(Math.sin(a) * 0.12, Math.cos(a) * 0.12, 0);
    blade.rotation.set(0, 0.5, -a);
  }
  rod(V(0, -0.53, -3.3), V(0, -0.53, -3.62), 0.02, steelMat);

  // ---------- 破口デカール ----------
  const breachMat = new THREE.MeshStandardMaterial({ map: TX.breachTexture(), transparent: true, depthWrite: false, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -4 });
  function addBreachDecal(local, inward, radius) {
    const d = add(new THREE.Mesh(new THREE.PlaneGeometry(radius * 3, radius * 3), breachMat));
    const out = inward.clone().negate().normalize();
    d.quaternion.setFromUnitVectors(V(0, 0, 1), out);
    d.position.copy(local).addScaledVector(out, 0.01);
    return d;
  }

  return { group, hullMeshes, radar, funnelTop, prop, addBreachDecal };
}
