// 船内の水（GPU 流体の粒子）の描画。スクリーンスペース流体レンダリング:
//   1) 粒子を球として描き、カメラからの距離（深度）を記録  2) 厚み・泡を加算
//   3) 深度を境界を保ったままぼかして滑らかな水面にする  4) 合成（法線 → 反射・屈折・吸収・泡）
// 「粒子」表示では、同じ粒子を流速で色分けした球として描く（水の流れが見やすい）
import * as THREE from 'three/webgpu';
import {
  Fn, uniform, float, vec2, vec3, vec4, uv, dot, sqrt, max, min, clamp, exp, mix, normalize, length, abs, select, texture, screenUV,
  positionView, instanceIndex, Discard, viewZToPerspectiveDepth, cameraNear, cameraFar, cameraProjectionMatrix, cameraWorldMatrix, pow,
  smoothstep, pmremTexture, reflect, cross, If,
} from 'three/tsl';

export function createFluidRenderer(renderer, fluid, { h, origin, ppc }) {
  const { pos, vel } = fluid.buffers;
  const spacing = h / Math.cbrt(ppc); // 静止した水での粒子の間隔
  const u = {
    radius: uniform(spacing * 0.75), // 描画する球の半径 [m]
    cutSide: uniform(0),
    originX: uniform(origin[0]),
    h: uniform(h),
    texel: uniform(new THREE.Vector2(1, 1)),
    focal: uniform(1),
    sunDirView: uniform(new THREE.Vector3(0, 1, 0)),
    speedScale: uniform(1 / 4), // 粒子表示の色: この速さ [m/s] で最も明るい色
    projX: uniform(1), projY: uniform(1), // 射影行列の対角成分（深度から視点空間の位置を戻す）
    surfaceOn: uniform(1), // 0 なら合成しない（粒子表示のとき）
  };
  // 粒子の格子座標 → 船体座標のアンカー（毎フレーム、船の行列 × 平行移動 × 拡大 を入れる）
  const anchor = new THREE.Object3D(); // 深度・厚みのパス用
  anchor.matrixAutoUpdate = false;
  const mainAnchor = new THREE.Object3D(); // 粒子表示用（本体のシーンに入れて船と前後関係を正しく描く）
  mainAnchor.matrixAutoUpdate = false;
  const anchorLocal = new THREE.Matrix4().compose(new THREE.Vector3(...origin), new THREE.Quaternion(), new THREE.Vector3(h, h, h));

  // 生きていて、断面表示で切り取る側にない粒子だけ描く（大きさ 0 で消す）
  const visible = Fn(() => {
    const p = pos.element(instanceIndex);
    const lx = u.originX.add(p.x.mul(u.h));
    return p.w.greaterThan(0.5).and(u.cutSide.equal(0).or(lx.mul(u.cutSide).lessThan(0)));
  });
  const spriteScale = select(visible(), u.radius.mul(2).div(u.h), float(0));

  // ---- 1) 深度 ----
  const depthMat = new THREE.SpriteNodeMaterial({ depthTest: true, depthWrite: true });
  depthMat.positionNode = pos.element(instanceIndex).xyz;
  depthMat.scaleNode = spriteScale;
  const sphere = () => {
    const d = uv().mul(2).sub(1);
    const r2 = dot(d, d);
    Discard(r2.greaterThan(1));
    return sqrt(float(1).sub(r2));
  };
  depthMat.colorNode = Fn(() => {
    const zc = sphere();
    const viewZ = positionView.z.add(zc.mul(u.radius));
    return vec4(viewZ.negate(), 0, 0, 1);
  })();
  depthMat.depthNode = Fn(() => viewZToPerspectiveDepth(positionView.z.add(sphere().mul(u.radius)), cameraNear, cameraFar))();

  // ---- 2) 厚み（R）と泡（G） ----
  const thickMat = new THREE.SpriteNodeMaterial({ depthTest: false, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending });
  thickMat.positionNode = depthMat.positionNode;
  thickMat.scaleNode = spriteScale;
  thickMat.colorNode = Fn(() => {
    const zc = sphere();
    const v = vel.element(instanceIndex);
    const speed = length(v.xyz).mul(u.h);
    // 泡: 速い流れ・密度の低い（しぶき状の）粒子
    const foam = smoothstep(1.6, 4.5, speed).add(smoothstep(0.75, 0.35, v.w).mul(0.6));
    return vec4(zc.mul(u.radius).mul(2), foam.mul(zc), 0, 1);
  })();

  // ---- 粒子表示（流速で色分け、陰影付きの球） ----
  const partMat = new THREE.SpriteNodeMaterial({ depthTest: true, depthWrite: true });
  partMat.positionNode = depthMat.positionNode;
  partMat.scaleNode = spriteScale.mul(0.8);
  partMat.colorNode = Fn(() => {
    const d = uv().mul(2).sub(1);
    const r2 = dot(d, d);
    Discard(r2.greaterThan(1));
    const n = vec3(d.x, d.y.negate(), sqrt(float(1).sub(r2)));
    const s = clamp(length(vel.element(instanceIndex).xyz).mul(u.h).mul(u.speedScale), 0, 1);
    // 遅い = 深い青 → 速い = 水色 → 白
    const c = mix(mix(vec3(0.02, 0.12, 0.45), vec3(0.1, 0.65, 0.95), smoothstep(0, 0.5, s)), vec3(1, 1, 1), smoothstep(0.5, 1, s));
    const light = clamp(dot(n, normalize(vec3(0.4, 0.6, 0.7))), 0, 1).mul(0.7).add(0.35);
    return vec4(c.mul(light), 1);
  })();
  partMat.depthNode = depthMat.depthNode;

  const makeSprite = (m, parent = anchor) => { const s = new THREE.Sprite(m); s.count = 1; s.frustumCulled = false; parent.add(s); return s; };
  const depthSprite = makeSprite(depthMat), thickSprite = makeSprite(thickMat), partSprite = makeSprite(partMat, mainAnchor);
  partSprite.visible = false;
  const passScene = new THREE.Scene();
  passScene.add(anchor);

  // ---- レンダーターゲット ----
  const rtOpt = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter };
  const rtDepth = new THREE.RenderTarget(1, 1, { ...rtOpt, depthBuffer: true, magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter });
  const rtThick = new THREE.RenderTarget(1, 1, rtOpt);
  const rtA = new THREE.RenderTarget(1, 1, { ...rtOpt, magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter });
  const rtB = rtA.clone();

  // ---- 3) 深度のぼかし（境界を保つ、縦横に分けて 2 回） ----
  // 入力テクスチャと方向ごとに材質を分ける（1 フレーム内で同じ材質のテクスチャを差し替えると、バインドの更新が追いつかないことがある）
  const R = 7;
  const makeBlur = (srcRT, dir) => {
    const src = texture(srcRT.texture);
    const m = new THREE.NodeMaterial();
    m.fragmentNode = Fn(() => {
      const c = src.sample(screenUV).r.toVar();
      // 粒子半径の 1.6 倍の幅を画面上の画素数に直し、R 段で割った間隔でサンプルする
      const px = clamp(u.radius.mul(1.6).mul(u.focal).div(max(c, 0.01)).div(R), 0.35, 3.0);
      const sum = float(0).toVar(), wsum = float(0).toVar();
      const sigD = u.radius.mul(2.5);
      const stepUV = vec2(dir[0], dir[1]).mul(u.texel).mul(px);
      for (let i = -R; i <= R; i++) {
        const s = src.sample(screenUV.add(stepUV.mul(i))).r;
        const wd = s.sub(c).div(sigD);
        const w = select(s.greaterThan(0), float(Math.exp(-(i * i) / (2 * (R / 2) ** 2))).mul(exp(wd.mul(wd).negate())), float(0));
        sum.addAssign(s.mul(w)); wsum.addAssign(w);
      }
      // 水の無い画素は 0 のまま（ぼかしで水を広げない）
      return vec4(select(c.greaterThan(0), sum.div(max(wsum, 1e-5)), float(0)), 0, 0, 1);
    })();
    return new THREE.QuadMesh(m);
  };
  const blurPasses = [[makeBlur(rtDepth, [1, 0]), rtA], [makeBlur(rtA, [0, 1]), rtB], [makeBlur(rtB, [1, 0]), rtA], [makeBlur(rtA, [0, 1]), rtB]];

  function resize(w, hh, dpr) {
    const W = Math.floor(w * dpr), Hh = Math.floor(hh * dpr);
    rtDepth.setSize(W, Hh); rtA.setSize(W, Hh); rtB.setSize(W, Hh);
    rtThick.setSize(Math.max(1, W >> 1), Math.max(1, Hh >> 1));
    u.texel.value.set(1 / W, 1 / Hh);
  }

  const tmpM = new THREE.Matrix4(), clear = new THREE.Color();
  let mode = 'surface';
  // 船の行列を反映して、深度・厚み・ぼかしを描く（本体の描画の前に呼ぶ）
  function render(camera, shipMatrix, { cutSide = 0, sunDir }) {
    for (const a of [anchor, mainAnchor]) { a.matrix.multiplyMatrices(shipMatrix, anchorLocal); a.matrixWorld.copy(a.matrix); }
    u.projX.value = camera.projectionMatrix.elements[0];
    u.projY.value = camera.projectionMatrix.elements[5];
    partSprite.visible = mode === 'particles';
    u.surfaceOn.value = mode === 'surface' ? 1 : 0;
    if (mode !== 'surface') return;
    const n = fluid.drawCount;
    for (const s of [depthSprite, thickSprite, partSprite]) s.count = Math.max(1, n);
    u.cutSide.value = cutSide;
    u.focal.value = (camera.projectionMatrix.elements[5] * rtDepth.height) / 2;
    u.sunDirView.value.copy(sunDir).transformDirection(camera.matrixWorldInverse);
    const prevRT = renderer.getRenderTarget(), prevAlpha = renderer.getClearAlpha();
    renderer.getClearColor(clear);
    renderer.setClearColor(0x000000, 0);
    depthSprite.visible = true; thickSprite.visible = false; partSprite.visible = false;
    renderer.setRenderTarget(rtDepth); renderer.clear(); renderer.render(passScene, camera);
    depthSprite.visible = false; thickSprite.visible = true;
    renderer.setRenderTarget(rtThick); renderer.clear(); renderer.render(passScene, camera);
    thickSprite.visible = false;
    for (const [quad, target] of blurPasses) { renderer.setRenderTarget(target); quad.render(renderer); }
    renderer.setRenderTarget(prevRT);
    renderer.setClearColor(clear, prevAlpha);
  }

  // ---- 4) 合成ノード（後処理パイプラインで使う）。sceneColor / sceneViewZ はシーンのパスから ----
  function compositeNode(sceneColor, sceneViewZ, envMap) {
    const dTex = texture(rtB.texture), rawTex = texture(rtDepth.texture), thTex = texture(rtThick.texture);
    return Fn(() => {
      const base = sceneColor.sample(screenUV);
      const d = dTex.sample(screenUV).r.toVar();
      const raw = rawTex.sample(screenUV).r;
      const sceneD = sceneViewZ.negate();
      // 水が無い・壁の向こう側（シーンの方が手前）なら元の色
      const isWater = u.surfaceOn.greaterThan(0.5).and(d.greaterThan(0)).and(raw.greaterThan(0)).and(d.lessThan(sceneD.add(u.radius.mul(0.5))));
      // 深度から視点空間の位置を復元し、隣の画素との差から法線を作る（差の小さい側を使って縁を立てない）
      const dd0 = max(d, 0.01);
      const viewPos = (uvq, dd) => vec3(uvq.x.mul(2).sub(1).mul(dd).div(u.projX), uvq.y.mul(2).sub(1).negate().mul(dd).div(u.projY), dd.negate());
      const p0 = viewPos(screenUV, dd0);
      const du = vec2(u.texel.x, 0), dv = vec2(0, u.texel.y);
      const sR = dTex.sample(screenUV.add(du)).r, sL = dTex.sample(screenUV.sub(du)).r;
      const sU = dTex.sample(screenUV.sub(dv)).r, sD = dTex.sample(screenUV.add(dv)).r;
      const ddx = select(abs(sR.sub(d)).lessThan(abs(d.sub(sL))).and(sR.greaterThan(0)), viewPos(screenUV.add(du), sR).sub(p0), p0.sub(viewPos(screenUV.sub(du), max(sL, 0.01))));
      const ddy = select(abs(sU.sub(d)).lessThan(abs(d.sub(sD))).and(sU.greaterThan(0)), viewPos(screenUV.sub(dv), sU).sub(p0), p0.sub(viewPos(screenUV.add(dv), max(sD, 0.01))));
      const n = normalize(cross(ddx, ddy)).toVar();
      If(n.z.lessThan(0), () => { n.assign(n.negate()); });
      const V = normalize(p0.negate());
      const th = thTex.sample(screenUV);
      const thickness = th.r, foam = clamp(th.g.mul(0.35), 0, 1);
      // 屈折: 法線で背景をずらす（厚いほど大きく）
      const refr = sceneColor.sample(screenUV.add(n.xy.mul(0.025).mul(clamp(thickness, 0, 1.5)))).rgb;
      // 吸収（Beer–Lambert）と散乱: 海水は赤から先に消える
      const trans = exp(vec3(0.45, 0.11, 0.08).mul(thickness).mul(-1.4));
      const body = refr.mul(trans).add(vec3(0.02, 0.12, 0.14).mul(float(1).sub(trans)));
      // 反射: 環境（空）と太陽の鏡面反射。フレネル（シュリック近似、F0 = 0.02）
      const fres = float(0.02).add(pow(float(1).sub(clamp(dot(n, V), 0, 1)), 5).mul(0.98));
      const nW = cameraWorldMatrix.mul(vec4(n, 0)).xyz;
      const vW = cameraWorldMatrix.mul(vec4(V.negate(), 0)).xyz;
      const env = pmremTexture(envMap, reflect(vW, nW), float(0.05)).rgb.mul(0.6);
      const Hh = normalize(u.sunDirView.add(V));
      const spec = pow(clamp(dot(n, Hh), 0, 1), 400).mul(6);
      const col = mix(body, env, fres).add(spec).toVar();
      col.assign(mix(col, vec3(0.9, 0.95, 0.97), foam));
      // 縁（粒子が少ない所）は背景に溶かす
      const edge = smoothstep(0.02, 0.12, thickness);
      return select(isWater, vec4(mix(base.rgb, col, edge), 1), base);
    })();
  }

  return {
    anchor, mainAnchor, passScene, uniforms: u, resize, render, compositeNode,
    setMode(m) { mode = m; },
    get mode() { return mode; },
  };
}

