// 船外の視覚効果: しぶき・気泡・海面の泡・喫水線の泡・爆発の水柱・煙、魚雷。
// 粒子は CPU で動かし（数万個）、毎フレーム instanced attribute で GPU に送る。船内の水そのものは GPU 流体が描く。
import * as THREE from 'three/webgpu';
import { texture, uv, instancedBufferAttribute, vec4, float } from 'three/tsl';
import * as H from '../hull.js';
import { softDotTexture } from './textures.js';

export const P = { SPLASH: 0, BUBBLE: 1, SEA_FOAM: 2, WAKE: 3, PLUME: 4, SMOKE: 5, MIST: 6 };
// 種類ごとの見た目 [r, g, b, alpha, size(m), 寿命(s)]
const LOOK = [
  [1, 1, 1, 0.8, 0.12, 1.4],
  [0.85, 0.95, 1, 0.6, 0.09, 20],
  [1, 1, 1, 0.55, 0.9, 7],
  [1, 1, 1, 0.5, 0.35, 3],
  [0.95, 0.97, 1, 0.75, 0.6, 5],
  [0.35, 0.35, 0.37, 0.28, 1.2, 9],
  [0.9, 0.93, 0.96, 0.18, 2.0, 2.5],
];

export function createFx(scene, sim, shipGroup, max = 40000) {
  const pos = new Float32Array(max * 3), vel = new Float32Array(max * 3), col = new Float32Array(max * 4);
  const size = new Float32Array(max), life = new Float32Array(max), type = new Uint8Array(max), base = new Float32Array(max);
  let count = 0;
  const attr = (a, n) => { const b = new THREE.InstancedBufferAttribute(a, n); b.setUsage(THREE.DynamicDrawUsage); return b; };
  const aPos = attr(pos, 3), aCol = attr(col, 4), aSize = attr(size, 1);
  const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
  mat.positionNode = instancedBufferAttribute(aPos);
  mat.scaleNode = instancedBufferAttribute(aSize);
  const c = instancedBufferAttribute(aCol);
  const dot = texture(softDotTexture(), uv());
  mat.colorNode = vec4(c.xyz, float(1));
  mat.opacityNode = dot.a.mul(c.w);
  const sprite = new THREE.Sprite(mat);
  sprite.count = 0;
  sprite.frustumCulled = false;
  sprite.renderOrder = 5;
  scene.add(sprite);

  const rnd = (a) => (Math.random() - 0.5) * 2 * a;
  function emit(t, x, y, z, vx, vy, vz, sizeMul = 1) {
    if (count >= max) return;
    const i = count++, L = LOOK[t];
    pos[3 * i] = x; pos[3 * i + 1] = y; pos[3 * i + 2] = z;
    vel[3 * i] = vx; vel[3 * i + 1] = vy; vel[3 * i + 2] = vz;
    col.set([L[0], L[1], L[2], L[3]], 4 * i);
    size[i] = L[4] * (0.7 + Math.random() * 0.6) * sizeMul; base[i] = L[3];
    life[i] = L[5] * (0.6 + Math.random() * 0.8);
    type[i] = t;
  }
  function kill(i) {
    const j = --count;
    pos.copyWithin(3 * i, 3 * j, 3 * j + 3); vel.copyWithin(3 * i, 3 * j, 3 * j + 3); col.copyWithin(4 * i, 4 * j, 4 * j + 4);
    size[i] = size[j]; life[i] = life[j]; type[i] = type[j]; base[i] = base[j];
  }

  // under: カメラが水中。海面の泡は下から見ると明るすぎるので薄くする
  // cut: 断面表示で手前の海面を切り取っている範囲 { side, inv（ワールド → 船体座標）, x, z }。そこでは海面の泡を描かない
  // （海面が無いので泡だけ宙に浮いて見える）
  const lp = new THREE.Vector3();
  const inCut = (cut, x, y, z) => {
    if (!cut || !cut.side) return false;
    lp.set(x, y, z).applyMatrix4(cut.inv);
    return lp.x * cut.side > -0.5 && lp.x * cut.side < cut.x && Math.abs(lp.z) < cut.z;
  };
  // 船体の内側（船体座標で外殻の中）に入った煙・しぶきは描かない。断面表示で船内に爆発の煙が漂って見えるのを防ぐ
  const shipInv = new THREE.Matrix4();
  const inHull = (x, y, z) => { lp.set(x, y, z).applyMatrix4(shipInv); return H.inside(lp.x, lp.y, lp.z); };
  // 生きている範囲 [0, count) だけ GPU に送る（毎フレーム max 個分の全体を送らない）
  const attrs = [[aPos, 3], [aCol, 4], [aSize, 1]];
  function upload() {
    sprite.count = count;
    if (count === 0) return;
    for (const [a, n] of attrs) { a.clearUpdateRanges(); a.addUpdateRange(0, count * n); a.needsUpdate = true; }
  }
  const foamAlpha = (i, cut, surfA) => (inCut(cut, pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]) ? 0 : base[i] * Math.min(1, life[i] / 2.5) * surfA);
  function update(dt, { under = false, wind = [1.2, 0, 0.4], cut = null } = {}) {
    shipInv.copy(shipGroup.matrixWorld).invert();
    const surfA = under ? 0.25 : 1;
    if (dt <= 0) {
      // 一時停止中も、断面の切り替え・視点の回り込み（切る側が変わる）と水中への出入りは泡の見え方に反映する
      for (let i = 0; i < count; i++) if (type[i] === P.SEA_FOAM || type[i] === P.WAKE) col[4 * i + 3] = foamAlpha(i, cut, surfA);
      upload();
      return;
    }
    for (let i = 0; i < count;) {
      const k = 3 * i, t = type[i];
      life[i] -= dt;
      let dead = life[i] <= 0;
      const sea = sim.sea(pos[k], pos[k + 2]);
      if (t === P.SPLASH || t === P.PLUME) {
        vel[k + 1] -= 9.81 * dt;
        const d = Math.exp(-(t === P.PLUME ? 0.5 : 0.2) * dt); vel[k] *= d; vel[k + 2] *= d;
        if (t === P.PLUME) size[i] += 0.5 * dt;
        col[4 * i + 3] = inHull(pos[k], pos[k + 1], pos[k + 2]) ? 0 : base[i];
        if (pos[k + 1] < sea && vel[k + 1] < 0) { dead = true; if (Math.random() < 0.15) emit(P.SEA_FOAM, pos[k], sea + 0.03, pos[k + 2], rnd(0.4), 0, rnd(0.4), 0.6); }
      } else if (t === P.BUBBLE) { // 気泡: 浮力で上がり、揺れながら海面へ。水圧が下がって膨らむ
        vel[k + 1] += (1.4 - vel[k + 1]) * 3 * dt;
        vel[k] += rnd(2.5) * dt; vel[k + 2] += rnd(2.5) * dt;
        size[i] = Math.min(0.25, size[i] + 0.006 * dt);
        if (inHull(pos[k], pos[k + 1], pos[k + 2])) dead = true; // 船内の水は GPU 流体が描く
        if (pos[k + 1] > sea) { dead = true; if (Math.random() < 0.4) emit(P.SEA_FOAM, pos[k], sea + 0.03, pos[k + 2], rnd(0.3), 0, rnd(0.3), 0.5); if (Math.random() < 0.15) emit(P.SPLASH, pos[k], sea, pos[k + 2], rnd(0.4), 1 + Math.random(), rnd(0.4), 0.6); }
      } else if (t === P.SEA_FOAM || t === P.WAKE) { // 海面の泡: 海面に乗って広がりながら消える
        const d = Math.exp(-0.8 * dt); vel[k] *= d; vel[k + 2] *= d;
        pos[k + 1] = sea + 0.04;
        size[i] += (t === P.WAKE ? 0.12 : 0.18) * dt;
        col[4 * i + 3] = foamAlpha(i, cut, surfA);
      } else if (t === P.SMOKE || t === P.MIST) { // 煙: 上昇しながら風に流され、広がって薄くなる
        vel[k] += (wind[0] - vel[k]) * 0.4 * dt; vel[k + 2] += (wind[2] - vel[k + 2]) * 0.4 * dt;
        vel[k + 1] += ((t === P.SMOKE ? 2.2 : 0.1) - vel[k + 1]) * 0.5 * dt;
        size[i] += (t === P.SMOKE ? 0.5 : 1.0) * dt;
        col[4 * i + 3] = inHull(pos[k], pos[k + 1], pos[k + 2]) ? 0 : base[i] * Math.min(1, life[i] / 3);
      }
      if (dead) { kill(i); continue; }
      pos[k] += vel[k] * dt; pos[k + 1] += vel[k + 1] * dt; pos[k + 2] += vel[k + 2] * dt;
      i++;
    }
    upload();
  }

  // 開口部まわり: 流入している海面下の開口から気泡（船内の空気が押し出される）と海面の渦の泡
  const debt = new Map();
  function emitOpenings(dt, openings, flows, toWorld) {
    openings.forEach((o, i) => {
      const f = flows[i];
      if (!f || f.mode !== 'inflow') return;
      const w = toWorld(o.spawn.center);
      const nW = new THREE.Vector3(...o.normal).applyQuaternion(shipGroup.quaternion);
      const sea = sim.sea(w[0], w[2]);
      let n = (debt.get(o) ?? 0) + Math.min(400, 20 + 120 * f.q) * dt;
      for (; n >= 1; n--) {
        const r = Math.sqrt(o.area) * 0.6;
        // 生成位置（spawn.center）は船内側なので、外板の外（外向きに 1.2 m）に出す
        if (w[1] < sea - 0.3) emit(P.BUBBLE, w[0] + nW.x * 1.2 + rnd(r), w[1] + nW.y * 1.2 + rnd(r), w[2] + nW.z * 1.2 + rnd(r), nW.x * 0.5 + rnd(0.3), 0.2, nW.z * 0.5 + rnd(0.3));
        // 浅い破口: 吸い込みで海面が乱れる
        if (sea - w[1] < 3 && Math.random() < 0.3) emit(P.SEA_FOAM, w[0] + nW.x * 1.0 + rnd(1.2), sea + 0.04, w[2] + nW.z * 1.0 + rnd(1.2), -nW.x * 0.6, 0, -nW.z * 0.6, 0.5);
      }
      debt.set(o, n);
    });
  }

  // 喫水線に沿った白い泡。船体が海面を切る線上に出し、上下に動いているほど多くする
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  let wakeDebt = 0;
  function emitWaterline(dt, vy) {
    for (wakeDebt += (60 + 500 * Math.abs(vy)) * dt; wakeDebt >= 1; wakeDebt--) {
      const z = H.Z_MIN + Math.random() * H.L, side = Math.random() < 0.5 ? 1 : -1;
      const ya = Math.max(0, H.keelY(z)), yb = H.deckY(z);
      a.set(0, ya, z).applyMatrix4(shipGroup.matrixWorld); b.set(0, yb, z).applyMatrix4(shipGroup.matrixWorld);
      const sa = sim.sea(a.x, a.z) - a.y, sb = sim.sea(b.x, b.z) - b.y;
      if (sa < 0 || sb > 0) continue; // この断面は海面を切っていない
      const y = ya + ((yb - ya) * sa) / (sa - sb), hb = H.halfBreadth(z, y);
      if (hb <= 0) continue;
      a.set(side * (hb + 0.1), y, z).applyMatrix4(shipGroup.matrixWorld);
      b.set(side, 0, 0).applyQuaternion(shipGroup.quaternion);
      emit(P.WAKE, a.x, a.y, a.z, b.x * 0.3 + rnd(0.1), 0, b.z * 0.3 + rnd(0.1));
    }
  }

  function explosion(p, out) {
    for (let n = 0; n < 2600; n++) {
      const up = 6 + Math.random() * 22, spread = 0.5 + Math.random() * 4;
      emit(P.PLUME, p.x + rnd(0.8), Math.max(sim.sea(p.x, p.z) + 0.1, p.y + 0.5), p.z + rnd(0.8), out.x * spread + rnd(2.5), up, out.z * spread + rnd(2.5));
    }
    for (let n = 0; n < 600; n++) emit(P.SEA_FOAM, p.x + rnd(4), 0, p.z + rnd(4), rnd(3), 0, rnd(3));
    for (let n = 0; n < 800; n++) emit(P.BUBBLE, p.x + rnd(1), p.y + rnd(1), p.z + rnd(1), rnd(2), rnd(2), rnd(2));
    for (let n = 0; n < 60; n++) emit(P.MIST, p.x + rnd(2), 1 + Math.random() * 6, p.z + rnd(2), rnd(1.5), 1 + Math.random() * 2, rnd(1.5));
    for (let n = 0; n < 60; n++) emit(P.SMOKE, p.x + rnd(1), 2 + Math.random() * 3, p.z + rnd(1), rnd(1), 1.5 + Math.random(), rnd(1));
  }

  return { sprite, emit, update, emitOpenings, emitWaterline, explosion, get count() { return count; } };
}

// 魚雷（航走中だけ見える）
export function createTorpedo(scene) {
  const g = new THREE.Group();
  const steel = new THREE.MeshStandardNodeMaterial({ color: 0x3b4148, roughness: 0.35, metalness: 0.85 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.27, 6.5, 24).rotateX(Math.PI / 2), steel);
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.27, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2), steel);
  nose.position.z = 3.25;
  g.add(body, nose);
  for (let k = 0; k < 4; k++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.5, 0.5), steel);
    fin.rotation.z = (k * Math.PI) / 2;
    fin.position.set(Math.sin((k * Math.PI) / 2) * 0.3, Math.cos((k * Math.PI) / 2) * 0.3, -3.0);
    g.add(fin);
  }
  g.visible = false;
  scene.add(g);
  return g;
}
