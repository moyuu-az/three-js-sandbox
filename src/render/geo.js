// 形状を作る小道具。静的な部品は材質ごとに 1 つのメッシュへまとめる（描画呼び出しを減らす）
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

// (i, j) の格子から面を作る。fn(i, j) → [x, y, z, u, v]。skip(i, j) が true の四角形は張らない（穴）
export function grid(nu, nv, fn, skip = null) {
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) { const [x, y, z, u, v] = fn(i, j); pos.push(x, y, z); uv.push(u, v); }
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    if (skip && skip(i, j)) continue;
    const a = i * (nv + 1) + j, b = a + nv + 1;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// 面の向き（表裏）を outward(p) の向きに揃える
export function orient(g, outward) {
  const n = g.attributes.normal, p = new THREE.Vector3(), nn = new THREE.Vector3();
  let score = 0;
  for (let k = 0; k < n.count; k++) score += nn.fromBufferAttribute(n, k).dot(outward(p.fromBufferAttribute(g.attributes.position, k)));
  if (score < 0) flip(g);
  return g;
}

export function flip(g) {
  const idx = g.index.array;
  for (let k = 0; k < idx.length; k += 3) [idx[k + 1], idx[k + 2]] = [idx[k + 2], idx[k + 1]];
  g.index.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

// 2 次元の外形（と穴）を厚さ t の板にして、map(sx, sy, sz) → [x, y, z] で配置する。写像が鏡映なら面の向きを直す
export function plate(outline, holes, t, map, uvScale = 1) {
  const shape = new THREE.Shape(outline.map(([a, b]) => new THREE.Vector2(a, b)));
  for (const h of holes) shape.holes.push(new THREE.Path(h.map(([a, b]) => new THREE.Vector2(a, b))));
  let g = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, curveSegments: 1 });
  g = g.index ? g.toNonIndexed() : g;
  const p = g.attributes.position, uv = g.attributes.uv;
  for (let k = 0; k < p.count; k++) {
    const [x, y, z] = map(p.getX(k), p.getY(k), p.getZ(k) - t / 2);
    p.setXYZ(k, x, y, z);
    uv.setXY(k, uv.getX(k) * uvScale, uv.getY(k) * uvScale);
  }
  // 写像の向き（鏡映か）を 3 点で調べる
  const o = map(0, 0, 0), ax = map(1, 0, 0), ay = map(0, 1, 0), az = map(0, 0, 1);
  const e = [ax, ay, az].map((v) => new THREE.Vector3(v[0] - o[0], v[1] - o[1], v[2] - o[2]));
  if (e[0].clone().cross(e[1]).dot(e[2]) < 0) {
    for (let k = 0; k < p.count; k += 3) {
      for (const a of [p, uv]) {
        const s = a.itemSize;
        for (let c = 0; c < s; c++) { const t1 = a.array[(k + 1) * s + c]; a.array[(k + 1) * s + c] = a.array[(k + 2) * s + c]; a.array[(k + 2) * s + c] = t1; }
      }
    }
  }
  p.needsUpdate = true;
  g.deleteAttribute('normal');
  g.computeVertexNormals();
  return g;
}

export function box(w, h, d, x, y, z, rot = null) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rot) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...rot)));
  g.translate(x, y, z);
  return g;
}

// 2 点を結ぶ円柱（パイプ・手すり・索具）
export function rod(a, b, r, seg = 8) {
  const g = new THREE.CylinderGeometry(r, r, a.distanceTo(b), seg, 1, false);
  const q = new THREE.Quaternion().setFromUnitVectors(V3(0, 1, 0), b.clone().sub(a).normalize());
  g.applyQuaternion(q);
  const m = a.clone().add(b).multiplyScalar(0.5);
  g.translate(m.x, m.y, m.z);
  return g;
}

// 材質ごとに形状を貯めて、最後に 1 メッシュにまとめる
export function batcher() {
  const bins = new Map();
  return {
    add(mat, g) {
      if (!bins.has(mat)) bins.set(mat, []);
      const gg = g.index ? g.toNonIndexed() : g;
      for (const name of Object.keys(gg.attributes)) if (!['position', 'normal', 'uv'].includes(name)) gg.deleteAttribute(name);
      if (!gg.attributes.normal) gg.computeVertexNormals();
      if (!gg.attributes.uv) gg.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(gg.attributes.position.count * 2), 2));
      bins.get(mat).push(gg);
      return gg;
    },
    build(parent, { shadows = true } = {}) {
      const meshes = [];
      for (const [mat, gs] of bins) {
        const m = new THREE.Mesh(mergeGeometries(gs, false), mat);
        m.castShadow = m.receiveShadow = shadows;
        parent.add(m);
        meshes.push(m);
      }
      bins.clear();
      return meshes;
    },
  };
}
