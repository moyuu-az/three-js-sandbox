import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { createSim, SEABED_Y, WATERLINE } from './sim.js';
import * as H from './hull.js';
import { buildShip } from './ship.js';
import { createFloodWater, createParticles, createTorpedo, P } from './fx.js';
import { rippleNormalMap, sandTexture } from './textures.js';

const sim = await createSim();

// ---------- レンダラ・カメラ ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.55;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.localClippingEnabled = true;
document.body.append(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.05, 2000);
camera.position.set(9, 3.5, 7);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0.5, 0);

// ---------- 空・太陽・環境光（空を映り込み用の環境マップにも使う） ----------
const sky = new Sky();
sky.scale.setScalar(1000);
const su = sky.material.uniforms;
su.turbidity.value = 4; su.rayleigh.value = 1.2; su.mieCoefficient.value = 0.004; su.mieDirectionalG.value = 0.85;
const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 18), THREE.MathUtils.degToRad(-150));
su.sunPosition.value.copy(sunDir);
const envScene = new THREE.Scene();
envScene.add(sky.clone());
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(envScene).texture;
scene.add(sky);
const skyFog = new THREE.FogExp2(0xb4c8d8, 0.006);
const underFog = new THREE.FogExp2(0x0c3a52, 0.09);
scene.fog = skyFog;

const sun = new THREE.DirectionalLight(0xfff1dc, 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7, near: 1, far: 80 });
sun.shadow.bias = -0.0005;
scene.add(sun, sun.target);
scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x1d3a4a, 0.35));

// ---------- 海面・海底 ----------
const seaNormal = rippleNormalMap(256, 160);
const sea = new THREE.Mesh(
  new THREE.PlaneGeometry(600, 600).rotateX(-Math.PI / 2),
  new THREE.MeshPhysicalMaterial({
    color: 0x08344f, transparent: true, opacity: 0.85, roughness: 0.1, metalness: 0,
    normalMap: seaNormal, normalScale: new THREE.Vector2(0.22, 0.22), side: THREE.DoubleSide, depthWrite: false,
  }),
);
sea.renderOrder = 0;
scene.add(sea);
const sand = sandTexture();
sand.repeat.set(80, 80);
const seabed = new THREE.Mesh(new THREE.PlaneGeometry(600, 600).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: sand, roughness: 1 }));
seabed.position.y = SEABED_Y;
seabed.receiveShadow = true;
scene.add(seabed);

// ---------- 船・効果 ----------
const ship = buildShip(WATERLINE);
scene.add(ship.group);
const flood = createFloodWater(sim, ship.group);
const fx = createParticles(scene, sim, ship.group);
const torpedo = createTorpedo(scene);
const flash = new THREE.PointLight(0xffc987, 0, 40, 1.5);
scene.add(flash);

// 断面表示: カメラ側の半分を切り取る（区画内の水は fx 側で形状ごと切る）
const cutPlane = new THREE.Plane();
const shipMaterials = new Set();
ship.group.traverse((o) => { if (o.material && o.material !== flood.material) shipMaterials.add(o.material); });
let cutSide = 1;
function setCutaway(on) {
  for (const m of shipMaterials) { m.clippingPlanes = on ? [cutPlane] : null; m.needsUpdate = true; }
  sea.material.opacity = on ? 0.4 : 0.85; // 断面表示では水面下の船内が見えるよう海を透かす
}

// ---------- UI ----------
const $ = (id) => document.getElementById(id);
const fast = $('fast'), cut = $('cut'), info = $('info'), fireBtn = $('fire'), msg = $('msg');
cut.onchange = () => setCutaway(cut.checked);

// ---------- 魚雷 ----------
let run = null; // 航走中の魚雷 { local, side }
function launch(local, side) {
  if (run) return;
  // 魚雷は水中を走るので、喫水線より上を狙っても喫水線の少し下に当たる
  const y = Math.min(local.y, WATERLINE - 0.15);
  const z = THREE.MathUtils.clamp(local.z, H.Z_MIN + 0.3, H.Z_MAX - 0.5);
  if (H.halfBreadth(z, y) <= 0) return;
  run = { local: new THREE.Vector3(side * H.halfBreadth(z, y), y, z), side };
  const target = run.local.clone().applyMatrix4(ship.group.matrixWorld);
  const out = new THREE.Vector3(side, 0, 0).applyQuaternion(ship.group.quaternion).setY(0).normalize();
  torpedo.position.copy(target).addScaledVector(out, 35).setY(Math.min(target.y, -0.25));
  torpedo.visible = true;
  fireBtn.disabled = true;
  msg.textContent = '魚雷航走中…';
}
fireBtn.onclick = () => launch(new THREE.Vector3(0, WATERLINE - 0.3, H.BULKHEADS[1]), 1);

const tgt = new THREE.Vector3();
function updateTorpedo(dt) {
  if (!run || dt <= 0) return;
  tgt.copy(run.local).applyMatrix4(ship.group.matrixWorld);
  const d = tgt.distanceTo(torpedo.position), stepLen = 14 * dt;
  torpedo.lookAt(tgt);
  if (d > stepLen) {
    torpedo.position.addScaledVector(tgt.clone().sub(torpedo.position).normalize(), stepLen);
    for (let n = 0; n < 4; n++) fx.emit(P.BUBBLE, torpedo.position.x + (Math.random() - 0.5) * 0.1, torpedo.position.y, torpedo.position.z + (Math.random() - 0.5) * 0.1, 0, 0.2, 0);
    return;
  }
  // 命中
  torpedo.visible = false;
  const holes = sim.torpedo(run.local.z, run.local.y, run.side);
  ship.addBreachDecal(run.local, new THREE.Vector3(-run.side, 0, 0), 0.35);
  const out = new THREE.Vector3(run.side, 0, 0).applyQuaternion(ship.group.quaternion);
  fx.explosion(tgt, out);
  flash.position.copy(tgt).addScaledVector(out, 0.5);
  flash.intensity = 400;
  msg.textContent = holes.length > 1
    ? `命中！ 破口が隔壁をまたぎ、${holes.length} 区画に浸水`
    : '命中！ 1 区画に浸水（隔壁が持ちこたえれば沈まない）';
  run = null;
  fireBtn.disabled = false;
  if (!cut.checked) { cut.checked = true; setCutaway(true); } // 船内の浸水が見えるように
}

// 船体クリックでその位置を狙う（ドラッグでの視点操作とは区別する）
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
let downAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObjects(ship.hullMeshes)[0];
  if (!hit) return;
  const local = ship.group.worldToLocal(hit.point.clone());
  launch(local, local.x >= 0 ? 1 : -1);
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------- ループ ----------
// 物理は固定 1/60 s。表示のフレームレートに依存しないよう時間を貯めて刻む
const clock = new THREE.Clock();
let acc = 0, simTime = 0, smokeDebt = 0;
const camLocal = new THREE.Vector3(), tmp = new THREE.Vector3();
renderer.setAnimationLoop(() => {
  acc += Math.min(clock.getDelta(), 0.1) * (fast.checked ? 4 : 1);
  let stepped = 0;
  while (acc >= 1 / 60) { sim.step(); acc -= 1 / 60; stepped += 1 / 60; }
  simTime += stepped;

  const t = sim.body.translation(), r = sim.body.rotation();
  ship.group.position.set(t.x, t.y, t.z);
  ship.group.quaternion.set(r.x, r.y, r.z, r.w);
  ship.group.updateMatrixWorld();

  // 断面はカメラ側を切る（x の符号で左右を選ぶ）
  camLocal.copy(camera.position);
  ship.group.worldToLocal(camLocal);
  cutSide = camLocal.x >= 0 ? 1 : -1;
  const cutN = new THREE.Vector3(-cutSide, 0, 0).applyQuaternion(ship.group.quaternion); // 残す側を向く法線
  cutPlane.setFromNormalAndCoplanarPoint(cutN, ship.group.position);
  flood.update(cut.checked ? cutSide : 0, simTime);

  fx.emitInflow(stepped);
  updateTorpedo(stepped);
  // 煙突の煙（水没したら止まる）
  const ft = ship.funnelTop.getWorldPosition(tmp);
  if (ft.y > 0.2) for (smokeDebt += 10 * stepped; smokeDebt >= 1; smokeDebt--) fx.emit(P.SMOKE, ft.x, ft.y, ft.z, 0, 0.4, 0);
  fx.emitWaterline(stepped, sim.body.linvel().y);
  fx.update(stepped, camera.position.y < 0);
  ship.radar.rotation.y += stepped * 2;
  seaNormal.offset.x += stepped * 0.004;
  seaNormal.offset.y += stepped * 0.0025;
  flash.intensity *= Math.exp(-12 * Math.max(stepped, 1 / 240));

  // 太陽の影は船の周りだけ高解像度に
  sun.target.position.copy(ship.group.position);
  sun.position.copy(ship.group.position).addScaledVector(sunDir, 40);

  controls.target.lerp(ship.group.position, 0.03);
  controls.update();
  const under = camera.position.y < 0; // 水中から見ると青く霞む
  scene.fog = under ? underFog : skyFog;
  sky.visible = !under;
  scene.background = under ? underFog.color : null;
  fx.material.uniforms.scale.value = renderer.domElement.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  renderer.render(scene, camera);

  const s = sim.state();
  const q = sim.holes.reduce((a, h) => a + h.q, 0);
  const pct = (c) => `${(s.flood[c] * 100).toFixed(0).padStart(3)}%`;
  info.textContent =
    `時間   ${simTime.toFixed(1)} s\n` +
    `沈下   ${(s.y + WATERLINE).toFixed(2)} m\n` +
    `ピッチ ${s.pitchDeg.toFixed(1)}°  ロール ${s.rollDeg.toFixed(1)}°\n` +
    `流入   ${(q * 1000).toFixed(0)} L/s\n` +
    `浸水   船尾${pct(0)} 中央${pct(1)} 船首${pct(2)}`;
});
