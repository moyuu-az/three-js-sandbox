// 海面の描画。波は waves.js の成分（CPU の浮力と同じ）を GPU でガーストナー変位する。
// 船体の中には海面を描かない（船体の形を半幅テクスチャで判定）。断面表示では手前の海を切り、海水の断面を描く。
import * as THREE from 'three/webgpu';
import {
  Fn, uniform, uniformArray, vec2, vec3, vec4, float, sin, cos, normalize, cross, positionLocal, positionWorld, texture, uv, mix, smoothstep,
  max, min, abs, clamp, dot, exp, transformNormalToView, varying, Discard, cameraPosition, length, pow, If, select, mat4, uniformArray as ua,
} from 'three/tsl';
import * as H from '../hull.js';
import * as W from '../waves.js';
import { rippleNormalMap } from './textures.js';

// 船体の半幅を (z, y) の表にしたテクスチャ（シェーダで「船体の中か」を判定する）
function halfBreadthTexture(nz = 1024, ny = 64) {
  const data = new Float32Array(nz * ny * 4);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nz; i++) {
    const z = H.Z_MIN + (H.L * (i + 0.5)) / nz, y = (H.Y_MAX * (j + 0.5)) / ny;
    data[4 * (i + nz * j)] = H.halfBreadth(z, y);
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
    cutDir: uniform(new THREE.Vector2()), // 手前の海を切り取る向き（船体座標の水平 (x, z)、カメラの側）。0 ベクトル = 切らない
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
    const tu = p.z.sub(H.Z_MIN).div(H.L), tv = p.y.div(H.Y_MAX);
    const inRange = tu.greaterThan(0).and(tu.lessThan(1)).and(tv.greaterThan(0)).and(tv.lessThan(1));
    const hb = texture(hbTex, vec2(tu, tv)).r;
    return inRange.and(abs(p.x).lessThan(hb.sub(0.03)));
  };
  // 断面・透視表示で切り取る範囲: 船の中心から cutDir の側へ x、横へ ±z の箱（断面は船の横向き、透視はカメラの方位に合わせて回る）
  const CUT_BOX = { x: 80, z: H.L / 2 + 6 }; // 手前側は広く切る（狭いと、低い位置のカメラから見て手前の海面が船の水面下を隠す）
  const inCutBox = (p) => {
    const a = p.x.mul(u.cutDir.x).add(p.z.mul(u.cutDir.y)), b = p.z.mul(u.cutDir.x).sub(p.x.mul(u.cutDir.y));
    return dot(u.cutDir, u.cutDir).greaterThan(0.25).and(a.greaterThan(-0.02)).and(a.lessThan(CUT_BOX.x)).and(abs(b).lessThan(CUT_BOX.z));
  };

  const ripple = rippleNormalMap(512);
  // hole: メッシュの中心からこの半幅の正方形の中は描かない（遠景で、近景と重なる範囲を抜く）
  function makeSurface(size, segs, fadeStart, fadeEnd, hole = 0) {
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
      let cull = insideHull(pl).or(inCutBox(pl));
      if (hole > 0) { const d = abs(positionWorld.xz.sub(u.center)); cull = cull.or(max(d.x, d.y).lessThan(hole)); }
      Discard(cull);
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
  // 近景: 一辺 NEAR [m]・NEAR_SEGS 分割。波はカメラから 200 m で消える（中心はカメラに追従するので、遠景の穴 NEAR / 2 − 0.5 より内側で消えること）
  const NEAR = 420, NEAR_SEGS = 700;
  const near = makeSurface(NEAR, NEAR_SEGS, 120, 200);
  // 遠景は平ら（格子が粗く波を描くと揺らいで見える）。細かい波は法線だけ。
  // 近景と重なる範囲は抜く: 平らな遠景（y = −0.05）が近景の波の谷より上に来て、谷を平らに塗りつぶすため。
  // 近景の端（中心から NEAR / 2）は波が消えて平らなので、0.5 m だけ重ねて継ぎ目の隙間を防ぐ
  const far = makeSurface(6000, 160, 0, 0.001, NEAR / 2 - 0.5);
  far.position.y = -0.05; // 重なる帯では近景を優先
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
  secMat.opacityNode = mix(float(0.97), float(0.6), secK);
  const BOT = -26, TOPY = 8;
  const section = new THREE.Group(); // 船体座標。局所 x を切る向き（cutDir）に合わせて毎フレーム回す
  const face = (geo) => { const m = new THREE.Mesh(geo, secMat); m.renderOrder = 3; m.frustumCulled = false; section.add(m); };
  face(new THREE.PlaneGeometry(2 * CUT_BOX.z, TOPY - BOT).rotateY(Math.PI / 2).translate(0, (TOPY + BOT) / 2, 0)); // 中心面
  face(new THREE.PlaneGeometry(CUT_BOX.x, 2 * CUT_BOX.z).rotateX(-Math.PI / 2).translate(CUT_BOX.x / 2, BOT, 0)); // 底
  for (const z of [-CUT_BOX.z, CUT_BOX.z]) face(new THREE.PlaneGeometry(CUT_BOX.x, TOPY - BOT).translate(CUT_BOX.x / 2, (TOPY + BOT) / 2, z)); // 両端
  section.visible = false;

  const tmpM = new THREE.Matrix4();
  // cutDir: [dx, dz]（単位ベクトル、船体座標）または null（切らない）
  function update(t, camera, shipGroup, cutDir) {
    u.time.value = t;
    u.cutDir.value.set(cutDir ? cutDir[0] : 0, cutDir ? cutDir[1] : 0);
    u.shipInv.value.copy(tmpM.copy(shipGroup.matrixWorld).invert());
    const step = NEAR / NEAR_SEGS;
    for (const m of [near, far]) {
      const s = m === near ? step : 6000 / 160;
      m.position.x = Math.round(camera.position.x / s) * s;
      m.position.z = Math.round(camera.position.z / s) * s;
    }
    u.center.value.set(near.position.x, near.position.z);
    // 遠景は中心がずれるので別の一様変数にせず、近景と同じ中心を使う（遠景の格子は粗いので誤差は見えない）
    far.position.x = near.position.x; far.position.z = near.position.z;
    section.visible = !!cutDir;
    if (cutDir) section.rotation.y = Math.atan2(-cutDir[1], cutDir[0]);
  }

  return { near, far, section, uniforms: u, setWaves, update, cutBox: CUT_BOX };
}
