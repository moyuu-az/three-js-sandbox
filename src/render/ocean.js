// 海面の描画。波は waves.js の成分（CPU の浮力と同じ）を GPU でガーストナー変位する。
// 船体の中には海面を描かない（船体の形を半幅テクスチャで判定）。断面表示では手前の海を切り、海水の断面を描く。
import * as THREE from 'three/webgpu';
import {
  Fn, uniform, uniformArray, vec2, vec3, vec4, float, sin, cos, normalize, cross, positionLocal, positionWorld, texture, uv, mix, smoothstep,
  max, min, abs, clamp, dot, exp, transformNormalToView, varying, Discard, cameraPosition, length, pow, If, select, mat4, uniformArray as ua,
} from 'three/tsl';
import * as H from '../hull.js';
import * as Lo from '../layout.js';
import * as W from '../waves.js';
import { rippleNormalMap } from './textures.js';

// 船体の半幅を (z, y) の表にしたテクスチャ（シェーダで「船体の中か」を判定する）
function halfBreadthTexture(nz = 256, ny = 64) {
  const data = new Float32Array(nz * ny * 4);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nz; i++) {
    const z = H.Z_MIN + (H.L * (i + 0.5)) / nz, y = (Lo.HOUSE.top * (j + 0.5)) / ny;
    let hb = H.halfBreadth(z, y);
    if (Lo.inHouse(0, y, z)) hb = Math.max(hb, Lo.HOUSE.hw);
    data[4 * (i + nz * j)] = hb;
  }
  const t = new THREE.DataTexture(data, nz, ny, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}

export function createOcean(scene, { sunDir }) {
  const u = {
    time: uniform(0),
    shipInv: uniform(new THREE.Matrix4()), // ワールド → 船体座標
    cutSide: uniform(0), // 断面表示で切る側（船体座標の x の符号）。0 = 切らない
    center: uniform(new THREE.Vector2()), // メッシュの中心（カメラに追従）
    sunDir: uniform(sunDir.clone()),
  };
  const packed = W.packWaves([]);
  const wa = uniformArray(new Array(W.MAX_WAVES).fill(0).map(() => new THREE.Vector4()), 'vec4');
  const wb = uniformArray(new Array(W.MAX_WAVES).fill(0).map(() => new THREE.Vector4()), 'vec4');
  function setWaves(waves) {
    const p = W.packWaves(waves);
    for (let i = 0; i < W.MAX_WAVES; i++) {
      wa.array[i].fromArray(p.a, 4 * i);
      wb.array[i].fromArray(p.b, 4 * i);
    }
  }
  setWaves([]);
  void packed;

  // ガーストナー変位と、その x0・z0 微分（法線と白波の判定に使う）
  // 代入を使わず式の和で組む（Fn の外、材質のノードとしてそのまま使えるように）
  const gerstner = (p0, fade) => {
    let disp = vec3(0), dx = vec3(1, 0, 0), dz = vec3(0, 0, 1);
    for (let i = 0; i < W.MAX_WAVES; i++) {
      const A = wa.element(i), Bw = wb.element(i);
      const amp = Bw.x.mul(fade);
      const th = A.z.mul(A.x.mul(p0.x).add(A.y.mul(p0.y))).sub(A.w.mul(u.time)).add(Bw.z);
      const s = sin(th), c = cos(th);
      const qa = Bw.y.mul(amp);
      disp = disp.add(vec3(qa.mul(A.x).mul(c), amp.mul(s), qa.mul(A.y).mul(c)));
      const ka = A.z.mul(amp), qka = ka.mul(Bw.y).mul(s);
      dx = dx.add(vec3(qka.mul(A.x).mul(A.x).negate(), ka.mul(A.x).mul(c), qka.mul(A.x).mul(A.y).negate()));
      dz = dz.add(vec3(qka.mul(A.x).mul(A.y).negate(), ka.mul(A.y).mul(c), qka.mul(A.y).mul(A.y).negate()));
    }
    return { disp, dx, dz };
  };

  const hbTex = halfBreadthTexture();
  // 船体座標の点 p が船体（外殻）の中か。少し内側に余裕を取る（喫水線で海面が船体に届くように）
  const insideHull = (p) => {
    const tu = p.z.sub(H.Z_MIN).div(H.L), tv = p.y.div(Lo.HOUSE.top);
    const inRange = tu.greaterThan(0).and(tu.lessThan(1)).and(tv.greaterThan(0)).and(tv.lessThan(1));
    const hb = texture(hbTex, vec2(tu, tv)).r;
    return inRange.and(abs(p.x).lessThan(hb.sub(0.03)));
  };
  // 断面表示で切り取る範囲（船の手前側の箱）
  const CUT_BOX = { x: H.B / 2 + 9, z: H.L / 2 + 6 };
  const inCutBox = (p) => u.cutSide.notEqual(0).and(p.x.mul(u.cutSide).greaterThan(-0.02)).and(p.x.mul(u.cutSide).lessThan(CUT_BOX.x)).and(abs(p.z).lessThan(CUT_BOX.z));

  const ripple = rippleNormalMap(512);
  function makeSurface(size, segs, fadeStart, fadeEnd) {
    const geo = new THREE.PlaneGeometry(size, size, segs, segs).rotateX(-Math.PI / 2);
    const m = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.04, metalness: 0, side: THREE.DoubleSide, ior: 1.333 });
    const p0 = positionLocal.xz.add(u.center);
    const fade = float(1).sub(smoothstep(fadeStart, fadeEnd, length(p0.sub(cameraPosition.xz))));
    const g = gerstner(p0, fade);
    m.positionNode = vec3(p0.x, 0, p0.y).add(g.disp).sub(vec3(u.center.x, 0, u.center.y));
    const nWorld = varying(normalize(cross(g.dz, g.dx)), 'vWaveN');
    // 白波: ガーストナーの面の縮み（ヤコビアン）が小さい所
    const jac = varying(g.dx.x.mul(g.dz.z).sub(g.dx.z.mul(g.dz.x)), 'vWaveJ');
    const crest = varying(g.disp.y, 'vWaveH');
    // 細かいさざ波（2 枚を流して重ねる）
    const wp = positionWorld.xz;
    const r1 = texture(ripple, wp.mul(0.045).add(vec2(u.time.mul(0.012), u.time.mul(0.007)))).xyz.mul(2).sub(1);
    const r2 = texture(ripple, wp.mul(0.11).sub(vec2(u.time.mul(0.009), u.time.mul(-0.014)))).xyz.mul(2).sub(1);
    const detail = r1.add(r2.mul(0.6));
    const n = normalize(nWorld.add(vec3(detail.x, 0, detail.y).mul(0.18)));
    m.normalNode = transformNormalToView(n);
    const foam = smoothstep(0.75, 0.35, jac).mul(0.9);
    const deep = vec3(0.012, 0.075, 0.12), shallow = vec3(0.03, 0.26, 0.3);
    const scatter = mix(deep, shallow, clamp(crest.mul(0.6).add(0.35), 0, 1));
    // 船体の中・断面表示で切る範囲には描かない（不透明材質でも確実に効くよう色の計算の中で捨てる）
    m.colorNode = Fn(() => {
      const pl = u.shipInv.mul(vec4(positionWorld, 1)).xyz;
      Discard(insideHull(pl).or(inCutBox(pl)));
      return mix(scatter, vec3(0.92, 0.95, 0.97), foam);
    })();
    m.roughnessNode = mix(float(0.03), float(0.6), foam);
    // 太陽の方向から透ける光（波頂の緑がかった透過光）
    const sss = pow(max(0, dot(normalize(positionWorld.sub(cameraPosition)), u.sunDir)), 4).mul(clamp(crest, 0, 1)).mul(0.25);
    m.emissiveNode = vec3(0.05, 0.28, 0.25).mul(sss).add(scatter.mul(0.08));
    const mesh = new THREE.Mesh(geo, m);
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    return mesh;
  }
  const near = makeSurface(420, 700, 120, 200);
  const far = makeSurface(6000, 160, 0, 0.001); // 遠景は平ら（格子が粗く波を描くと揺らいで見える）。細かい波は法線だけ
  far.position.y = -0.05; // 近景と重なる所は近景を優先
  scene.add(near, far);

  // 海水の断面（断面表示のとき）。手前の海を箱形に切り取り、その内側の面（船の中心面・両端・底）を海水の切り口として描く。
  // 手前の外側の面は描かない（横から船内を見通せるように）。深さで青く暗くなる
  const secMat = new THREE.MeshBasicNodeMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: false });
  const secDepth = gerstner(positionWorld.xz, float(1)).disp.y.sub(positionWorld.y); // 海面（変位の反復をしない近似）からの深さ
  const secK = exp(secDepth.mul(-0.06));
  secMat.colorNode = Fn(() => {
    const pl = u.shipInv.mul(vec4(positionWorld, 1)).xyz;
    Discard(secDepth.lessThan(0).or(insideHull(pl)));
    return mix(vec3(0.004, 0.025, 0.05), vec3(0.05, 0.32, 0.4), secK);
  })();
  secMat.opacityNode = mix(float(0.92), float(0.55), secK);
  const BOT = -26, TOPY = 8;
  const section = new THREE.Group(); // 船体座標。x の向きは切る側に合わせて毎フレーム反転する
  const face = (geo) => { const m = new THREE.Mesh(geo, secMat); m.renderOrder = 3; m.frustumCulled = false; section.add(m); };
  face(new THREE.PlaneGeometry(2 * CUT_BOX.z, TOPY - BOT).rotateY(Math.PI / 2).translate(0, (TOPY + BOT) / 2, 0)); // 中心面
  face(new THREE.PlaneGeometry(CUT_BOX.x, 2 * CUT_BOX.z).rotateX(-Math.PI / 2).translate(CUT_BOX.x / 2, BOT, 0)); // 底
  for (const z of [-CUT_BOX.z, CUT_BOX.z]) face(new THREE.PlaneGeometry(CUT_BOX.x, TOPY - BOT).translate(CUT_BOX.x / 2, (TOPY + BOT) / 2, z)); // 両端
  section.visible = false;

  const tmpM = new THREE.Matrix4();
  function update(t, camera, shipGroup, cutSide) {
    u.time.value = t;
    u.cutSide.value = cutSide;
    u.shipInv.value.copy(tmpM.copy(shipGroup.matrixWorld).invert());
    const step = 420 / 700;
    for (const m of [near, far]) {
      const s = m === near ? step : 6000 / 160;
      m.position.x = Math.round(camera.position.x / s) * s;
      m.position.z = Math.round(camera.position.z / s) * s;
    }
    u.center.value.set(near.position.x, near.position.z);
    // 遠景は中心がずれるので別の一様変数にせず、近景と同じ中心を使う（遠景の格子は粗いので誤差は見えない）
    far.position.x = near.position.x; far.position.z = near.position.z;
    section.visible = cutSide !== 0;
    section.scale.x = cutSide || 1;
  }

  return { near, far, section, uniforms: u, setWaves, update };
}
