// アプリ本体: 船の運動（CPU・Rapier）と船内の水（GPU・MLS-MPM）をつなぎ、描画と UI を回す。
//
// 1 フレームの流れ:
//   GPU 流体の集計（水の質量・重心・慣性、部屋ごとの水量）→ 船の剛体に合成 → 船の運動を固定刻みで進める
//   → 部屋の水位と開口部の内外水頭差から流量を求め、開口部に粒子を生成 → 船の加速度・回転を見かけの力として流体を進める → 描画
import * as THREE from 'three/webgpu';
import { createStage, WebGPUUnavailable } from './render/stage.js';
import { createSim, SEABED_Y, RHO, ENVELOPE_VOLUME, SHIP_MASS, DT } from './sim.js';
import { buildShipGrid, breachAt, gridSpec } from './shipgrid.js';
import { packForGpu, MAX_OPENINGS } from './voxel.js';
import { createFluid, OPEN_FREE, OPEN_INFLOW, OPEN_CLOSED } from './gpu/fluid.js';
import * as F from './flooding.js';
import { waterMassProps, openingParams } from './coupling.js';
import * as W from './waves.js';
import * as Lo from './layout.js';
import * as H from './hull.js';
import { buildShipModel } from './render/shipModel.js';
import { createOcean } from './render/ocean.js';
import { createFluidRenderer } from './render/fluidRender.js';
import { createFx, createTorpedo, P } from './render/fx.js';
import { createProfile } from './ui/profile.js';
import { createChart } from './ui/chart.js';

// 画質: 格子間隔 h と粒子の上限。剛性は「水深 5 m で約 7% 圧縮」になる値（音速 → 安定な時間刻み）
const QUALITY = {
  light: { h: 0.36, max: 131072, subCap: 4 },
  standard: { h: 0.3, max: 262144, subCap: 5 },
  high: { h: 0.25, max: 393216, subCap: 6 },
};
const PPC = 8; // 1 セルあたりの粒子数（静止時）
const MAX_SUBSTEPS = 10; // 1 フレームの流体サブステップの上限（GPU の負荷の上限。超えるとスロー再生になる）

const $ = (id) => document.getElementById(id);
const store = { get: (k, d) => { try { return JSON.parse(sessionStorage.getItem(k)) ?? d; } catch { return d; } }, set: (k, v) => { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* 保存できなくても動く */ } } };
const settings = { quality: store.get('quality', 'standard'), sea: store.get('sea', 'calm') };
if (!QUALITY[settings.quality]) settings.quality = 'standard';

function fatal(msg) {
  $('loading').classList.add('hidden');
  $('fatalMsg').textContent = msg;
  $('fatal').classList.remove('hidden');
}
function toast(text, kind = '') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = text;
  $('toasts').prepend(t);
  setTimeout(() => t.classList.add('out'), 4200);
  setTimeout(() => t.remove(), 4700);
  while ($('toasts').childElementCount > 5) $('toasts').lastElementChild.remove();
}

async function main() {
  const Q = QUALITY[settings.quality];
  const h = Q.h, spec = gridSpec(h);
  const particleVolume = h ** 3 / PPC; // 粒子 1 個の水の体積 [m³]
  const stiffness = (PPC * 9.81 * 5) / (h * h * 7 * 0.07);
  const soundSpeed = Math.sqrt((7 * stiffness) / PPC); // [セル/s]
  const dtMax = 0.35 / soundSpeed; // 流体の安定な時間刻み [s]

  $('loadingMsg').textContent = 'GPU を初期化中…';
  let stage;
  try {
    stage = await createStage($('app'), { seabedY: SEABED_Y });
  } catch (e) {
    fatal(e instanceof WebGPUUnavailable ? `${e.message}。Chrome / Edge の最新版（WebGPU 対応）で開いてください。` : `初期化に失敗しました: ${e.message}`);
    throw e;
  }
  const { renderer, scene, camera, controls, sun, sunDir } = stage;
  renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
  // GPU が失われた（ドライバのリセット・タイムアウト等）ら止めて知らせる。放っておくと黒い画面のまま固まって見える
  renderer.onDeviceLost = (info) => {
    renderer.setAnimationLoop(null);
    fatal(`GPU との接続が失われました（${info?.message || info?.reason || '原因不明'}）。画質を「軽量」にして再読み込みしてください。繰り返す場合は GPU ドライバの更新や PC の再起動を試してください。`);
    store.set('quality', 'light');
  };

  const seaState = W.SEA_STATES.find((s) => s.id === settings.sea) ?? W.SEA_STATES[0];
  let waves = W.makeWaves(seaState.hs, seaState.tp);
  const sim = await createSim({ waves });

  // ---------- 船内の状態（扉・破口）と流体格子 ----------
  const gridState = { doors: Object.fromEntries(Lo.DOORS.filter((d) => d.wt).map((d) => [d.id, d.open])), seaOpenings: Object.fromEntries(Lo.SEA_OPENINGS.map((o) => [o.id, o.open])), breaches: [] };
  const fluid = createFluid(renderer, { dims: spec.dims, ppc: PPC, maxParticles: Q.max, stiffness });
  let built, roomNodes, carry = [];
  function rebuild() {
    built = buildShipGrid(h, gridState);
    fluid.setGrid(packForGpu(built.grid));
    roomNodes = F.roomNodes(built.grid, Lo.ROOMS.length);
    carry = built.openings.map(() => 0);
    for (let k = built.openings.length; k < MAX_OPENINGS; k++) fluid.setOpening(k, { mode: OPEN_CLOSED });
  }
  $('loadingMsg').textContent = '流体格子を作成中…';
  rebuild();

  // ---------- 描画物 ----------
  $('loadingMsg').textContent = '船を建造中…';
  const model = buildShipModel({ h, draft: 2.6 });
  scene.add(model.group);
  const ocean = createOcean(scene, { sunDir });
  ocean.setWaves(waves);
  model.group.add(ocean.section);
  const fluidView = createFluidRenderer(renderer, fluid, { h, origin: spec.origin, ppc: PPC });
  scene.add(fluidView.mainAnchor);
  const fx = createFx(scene, sim, model.group);
  const torpedo = createTorpedo(scene);
  const flash = new THREE.PointLight(0xffc987, 0, 80, 1.6);
  scene.add(flash);
  const pipeline = stage.createPipeline((color, viewZ, env) => fluidView.compositeNode(color, viewZ, env));
  const resize = () => fluidView.resize(innerWidth, innerHeight, renderer.getPixelRatio());
  resize();
  addEventListener('resize', resize);

  // ---------- 表示モード ----------
  let view = 'exterior', cutSide = 0, follow = true;
  const shipMats = model.materials;
  void shipMats;
  const setView = (v) => { view = v; model.cut.enabled = v === 'cutaway'; };
  setView('exterior');

  // ---------- 魚雷 ----------
  let run = null;
  const breachSize = () => [+$('breachW').value, +$('breachH').value];
  function launch(local, side) {
    if (run) return;
    const y = Math.min(Math.max(local[1], H.TANK_TOP + 0.4), H.deckY(local[2]) - 0.4);
    const z = Math.max(H.Z_MIN + 1.5, Math.min(H.Z_MAX - 2.5, local[2]));
    if (H.halfBreadth(z, y) <= 0.3) { toast('そこは狙えません（船体の端）', 'warn'); return; }
    const [w, hh] = breachSize();
    const b = breachAt(side * H.halfBreadth(z, y), y, z, w, hh);
    run = { b, w, hh };
    const target = new THREE.Vector3(...b.center).applyMatrix4(model.group.matrixWorld);
    const out = new THREE.Vector3(...b.normal).applyQuaternion(model.group.quaternion).setY(0).normalize();
    torpedo.position.copy(target).addScaledVector(out, 70);
    torpedo.position.y = Math.min(target.y, sim.sea(target.x, target.z) - 1.2);
    torpedo.visible = true;
    toast('魚雷発射', 'warn');
  }
  const tgt = new THREE.Vector3();
  function updateTorpedo(dt) {
    if (!run || dt <= 0) return;
    tgt.set(...run.b.center).applyMatrix4(model.group.matrixWorld);
    const d = tgt.distanceTo(torpedo.position), step = 26 * dt;
    torpedo.lookAt(tgt);
    if (d > step) {
      torpedo.position.addScaledVector(tgt.clone().sub(torpedo.position).normalize(), step);
      for (let n = 0; n < 6; n++) fx.emit(P.BUBBLE, torpedo.position.x + (Math.random() - 0.5) * 0.4, torpedo.position.y, torpedo.position.z + (Math.random() - 0.5) * 0.4, 0, 0.3, 0);
      return;
    }
    torpedo.visible = false;
    const { b, w, hh } = run;
    run = null;
    gridState.breaches.push(b);
    rebuild();
    model.addBreachDecal(b.center, b.normal, w, hh);
    const out = new THREE.Vector3(...b.normal).applyQuaternion(model.group.quaternion);
    fx.explosion(tgt, out);
    flash.position.copy(tgt).addScaledVector(out, 1.5);
    flash.intensity = 4000;
    const rooms = [...new Set(built.openings.filter((o) => o.kind === 'breach' && o.breach === gridState.breaches.length - 1).map((o) => Lo.ROOMS[o.room].name))];
    toast(`命中！ 破口 ${w.toFixed(1)}×${hh.toFixed(1)} m → ${rooms.join('・') || '（喫水線より上）'}`, 'danger');
    if (view !== 'cutaway') { setView('cutaway'); syncSeg('viewMode', 'cutaway'); }
  }

  // 船体クリックで狙う（ドラッグでの視点操作とは区別する）
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let downAt = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY, e.button]; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!downAt || downAt[2] !== 0 || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
    ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(model.hullMeshes)[0];
    if (!hit) return;
    const local = model.group.worldToLocal(hit.point.clone());
    launch([local.x, local.y, local.z], local.x >= 0 ? 1 : -1);
  });

  // ---------- UI ----------
  const setDoor = (id, open) => {
    const wt = Lo.DOORS.find((d) => d.id === id && d.wt);
    if (wt) gridState.doors[id] = open; else gridState.seaOpenings[id] = open;
    model.doors.get(id)?.set(open);
    rebuild();
    const name = wt ? wt.name : Lo.SEA_OPENINGS.find((o) => o.id === id).name;
    toast(`${name}: ${open ? '開放' : '閉鎖'}`, open ? 'warn' : '');
    renderToggles();
  };
  const isOpen = (id) => gridState.doors[id] ?? gridState.seaOpenings[id];
  function renderToggles() {
    const mk = (list, host) => {
      host.replaceChildren(...list.map((d) => {
        const b = document.createElement('div');
        b.className = 'toggle';
        const open = isOpen(d.id);
        b.innerHTML = `<span class="name">${d.name}</span><span class="chip ${open ? 'open' : 'closed'}">${open ? '開' : '閉'}</span>`;
        b.onclick = () => setDoor(d.id, !isOpen(d.id));
        return b;
      }));
    };
    mk(Lo.DOORS.filter((d) => d.wt), $('wtDoors'));
    mk(Lo.SEA_OPENINGS, $('seaOpenings'));
  }
  renderToggles();
  $('closeAll').onclick = () => {
    for (const id of Object.keys(gridState.doors)) { gridState.doors[id] = false; model.doors.get(id)?.set(false); }
    for (const id of Object.keys(gridState.seaOpenings)) { gridState.seaOpenings[id] = false; model.doors.get(id)?.set(false); }
    rebuild(); renderToggles(); toast('すべての水密扉・開口を閉鎖');
  };
  const profile = createProfile($('profile'), { onDoor: (id) => setDoor(id, !isOpen(id)) });
  const chart = createChart($('chart'), [{ color: '#ffb44c', min: -30, max: 30 }, { color: '#7ef0c6', min: -15, max: 15 }, { color: '#4cc3ff', min: 0 }]);

  const SCENARIOS = [
    { name: '第1船倉 右舷に被雷', note: '1 区画浸水。船首が沈むが浮き続けるはず', at: [-1, 1.8, 7.8], size: [1.6, 1.2] },
    { name: '隔壁をまたぐ被雷', note: '第2船倉と第1船倉の 2 区画に同時浸水', at: [1, 1.8, Lo.BULKHEADS[2]], size: [2.4, 1.4] },
    { name: '機関室に被雷', note: '最大の区画。D1 が開いていると居住区へ回る', at: [1, 1.6, -8.5], size: [1.8, 1.3] },
    { name: '船首 大破口', note: '船首区画と第1船倉。前のめりに沈む', at: [-1, 2.4, 11.2], size: [3.4, 1.8] },
  ];
  $('scenarios').replaceChildren(...SCENARIOS.map((s) => {
    const b = document.createElement('button');
    b.className = 'scenario';
    b.innerHTML = `<b>${s.name}</b><span>${s.note}</span>`;
    b.onclick = () => { $('breachW').value = s.size[0]; $('breachH').value = s.size[1]; syncRanges(); launch([s.at[0] * 3, s.at[1], s.at[2]], s.at[0]); };
    return b;
  }));
  const syncRanges = () => { $('breachWOut').textContent = `${(+$('breachW').value).toFixed(1)} m`; $('breachHOut').textContent = `${(+$('breachH').value).toFixed(1)} m`; };
  $('breachW').oninput = $('breachH').oninput = syncRanges;
  syncRanges();

  function syncSeg(id, v) { for (const b of $(id).querySelectorAll('button')) b.classList.toggle('on', Object.values(b.dataset)[0] === String(v)); }
  const onSeg = (id, fn) => $(id).addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; const v = Object.values(b.dataset)[0]; syncSeg(id, v); fn(v); });
  let speed = 1;
  onSeg('speed', (v) => { speed = +v; });
  onSeg('viewMode', setView);
  onSeg('waterMode', (v) => { fluidView.setMode(v); $('speedLegend').style.display = v === 'particles' ? '' : 'none'; });
  $('speedLegend').style.display = 'none';
  $('seaState').replaceChildren(...W.SEA_STATES.map((s) => { const b = document.createElement('button'); b.dataset.s = s.id; b.textContent = s.name; return b; }));
  syncSeg('seaState', seaState.id);
  onSeg('seaState', (v) => {
    const s = W.SEA_STATES.find((x) => x.id === v);
    waves = W.makeWaves(s.hs, s.tp);
    sim.waves = waves; ocean.setWaves(waves);
    store.set('sea', v);
    toast(`海況: ${s.name}（有義波高 ${s.hs} m）`);
  });
  $('quality').value = settings.quality;
  $('quality').onchange = () => { store.set('quality', $('quality').value); location.reload(); };
  $('follow').onchange = () => { follow = $('follow').checked; };
  $('reset').onclick = () => location.reload();
  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    for (const x of $('tabs').children) x.classList.toggle('on', x === b);
    for (const p of document.querySelectorAll('.pane')) p.classList.toggle('on', p.dataset.pane === b.dataset.tab);
  });
  $('helpBtn').onclick = () => $('help').classList.remove('hidden');
  $('helpClose').onclick = () => $('help').classList.add('hidden');
  const CAMS = {
    quarter: [30, 14, 26], side: [44, 3, 0], top: [0.5, 60, 0.5], under: [22, -9, 14], bow: [10, 7, 38],
  };
  let camTween = null;
  $('cams').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const off = new THREE.Vector3(...CAMS[b.dataset.cam]);
    camTween = { from: camera.position.clone(), to: controls.target.clone().add(off), t: 0 };
  });

  // ---------- ループの状態 ----------
  const clock = new THREE.Timer();
  let acc = 0, simTime = 0, uiTimer = 0, smokeDebt = 0, flows = [], lastInflow = 0;
  let fps = 60, lastStatus = '', fillPrev = new Array(Lo.ROOMS.length).fill(0), deckWet = false, grounded = false;
  const up = [0, 1, 0], upV = new THREE.Vector3();
  const levels = new Array(Lo.ROOMS.length).fill(-Infinity);
  const scratch = new Float32Array(Math.max(...roomNodes.map((a) => a.length / 3)) + 16);
  const camLocal = new THREE.Vector3(), tmp = new THREE.Vector3(), q = new THREE.Quaternion();
  const mp = RHO * particleVolume; // 粒子 1 個の質量 [kg]

  let lastFrameAt = 0;
  // forced: 検証用に実時間でなく決まった時間だけ進める
  function frame(now = performance.now(), forced = 0) {
    // 高リフレッシュレートの画面でも 60 fps を上限にする（GPU の負荷を必要以上に上げない）
    if (!forced && now - lastFrameAt < 1000 / 62) return;
    lastFrameAt = now;
    clock.update();
    const real = forced || Math.min(clock.getDelta(), 1 / 20);
    fps = fps * 0.95 + 0.05 / Math.max(real, 1e-4);
    // 流体のサブステップ数。上限を超えるならスロー再生にする（GPU を無理に回さない）
    let dt = real * speed;
    let nSub = Math.max(1, Math.ceil(dt / dtMax));
    const cap = Math.min(MAX_SUBSTEPS, Q.subCap * Math.max(1, speed));
    if (nSub > cap) { nSub = cap; dt = cap * dtMax; }
    if (speed === 0) dt = 0;

    // 1) 流体の集計 → 船の質量特性
    const st = fluid.stats;
    const wm = st ? waterMassProps(st.moments, st.center, spec, mp) : null;
    if (wm) sim.setWater(wm);

    // 2) 船の運動（固定刻み）
    acc += dt;
    while (acc >= DT) { sim.step(); acc -= DT; }
    simTime += dt;
    const t = sim.body.translation(), r = sim.body.rotation();
    model.group.position.set(t.x, t.y, t.z);
    model.group.quaternion.set(r.x, r.y, r.z, r.w);
    model.group.updateMatrixWorld(true);

    // 3) 部屋の水位と開口部の流量 → 粒子の生成
    const ff = sim.fluidFrame();
    upV.copy(ff.gravity).normalize().negate();
    up[0] = upV.x; up[1] = upV.y; up[2] = upV.z;
    const roomVol = st ? st.roomMass.slice(0, Lo.ROOMS.length).map((m) => m * particleVolume) : new Array(Lo.ROOMS.length).fill(0);
    const needLevel = new Set(built.openings.map((o) => o.room));
    for (const rm of needLevel) levels[rm] = F.waterLevel(roomNodes[rm], h, roomVol[rm], up, scratch);
    const spawns = [];
    let inflow = 0;
    flows = built.openings.map((o, k) => {
      const f = F.openingFlow(o, { toWorld: (p) => sim.toWorld(p), sea: sim.sea, up, level: levels[o.room] });
      const mode = f.mode === 'inflow' ? OPEN_INFLOW : f.mode === 'free' ? OPEN_FREE : OPEN_CLOSED;
      fluid.setOpening(k, openingParams(o, { ...f, mode }, spec));
      if (f.q > 0 && dt > 0) {
        const s = F.particlesFor(f.q, dt, particleVolume, carry[k]);
        carry[k] = s.carry;
        spawns.push({ opening: k, count: s.count });
        inflow += f.q;
      }
      return f;
    });
    lastInflow = lastInflow * 0.9 + inflow * 0.1;

    // 4) 流体を進める（船体座標の見かけの力）
    if (dt > 0) {
      fluid.uniforms.gravity.value.copy(ff.gravity).divideScalar(h);
      fluid.uniforms.omega.value.copy(ff.omega);
      fluid.uniforms.alpha.value.copy(ff.alpha);
      fluid.uniforms.origin.value.set(-spec.origin[0] / h, -spec.origin[1] / h, -spec.origin[2] / h);
      fluid.step(dt / nSub, nSub, spawns);
    }

    // 5) 描画の更新
    model.update(real);
    model.radar.rotation.y += dt * 2.5;
    model.prop.rotation.z += dt * (wm && wm.mass > 0 ? 0 : 3);
    updateTorpedo(dt);
    flash.intensity *= Math.exp(-10 * Math.max(dt, 1 / 240));
    fx.emitOpenings(dt, built.openings, flows, (p) => sim.toWorld(p));
    fx.emitWaterline(dt, sim.body.linvel().y);
    const ft = model.funnelTop.getWorldPosition(tmp);
    if (ft.y > sim.sea(ft.x, ft.z) + 0.5) for (smokeDebt += 14 * dt; smokeDebt >= 1; smokeDebt--) fx.emit(P.SMOKE, ft.x, ft.y, ft.z, 0, 1.2, 0, 0.8);
    const under = camera.position.y < sim.sea(camera.position.x, camera.position.z);
    fx.update(dt, { under });
    stage.setUnderwater(under);
    stage.time.value = simTime;

    // 断面: カメラ側（船体座標の x の符号）を切る
    camLocal.copy(camera.position);
    model.group.worldToLocal(camLocal);
    cutSide = view === 'cutaway' ? (camLocal.x >= 0 ? 1 : -1) : 0;
    if (cutSide) {
      const n = new THREE.Vector3(-cutSide, 0, 0).applyQuaternion(model.group.quaternion);
      model.cut.clippingPlanes[0].setFromNormalAndCoplanarPoint(n, model.group.position);
    }
    ocean.update(simTime, camera, model.group, cutSide);

    // 太陽の影は船の周りだけ高解像度に
    sun.target.position.copy(model.group.position);
    sun.position.copy(model.group.position).addScaledVector(sunDir, 70);
    // カメラ
    if (camTween) {
      camTween.t = Math.min(1, camTween.t + real * 1.6);
      const e = 1 - (1 - camTween.t) ** 3;
      camera.position.lerpVectors(camTween.from, camTween.to, e);
      if (camTween.t >= 1) camTween = null;
    }
    if (follow) {
      const c = sim.body.worldCom();
      tmp.set(c.x, c.y, c.z);
      const d = tmp.sub(controls.target).multiplyScalar(0.05);
      controls.target.add(d); camera.position.add(d);
    }
    controls.update();

    fluidView.render(camera, model.group.matrixWorld, { cutSide, sunDir });
    pipeline.render();

    uiTimer += real;
    if (uiTimer > 0.2) { uiTimer = 0; updateUi(st, wm, roomVol); }
  }

  function updateUi(st, wm, roomVol) {
    const s = sim.state();
    const mm = Math.floor(simTime / 60), ss = simTime - mm * 60;
    $('clock').textContent = `${String(mm).padStart(2, '0')}:${ss.toFixed(1).padStart(4, '0')}`;
    const water = wm ? wm.mass : 0;
    const reserve = Math.max(0, Math.min(1, (ENVELOPE_VOLUME * RHO - SHIP_MASS - water) / (ENVELOPE_VOLUME * RHO - SHIP_MASS)));
    $('mDraft').textContent = `${s.draft.toFixed(2)} m`;
    $('mTrim').textContent = `${s.pitchDeg >= 0 ? '船尾' : '船首'} ${Math.abs(s.pitchDeg).toFixed(1)}°`;
    $('mHeel').textContent = `${s.rollDeg >= 0 ? '右' : '左'} ${Math.abs(s.rollDeg).toFixed(1)}°`;
    $('mWater').textContent = `${(water / 1000).toFixed(1)} t`;
    $('mInflow').textContent = `${(lastInflow * 60).toFixed(1)} m³/分`;
    $('mReserve').textContent = `${Math.round(reserve * 100)} %`;
    $('mReserve').className = reserve < 0.25 ? 'danger' : reserve < 0.6 ? 'warn' : '';
    $('mHeel').className = Math.abs(s.rollDeg) > 15 ? 'danger' : Math.abs(s.rollDeg) > 5 ? 'warn' : '';
    $('reserveBar').style.width = `${reserve * 100}%`;
    $('perf').textContent = `${fps.toFixed(0)} fps ・ 水の粒子 ${(st?.alive ?? 0).toLocaleString()} / ${Q.max.toLocaleString()} ・ 格子 ${spec.dims.join('×')} (h=${h} m)`;
    chart.push(simTime, [s.rollDeg, s.pitchDeg, water / 1000]);
    chart.draw();

    // 状態の判定と通知
    const keel = new THREE.Vector3(0, 0, 0).applyMatrix4(model.group.matrixWorld);
    const onBottom = keel.y < SEABED_Y + 3 || s.y < SEABED_Y + 2;
    let status = 'ok', label = '航行中';
    if (onBottom) { status = 'warn'; label = '着底'; }
    else if (s.submerged > 0.97) { status = 'danger'; label = '沈没中'; }
    else if (reserve < 0.25 || Math.abs(s.rollDeg) > 15) { status = 'danger'; label = '危険'; }
    else if (water > 1000) { status = 'warn'; label = '浸水中'; }
    if (label !== lastStatus) {
      $('status').className = `badge ${status}`;
      $('status').textContent = label;
      if (lastStatus && label === '沈没中') toast('船体が完全に海面下へ — 沈没', 'danger');
      if (lastStatus && label === '着底') toast(`海底（水深 ${-SEABED_Y} m）に着底`, 'warn');
      lastStatus = label;
    }
    if (onBottom && !grounded) grounded = true;
    // 上甲板の端が海面下に入ったか
    let wet = false;
    for (const z of [H.Z_MIN + 0.5, 0, H.Z_MAX - 1]) for (const sgn of [1, -1]) {
      const p = sim.toWorld([sgn * H.halfBreadth(z, H.deckY(z) - 0.05), H.deckY(z), z]);
      if (p[1] < sim.sea(p[0], p[2])) wet = true;
    }
    if (wet && !deckWet) toast('上甲板の端が海面下に — 甲板の開口から浸水が始まる', 'danger');
    deckWet = wet;

    const fills = roomVol.map((v, i) => v / built.capacity[i]);
    fills.forEach((f, i) => {
      if (fillPrev[i] < 0.02 && f >= 0.02) toast(`${Lo.ROOMS[i].name} に浸水`, 'warn');
      if (fillPrev[i] < 0.95 && f >= 0.95) toast(`${Lo.ROOMS[i].name} が満水`, 'danger');
    });
    fillPrev = fills;
    // 側面図の喫水線（船首・船尾の位置で、海面の高さを船体座標の y に直す）
    q.copy(model.group.quaternion);
    const e = new THREE.Matrix4().makeRotationFromQuaternion(q).elements; // 列優先
    const wlY = (z) => { const w = sim.toWorld([0, 0, z]); return (sim.sea(w[0], w[2]) - model.group.position.y - e[9] * z) / e[5]; };
    const hot = flows.map(() => false);
    const hotRooms = new Array(Lo.ROOMS.length).fill(false);
    built.openings.forEach((o, k) => { if (flows[k]?.mode === 'inflow') hotRooms[o.room] = true; });
    void hot;
    profile.update({
      fills, hot: hotRooms, waterline: [wlY(H.Z_MIN - 0.8), wlY(H.Z_MAX + 0.8)],
      doorStates: { ...gridState.doors, ...gridState.seaOpenings }, breaches: gridState.breaches,
    });
  }

  // 検証用（ブラウザのコンソールから、描画を待たずに進める）
  window.__app = {
    sim, fluid, model, gridState, launch, setDoor,
    advance: async (n = 60) => { for (let i = 0; i < n; i++) { frame(performance.now(), 1 / 60); await renderer.backend.device.queue.onSubmittedWorkDone(); } return sim.state(); },
    get flows() { return flows; }, get openings() { return built.openings; },
  };

  $('loading').classList.add('hidden');
  renderer.setAnimationLoop(frame);
}

main().catch((e) => { console.error(e); if ($('fatal').classList.contains('hidden')) fatal(`エラー: ${e.message}`); });
