// 描画の舞台: WebGPU レンダラ・カメラ・空と環境光・太陽・海底・水中の霧・後処理（流体の合成・ブルーム・トーンマップ・FXAA）
import * as THREE from 'three/webgpu';
import { pass, renderOutput, texture, uv, vec3, positionWorld, sin, float, mix, uniform, abs, fract, color, vec2 } from 'three/tsl';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { sandTexture } from './textures.js';

export class WebGPUUnavailable extends Error {}

// allowWebGL は開発用（dev/model.html）: 流体を使わない確認で、WebGPU が無い環境でも描けるようにする
export async function createStage(container, { seabedY, allowWebGL = false }) {
  let limits = {};
  if (!allowWebGL) {
    if (!navigator.gpu) throw new WebGPUUnavailable('このブラウザは WebGPU に対応していません');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new WebGPUUnavailable('WebGPU のアダプタを取得できませんでした（GPU ドライバの状態を確認してください）');
    // 流体の G2P カーネルは 8 本を超える storage buffer を使う（既定の上限は 8）
    limits = { maxStorageBuffersPerShaderStage: Math.min(16, adapter.limits.maxStorageBuffersPerShaderStage) };
  }
  const renderer = new THREE.WebGPURenderer({ antialias: false, powerPreference: 'high-performance', requiredLimits: limits, forceWebGL: allowWebGL && !navigator.gpu });
  await renderer.init();
  if (!allowWebGL && !renderer.backend.isWebGPUBackend) throw new WebGPUUnavailable('WebGPU を初期化できず WebGL に切り替わりました');
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setSize(innerWidth, innerHeight);
  // 空（SkyMesh）の輝度が高いので露出を絞る。ACES は AgX より彩度が残り、船体の塗装色が白っぽく飛ばない
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.5;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.append(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.1, 6000);
  camera.position.set(34, 13, 30);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxDistance = 220;
  controls.minDistance = 4;
  controls.target.set(0, 2, 0);

  // ---------- 空・太陽・環境光 ----------
  const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 24), THREE.MathUtils.degToRad(-140));
  const sky = new SkyMesh();
  sky.scale.setScalar(5000);
  sky.turbidity.value = 3.2; sky.rayleigh.value = 1.4; sky.mieCoefficient.value = 0.004; sky.mieDirectionalG.value = 0.86;
  sky.cloudCoverage.value = 0.35; sky.cloudDensity.value = 0.5;
  sky.sunPosition.value.copy(sunDir);
  scene.add(sky);
  const envScene = new THREE.Scene();
  const envSky = new SkyMesh();
  envSky.scale.setScalar(1000);
  for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG', 'cloudCoverage', 'cloudDensity']) envSky[k].value = sky[k].value;
  envSky.sunPosition.value.copy(sunDir);
  envScene.add(envSky);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envRT = pmrem.fromScene(envScene, 0.02);
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.9;

  const sun = new THREE.DirectionalLight(0xfff0d8, 3.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 160 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);
  scene.add(new THREE.HemisphereLight(0xcfe2ff, 0x1a3542, 0.35));

  // ---------- 海底（砂と揺れる集光模様） ----------
  const sand = sandTexture();
  const time = uniform(0);
  const bedMat = new THREE.MeshStandardNodeMaterial({ roughness: 1 });
  const buv = positionWorld.xz.mul(0.08);
  bedMat.colorNode = texture(sand.map, buv).rgb;
  bedMat.bumpMap = sand.bumpMap;
  // コースティクス: 2 方向の干渉縞を時間でずらした近似（海面の集光）
  const ca = abs(sin(positionWorld.x.mul(0.9).add(sin(positionWorld.z.mul(0.7).add(time.mul(0.8))).mul(1.6)).add(time)));
  const cb = abs(sin(positionWorld.z.mul(1.1).add(sin(positionWorld.x.mul(0.6).sub(time.mul(0.6))).mul(1.4)).sub(time.mul(0.9))));
  bedMat.emissiveNode = vec3(0.35, 0.55, 0.5).mul(float(1).sub(ca).mul(float(1).sub(cb)).pow(6).mul(0.9));
  const bed = new THREE.Mesh(new THREE.PlaneGeometry(1200, 1200).rotateX(-Math.PI / 2), bedMat);
  bed.position.y = seabedY;
  bed.receiveShadow = true;
  scene.add(bed);
  // 海底の岩（着底したときに景色が単調にならないように）
  const rockMat = new THREE.MeshStandardNodeMaterial({ color: 0x4b4a44, roughness: 0.95 });
  for (let i = 0; i < 60; i++) {
    const r = new THREE.Mesh(new THREE.DodecahedronGeometry(0.5 + Math.random() * 2.5, 0), rockMat);
    const a = Math.random() * Math.PI * 2, d = 25 + Math.random() * 160;
    r.position.set(Math.cos(a) * d, seabedY + 0.2, Math.sin(a) * d);
    r.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    r.scale.y = 0.5;
    r.receiveShadow = r.castShadow = true;
    scene.add(r);
  }

  // ---------- 霧（空気中はうっすら、水中は濃い青） ----------
  const airFog = new THREE.FogExp2(0xbfd3e0, 0.0011);
  const waterFog = new THREE.FogExp2(0x0b3c4f, 0.045);
  scene.fog = airFog;
  function setUnderwater(under) {
    scene.fog = under ? waterFog : airFog;
    scene.background = under ? waterFog.color : null;
    sky.visible = !under;
  }

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  // ---------- 後処理 ----------
  // composite(color, viewZ) は流体の合成など、シーンの色と深度を受け取って色を返すノード
  function createPipeline(composite) {
    const scenePass = pass(scene, camera);
    const color = composite(scenePass.getTextureNode('output'), scenePass.getViewZNode(), envRT.texture);
    const glow = bloom(color, 0.12, 0.35, 2.8); // 太陽の照り返しや灯火だけ光らせる（空全体にかけると白くかすむ）
    const pipeline = new THREE.RenderPipeline(renderer);
    pipeline.outputColorTransform = false;
    pipeline.outputNode = fxaa(renderOutput(color.add(glow)));
    return pipeline;
  }

  return { renderer, scene, camera, controls, sun, sunDir, sky, envTexture: envRT.texture, bed, time, setUnderwater, createPipeline };
}
