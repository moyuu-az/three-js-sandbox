// 浸水・海の視覚効果: 区画内の水の立体、粒子（噴流・しぶき・泡・気泡・水柱・煙）、魚雷
import * as THREE from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import * as H from './hull.js';
import { G, CD, COMP_VOLUME } from './sim.js';
import { softDotTexture, rippleNormalMap } from './textures.js';

// ================= 区画内の水 =================
// 区画（凸多面体）を「水面の平面」と、断面表示なら「x = 0 の平面」で切った立体を毎フレーム作る
function compartmentPolytope([z0, z1]) {
  const pts = [], e = 0.012; // e: 船体内面・隔壁との z-fighting 回避
  for (let i = 0; i <= 10; i++) {
    const z = z0 + e + ((z1 - z0 - 2 * e) * i) / 10, k = H.keelY(z) + e, d = H.deckY(z) - e;
    for (let j = 0; j <= 12; j++) {
      const y = k + ((d - k) * j) / 12, hb = H.halfBreadth(z, y) - e;
      if (hb > 0) pts.push(new THREE.Vector3(hb, y, z), new THREE.Vector3(-hb, y, z));
    }
  }
  return new ConvexGeometry(pts);
}

// 凸多面体 geo を平面 n·p <= d 側で切った頂点集合（切り口の点を含む）
function clipPoints(geo, n, d) {
  const p = geo.attributes.position, out = [], a = new THREE.Vector3(), b = new THREE.Vector3();
  for (let k = 0; k < p.count; k += 3)
    for (let e = 0; e < 3; e++) {
      a.fromBufferAttribute(p, k + e); b.fromBufferAttribute(p, k + ((e + 1) % 3));
      const ga = n.dot(a) - d, gb = n.dot(b) - d;
      if (ga <= 0) out.push(a.clone());
      if (ga * gb < 0) out.push(a.clone().lerp(b, ga / (ga - gb)));
    }
  return out;
}

function hullOf(points) {
  if (points.length < 4) return null;
  try { return new ConvexGeometry(points); } catch { return null; } // 退化（平面上の点だけ）なら描かない
}

export function createFloodWater(sim, shipGroup) {
  const base = H.COMP_RANGES.map(compartmentPolytope);
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0x137fa6, emissive: 0x06324a, transparent: true, opacity: 0.88, roughness: 0.06, metalness: 0,
    normalMap: rippleNormalMap(128, 1), normalScale: new THREE.Vector2(0.35, 0.35), clearcoat: 0.6,
  });
  const meshes = base.map(() => { const m = new THREE.Mesh(new THREE.BufferGeometry(), mat); m.renderOrder = 1; shipGroup.add(m); return m; });
  const qInv = new THREE.Quaternion(), nL = new THREE.Vector3(), X = new THREE.Vector3();

  // cutSide: 断面表示で切り取る側（+1 = 左舷 x>0、-1 = 右舷、0 = 断面表示なし）
  function update(cutSide, t) {
    mat.normalMap.offset.set(t * 0.05, t * 0.03);
    qInv.copy(shipGroup.quaternion).invert();
    meshes.forEach((m, c) => {
      const flood = sim.water[c] / COMP_VOLUME[c];
      if (flood < 0.002) { m.visible = false; return; }
      // 水面の平面をワールド → 船体座標へ: n_L = R⁻¹ n, d_L = d − n·pos
      const s = sim.surfaces[c];
      nL.copy(s.n).applyQuaternion(qInv);
      const dL = s.d - s.n.dot(shipGroup.position);
      let geo = flood >= 1 ? base[c] : hullOf(clipPoints(base[c], nL, dL));
      if (geo && cutSide) geo = hullOf(clipPoints(geo, X.set(cutSide, 0, 0), 0));
      if (m.geometry !== base[c]) m.geometry.dispose();
      m.visible = !!geo;
      if (!geo) return;
      // 水面のさざ波用に、船体座標の x, z から UV を作る
      const p = geo.attributes.position, uv = new Float32Array(p.count * 2);
      for (let k = 0; k < p.count; k++) { uv[2 * k] = p.getX(k) * 0.6; uv[2 * k + 1] = p.getZ(k) * 0.6; }
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      m.geometry = geo;
    });
  }
  return { update, material: mat };
}

// ================= 粒子 =================
export const P = { JET: 0, UNDER: 1, SPLASH: 2, FOAM: 3, BUBBLE: 4, SEA_FOAM: 5, PLUME: 6, SMOKE: 7, WAKE: 8 };
// 種類ごとの見た目 [r, g, b, alpha, size(m), 寿命(s)]
const LOOK = [
  [0.85, 0.93, 1.0, 0.75, 0.05, 2.0],
  [0.65, 0.82, 0.92, 0.35, 0.07, 0.9],
  [1, 1, 1, 0.85, 0.03, 1.2],
  [0.95, 0.97, 1, 0.55, 0.09, 3.0],
  [0.8, 0.93, 1, 0.55, 0.04, 20],
  [1, 1, 1, 0.5, 0.35, 5.0],
  [0.95, 0.97, 1, 0.7, 0.18, 4.0],
  [0.42, 0.42, 0.44, 0.2, 0.3, 6.0],
  [1, 1, 1, 0.45, 0.1, 2.5],
];

export function createParticles(scene, sim, shipGroup, max = 20000) {
  const pos = new Float32Array(max * 3), vel = new Float32Array(max * 3), col = new Float32Array(max * 3);
  const alpha = new Float32Array(max), size = new Float32Array(max), life = new Float32Array(max), type = new Uint8Array(max), comp = new Uint8Array(max);
  let count = 0;
  const geo = new THREE.BufferGeometry();
  const attr = (a, n) => { const b = new THREE.BufferAttribute(a, n); b.setUsage(THREE.DynamicDrawUsage); return b; };
  geo.setAttribute('position', attr(pos, 3));
  geo.setAttribute('color', attr(col, 3));
  geo.setAttribute('alpha', attr(alpha, 1));
  geo.setAttribute('size', attr(size, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { map: { value: softDotTexture() }, scale: { value: 800 } },
    vertexShader: `
      attribute float alpha; attribute float size; varying float vA; varying vec3 vC;
      uniform float scale;
      void main() {
        vA = alpha; vC = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * scale / -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform sampler2D map; varying float vA; varying vec3 vC;
      void main() {
        float a = texture2D(map, gl_PointCoord).a * vA;
        if (a < 0.01) discard;
        gl_FragColor = vec4(vC, a);
      }`,
    vertexColors: true, transparent: true, depthWrite: false,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 2;
  scene.add(points);

  function emit(t, x, y, z, vx, vy, vz, c = 0) {
    if (count >= max) return;
    const i = count++, L = LOOK[t];
    pos[3 * i] = x; pos[3 * i + 1] = y; pos[3 * i + 2] = z;
    vel[3 * i] = vx; vel[3 * i + 1] = vy; vel[3 * i + 2] = vz;
    col[3 * i] = L[0]; col[3 * i + 1] = L[1]; col[3 * i + 2] = L[2];
    alpha[i] = L[3]; size[i] = L[4] * (0.7 + Math.random() * 0.6); life[i] = L[5] * (0.6 + Math.random() * 0.8);
    type[i] = t; comp[i] = c;
  }
  function kill(i) {
    const j = --count;
    pos.copyWithin(3 * i, 3 * j, 3 * j + 3); vel.copyWithin(3 * i, 3 * j, 3 * j + 3); col.copyWithin(3 * i, 3 * j, 3 * j + 3);
    alpha[i] = alpha[j]; size[i] = size[j]; life[i] = life[j]; type[i] = type[j]; comp[i] = comp[j];
  }

  const toLocal = new THREE.Matrix4(), l = new THREE.Vector3(), vL = new THREE.Vector3(), qInv = new THREE.Quaternion();
  const rnd = (a) => (Math.random() - 0.5) * 2 * a;
  const BOUNCE = 0.3; // 壁で跳ね返るときに残る速度の割合

  // 区画の中に閉じ込める: 舷側・船底・隔壁に当たったら跳ね返す。甲板より上へ出たもの（ハッチから飛び出したしぶき）は false
  function confine(i) {
    const k = 3 * i;
    l.set(pos[k], pos[k + 1], pos[k + 2]).applyMatrix4(toLocal);
    if (H.inside(l.x, l.y, l.z) && H.compOf(l.z) === comp[i]) return true;
    if (l.y > H.deckY(l.z)) return false;
    vL.set(vel[k], vel[k + 1], vel[k + 2]).applyQuaternion(qInv);
    const [z0, z1] = H.COMP_RANGES[comp[i]];
    if (l.z < z0 || l.z > z1) { l.z = Math.min(z1 - 0.01, Math.max(z0 + 0.01, l.z)); vL.z *= -BOUNCE; }
    const k0 = H.keelY(l.z);
    if (l.y < k0) { l.y = k0 + 0.01; vL.y *= -BOUNCE; }
    const hb = H.halfBreadth(l.z, l.y);
    if (hb > 0 && Math.abs(l.x) > hb) { l.x = Math.sign(l.x) * hb * 0.98; vL.x *= -BOUNCE; }
    if (!H.inside(l.x, l.y, l.z)) return false;
    l.applyMatrix4(shipGroup.matrixWorld);
    vL.applyQuaternion(shipGroup.quaternion);
    pos[k] = l.x; pos[k + 1] = l.y; pos[k + 2] = l.z;
    vel[k] = vL.x; vel[k + 1] = vL.y; vel[k + 2] = vL.z;
    return true;
  }

  // under: カメラが水中。海面の泡は下から見ると明るすぎるので薄くする
  function update(dt, under = false, windX = 0.4) {
    if (dt <= 0) return;
    toLocal.copy(shipGroup.matrixWorld).invert();
    qInv.copy(shipGroup.quaternion).invert();
    const seaFoamAlpha = under ? 0.15 : 1;
    for (let i = 0; i < count; ) {
      const k = 3 * i, t = type[i];
      life[i] -= dt;
      let dead = life[i] <= 0;
      const inHull = () => confine(i);
      if (t === P.JET || t === P.SPLASH) {
        vel[k + 1] -= G * dt;
        const s = sim.surfaceYAt(comp[i], pos[k], pos[k + 2]);
        if (pos[k + 1] < s && vel[k + 1] < 0) {
          if (t === P.JET) { // 区画内の水面に落ちた: 水中の乱流に変わり、しぶきと泡を出す
            if (Math.random() < 0.25) for (let n = 0; n < 2; n++) emit(P.SPLASH, pos[k], s, pos[k + 2], rnd(0.5), 0.6 + Math.random() * 1.2, rnd(0.5), comp[i]);
            if (Math.random() < 0.2) emit(P.FOAM, pos[k], s, pos[k + 2], rnd(0.15), 0, rnd(0.15), comp[i]);
            type[i] = P.UNDER; const L = LOOK[P.UNDER]; col.set(L.slice(0, 3), k); alpha[i] = L[3]; life[i] = L[5];
          } else dead = true;
        }
        if (!inHull()) dead = true;
      } else if (t === P.UNDER) { // 水中の噴流: 周りの水に揉まれて減速
        const d = Math.exp(-4 * dt); vel[k] *= d; vel[k + 1] *= d; vel[k + 2] *= d;
        alpha[i] = LOOK[P.UNDER][3] * Math.min(1, life[i] / LOOK[P.UNDER][5]);
        if (!inHull()) dead = true;
      } else if (t === P.FOAM) { // 区画内の水面に浮く泡
        const d = Math.exp(-1 * dt); vel[k] *= d; vel[k + 2] *= d;
        pos[k + 1] = sim.surfaceYAt(comp[i], pos[k], pos[k + 2]) + 0.004; vel[k + 1] = 0;
        alpha[i] = LOOK[P.FOAM][3] * Math.min(1, life[i] / 1.5);
        if (!inHull() || sim.water[comp[i]] >= COMP_VOLUME[comp[i]]) dead = true;
      } else if (t === P.BUBBLE) { // 気泡: 浮力で上がり、揺れながら海面へ
        vel[k + 1] += (1.3 - vel[k + 1]) * 3 * dt;
        vel[k] += rnd(2) * dt; vel[k + 2] += rnd(2) * dt;
        size[i] = Math.min(0.08, size[i] + 0.004 * dt); // 水圧が下がって膨らむ
        if (pos[k + 1] > 0) { dead = true; if (Math.random() < 0.35) emit(P.SEA_FOAM, pos[k], 0.02, pos[k + 2], rnd(0.3), 0, rnd(0.3)); }
      } else if (t === P.SEA_FOAM) { // 海面の泡: 広がりながら消える
        const d = Math.exp(-0.8 * dt); vel[k] *= d; vel[k + 2] *= d;
        pos[k + 1] = 0.02;
        size[i] += 0.05 * dt;
        alpha[i] = LOOK[P.SEA_FOAM][3] * Math.min(1, life[i] / 2.5) * seaFoamAlpha;
      } else if (t === P.WAKE) { // 喫水線の泡: 船体から離れながら消える
        const d = Math.exp(-1.5 * dt); vel[k] *= d; vel[k + 2] *= d;
        pos[k + 1] = 0.015;
        size[i] += 0.04 * dt;
        alpha[i] = LOOK[P.WAKE][3] * Math.min(1, life[i] / 1.5) * seaFoamAlpha;
      } else if (t === P.PLUME) { // 爆発の水柱: 空気抵抗つきの放物線、海面に戻ったら泡に
        vel[k + 1] -= G * dt;
        const d = Math.exp(-0.6 * dt); vel[k] *= d; vel[k + 2] *= d;
        size[i] += 0.1 * dt;
        if (pos[k + 1] < 0 && vel[k + 1] < 0) { dead = true; if (Math.random() < 0.3) emit(P.SEA_FOAM, pos[k], 0.02, pos[k + 2], rnd(0.8), 0, rnd(0.8)); }
      } else if (t === P.SMOKE) { // 煙: 上昇しながら風に流され、広がって薄くなる
        vel[k] += (windX - vel[k]) * 0.5 * dt; vel[k + 1] += (0.35 - vel[k + 1]) * 0.5 * dt;
        size[i] += 0.12 * dt;
        alpha[i] = LOOK[P.SMOKE][3] * Math.min(1, life[i] / 3);
        if (pos[k + 1] < 0) dead = true;
      }
      if (dead) { kill(i); continue; }
      pos[k] += vel[k] * dt; pos[k + 1] += vel[k + 1] * dt; pos[k + 2] += vel[k + 2] * dt;
      i++;
    }
    geo.setDrawRange(0, count);
    for (const a of Object.values(geo.attributes)) a.needsUpdate = true;
  }

  // 開口部からの流入と、水没した開口部から抜ける空気
  const hw = new THREE.Vector3(), inW = new THREE.Vector3(), ta = new THREE.Vector3(), tb = new THREE.Vector3();
  const debt = new Map(), bubbleDebt = new Map();
  function emitInflow(dt) {
    for (const h of sim.holes) {
      if (h.q <= 0) continue;
      const speed = h.q / (CD * h.area); // √(2gΔh)
      inW.copy(h.inward).applyQuaternion(shipGroup.quaternion);
      hw.copy(h.local).applyMatrix4(shipGroup.matrixWorld).addScaledVector(inW, 0.03); // 外板のわずかに内側から出す
      ta.set(0, 1, 0).applyQuaternion(shipGroup.quaternion);
      if (Math.abs(ta.dot(inW)) > 0.9) ta.set(1, 0, 0).applyQuaternion(shipGroup.quaternion);
      tb.crossVectors(inW, ta).normalize(); ta.crossVectors(tb, inW).normalize();
      const half = Math.sqrt(h.area) / 2;
      // ponytail: 見た目用の発生数。流量に比例させると小さい破孔が見えないので底上げする
      let n = (debt.get(h) ?? 0) + Math.min(3000, 250 + 2500 * h.q) * dt;
      for (; n >= 1; n--) {
        const a = rnd(half), b = rnd(half);
        emit(P.JET, hw.x + ta.x * a + tb.x * b, hw.y + ta.y * a + tb.y * b, hw.z + ta.z * a + tb.z * b,
          inW.x * speed + rnd(0.35), inW.y * speed + rnd(0.35), inW.z * speed + rnd(0.35), h.comp);
      }
      debt.set(h, n);
      if (h.kind !== 'breach' && hw.y < 0) { // 水没したハッチ・扉からは、入れ替わりに空気が抜ける
        let m = (bubbleDebt.get(h) ?? 0) + Math.min(800, 80 + 600 * h.q) * dt;
        for (; m >= 1; m--) emit(P.BUBBLE, hw.x + rnd(half), hw.y + 0.05, hw.z + rnd(half), rnd(0.2), 0.3, rnd(0.2));
        bubbleDebt.set(h, m);
      }
    }
  }

  // 喫水線に沿った白い泡。船体が海面を切る線上に出し、上下に動いているほど多くする
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  let wakeDebt = 0;
  function emitWaterline(dt, vy) {
    for (wakeDebt += (40 + 600 * Math.abs(vy)) * dt; wakeDebt >= 1; wakeDebt--) {
      const z = H.Z_MIN + Math.random() * H.L, side = Math.random() < 0.5 ? 1 : -1;
      // 船体座標の y を動かしたときのワールド高さは線形なので、2 点から海面 (y=0) の高さを補間する
      const ya = H.keelY(z), yb = H.deckY(z);
      a.set(0, ya, z).applyMatrix4(shipGroup.matrixWorld); b.set(0, yb, z).applyMatrix4(shipGroup.matrixWorld);
      if (a.y > 0 || b.y < 0) continue; // この断面は海面を切っていない
      const y = ya + ((yb - ya) * -a.y) / (b.y - a.y), hb = H.halfBreadth(z, y);
      if (hb <= 0) continue;
      a.set(side * (hb + 0.03), y, z).applyMatrix4(shipGroup.matrixWorld);
      b.set(side, 0, 0).applyQuaternion(shipGroup.quaternion);
      emit(P.WAKE, a.x, 0.015, a.z, b.x * 0.15 + rnd(0.05), 0, b.z * 0.15 + rnd(0.05));
    }
  }

  function explosion(p, out) {
    for (let n = 0; n < 1400; n++) {
      const up = 3 + Math.random() * 9, spread = 0.4 + Math.random() * 2.2;
      emit(P.PLUME, p.x + rnd(0.3), Math.max(0.05, p.y + 0.3), p.z + rnd(0.3), out.x * spread + rnd(1.5), up, out.z * spread + rnd(1.5));
    }
    for (let n = 0; n < 400; n++) emit(P.SEA_FOAM, p.x + rnd(1.5), 0.02, p.z + rnd(1.5), rnd(2), 0, rnd(2));
    for (let n = 0; n < 300; n++) emit(P.BUBBLE, p.x + rnd(0.5), p.y + rnd(0.3), p.z + rnd(0.5), rnd(1), rnd(1), rnd(1));
    for (let n = 0; n < 80; n++) emit(P.SMOKE, p.x + rnd(0.5), 0.5 + Math.random(), p.z + rnd(0.5), rnd(0.8), 1 + Math.random(), rnd(0.8));
  }

  return { emit, update, emitInflow, emitWaterline, explosion, material: mat, get count() { return count; } };
}

// ================= 魚雷 =================
export function createTorpedo(scene) {
  const body = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: 0x3b4148, roughness: 0.4, metalness: 0.8 });
  const hull = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.9, 16), steel);
  hull.rotation.x = Math.PI / 2;
  body.add(hull);
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), steel);
  nose.rotation.x = Math.PI / 2; nose.position.z = 0.45;
  body.add(nose);
  for (let k = 0; k < 4; k++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.1, 0.1), steel);
    fin.rotation.z = (k * Math.PI) / 2;
    fin.position.set(Math.sin((k * Math.PI) / 2) * 0.06, Math.cos((k * Math.PI) / 2) * 0.06, -0.42);
    body.add(fin);
  }
  body.visible = false;
  scene.add(body);
  return body;
}
