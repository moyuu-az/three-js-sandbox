// アプリ本体: 船の運動（CPU・Rapier）と船内の水（GPU・MLS-MPM）をつなぎ、描画と UI を回す。
//
// 1 フレームの流れ:
//   GPU 流体の集計（水の質量・重心・慣性、部屋ごとの水量）→ 船の剛体に合成 → 船の運動を固定刻みで進める
//   → 部屋の水位と開口部の内外水頭差から流量を求め、開口部に粒子を生成 → 船の加速度・回転を見かけの力として流体を進める → 描画
import * as THREE from 'three/webgpu';
import { createStage, WebGPUUnavailable } from './render/stage.js';
import { createSim, SEABED_Y, RHO, ENVELOPE_VOLUME, SHIP_MASS, DT, DESIGN_DRAFT } from './sim.js';
import { buildShipGrid, breachAt, ruptureAt, gridSpec } from './shipgrid.js';
import * as A from './air.js';
import { packForGpu, MAX_OPENINGS } from './voxel.js';
import { createFluid, fluidParams, OPEN_FREE, OPEN_INFLOW, OPEN_CLOSED } from './gpu/fluid.js';
import * as F from './flooding.js';
import { waterMassProps, openingParams } from './coupling.js';
import * as W from './waves.js';
import * as Lo from './layout.js';
import * as H from './hull.js';
import { buildShipModel } from './render/shipModel.js';
import { createOcean } from './render/ocean.js';
import { createFluidRenderer } from './render/fluidRender.js';
import { createFx, createTorpedo, P } from './render/fx.js';
import { createProfile, WL_Z } from './ui/profile.js';
import { createChart } from './ui/chart.js';
import { nextFrameAt } from './frameCap.js';
import { flyDelta, MOVE_KEYS } from './cameraKeys.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

// 画質: 格子間隔 h と粒子の上限。剛性と安定な時間刻みは h から fluidParams（gpu/fluid.js、圧縮率の SSOT）で決まる
// 全長 130 m の艦を実寸で解くので、前の 30 m の船（h = 0.3 m）より粗い。粒子の上限は艦内の容積 ~5,200 m³ の 9 割以上が入る数
// （満水に要る粒子数に対して 軽量 1.22 倍 / 標準 1.18 倍 / 高精細 0.94 倍）
const QUALITY = {
  light: { h: 0.6, max: 229376, subCap: 4 },
  standard: { h: 0.5, max: 393216, subCap: 5 },
  high: { h: 0.42, max: 524288, subCap: 6 },
};
const PPC = 8; // 1 セルあたりの粒子数（静止時）
const BOTTOM_PROBES = [[0, 0, 0], [0, H.keelY(H.Z_MAX), H.Z_MAX], [0, H.keelY(H.Z_MIN), H.Z_MIN], [0, H.deckY(H.Z_MAX), H.Z_MAX], [0, H.deckY(H.Z_MIN), H.Z_MIN], [H.B / 2, H.D, 0], [-H.B / 2, H.D, 0], [0, H.deckY(H.FC_Z) + 12, 28]];
const MAX_SUBSTEPS = 10; // 1 フレームの流体サブステップの上限（GPU の負荷の上限。超えるとスロー再生になる）
const MAX_RUPTURES = 8; // 破断の数の上限（開口は格子に MAX_OPENINGS = 32 個まで。常設の開口 11 と魚雷の破口の分を残す）

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
  const { stiffness, dtMax } = fluidParams(h, PPC, { depth: H.D }); // 剛性と、その音速で安定な時間刻み。艦内の水の深さ（上甲板まで）で縮みを 12% に抑える

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
  const NR = Lo.ROOMS.length;
  let built, roomNodes, carry = [];
  // 空気: 部屋のつながり（扉の開閉で変わる）、外板の点と強度（閉じた開口が弱点）、部屋の中心（近くの海面の高さを見る点）
  const airCfg = { enabled: true, scale: 1 };
  let links, env, roomCenters;
  function rebuildEnvelope() {
    const closed = Lo.SEA_OPENINGS.filter((o) => !gridState.seaOpenings[o.id]);
    env = A.envelopePoints(built.grid, NR, A.strengthOf(closed, airCfg.scale));
  }
  function rebuild() {
    built = buildShipGrid(h, gridState);
    fluid.setGrid(packForGpu(built.grid));
    roomNodes = F.roomNodes(built.grid, NR);
    carry = built.openings.map(() => 0);
    for (let k = built.openings.length; k < MAX_OPENINGS; k++) fluid.setOpening(k, { mode: OPEN_CLOSED });
    links = A.roomLinks(built.grid, NR);
    rebuildEnvelope();
    roomCenters = roomNodes.map((a) => { const c = [0, 0, 0]; for (let i = 0; i < a.length; i += 3) for (let d = 0; d < 3; d++) c[d] += a[i + d]; return c.map((v) => v / Math.max(1, a.length / 3)); });
  }
  $('loadingMsg').textContent = '流体格子を作成中…';
  rebuild();
  const air = A.createAir(built.capacity); // 最初はどの部屋も 1 気圧

  // ---------- 描画物 ----------
  $('loadingMsg').textContent = '船を建造中…';
  const model = buildShipModel({ h, draft: DESIGN_DRAFT });
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
  // exterior: 外観 / xray: 透視（カメラの側の外殻だけ透かす）/ cutaway: 断面（中心線で縦に切る）
  let view = 'exterior', cutSide = 0, follow = true, peel = 'none';
  // 甲板を外す高さ（船体座標の y）。上甲板 = 居住区・缶室の天井の下（船首楼も一緒に外れる）、下甲板 = 弾薬庫・倉庫の天井の下。
  // 上部構造（艦橋・煙突・砲・発射管）は面で切らずに隠す（露天甲板の高さが船首楼の段で 2.4 m 違い、1 枚の面では切りそろえられない）
  const PEEL = { none: 1e3, house: 1e3, deck: H.D - 0.35, deck2: Lo.LOWER - 0.12 };
  model.cut.clippingPlanes = [new THREE.Plane(), new THREE.Plane()]; // [断面, 甲板を外す]。使わない面は遠くに置く（数を変えると材質を作り直す）
  const setView = (v) => {
    view = v;
    model.cut.enabled = v !== 'exterior';
    model.setXray(v === 'xray');
    model.setTopside(v === 'exterior' || peel === 'none');
    syncSeg('viewMode', v);
  };

  // 部屋のラベル（名前・浸水率・空気圧）。DOM で重ねる（文字がくっきりし、GPU の負荷にならない）
  const labelRenderer = new CSS2DRenderer();
  labelRenderer.setSize(innerWidth, innerHeight);
  labelRenderer.domElement.className = 'labels';
  labelRenderer.domElement.setAttribute('aria-hidden', 'true'); // 同じ情報は区画図にある（13 個を読み上げさせない）
  $('app').append(labelRenderer.domElement);
  addEventListener('resize', () => labelRenderer.setSize(innerWidth, innerHeight));
  const labels = Lo.ROOMS.map((r, i) => {
    const div = document.createElement('div');
    div.className = 'rlabel';
    div.innerHTML = '<b></b><span></span>';
    div.firstChild.textContent = r.name;
    const o = new CSS2DObject(div);
    o.position.set(...roomCenters[i]);
    model.group.add(o);
    return { o, div, stat: div.lastChild, i };
  });
  let labelsOn = true;
  function updateLabels(peelY) {
    for (const l of labels) {
      const c = l.o.position.set(...roomCenters[l.i]); // 扉の開閉・破断で格子を作り直すと部屋の中心が変わる
      // 断面で切り取った側・外した甲板より上の部屋は出さない
      l.o.visible = labelsOn && view !== 'exterior' && !(cutSide && c.x * cutSide > 0.8) && c.y < peelY;
    }
  }
  function updateLabelText(fills) {
    for (const l of labels) {
      const f = Math.min(1, fills[l.i] ?? 0), g = gauge[l.i] / 1e5;
      l.stat.textContent = `${Math.round(f * 100)}%${Math.abs(g) >= 0.05 ? ` ・ ${g > 0 ? '+' : '−'}${Math.abs(g).toFixed(2)} bar` : ''}`;
      l.div.classList.toggle('wet', f > 0.02);
      l.div.classList.toggle('pressed', g >= 0.05);
    }
  }

  // W A S D / Q E でカメラを動かす（入力欄にフォーカスがあるときは使わない）。動かしたら船の追従は切る
  const keysDown = new Set();
  let shiftDown = false;
  const fwd = new THREE.Vector3(), tmp2 = new THREE.Vector3();
  const typing = (e) => /^(INPUT|SELECT|TEXTAREA)$/.test(e.target?.tagName ?? '') || e.ctrlKey || e.metaKey || e.altKey;
  addEventListener('keydown', (e) => {
    shiftDown = e.shiftKey;
    if (typing(e) || !MOVE_KEYS[e.code]) return;
    e.preventDefault();
    keysDown.add(e.code);
    camTween = null;
    if (follow) { follow = false; $('follow').checked = false; }
  });
  addEventListener('keyup', (e) => { shiftDown = e.shiftKey; keysDown.delete(e.code); });
  addEventListener('blur', () => { keysDown.clear(); shiftDown = false; });

  // ---------- 魚雷 ----------
  let run = null;
  // 続けて撃つ魚雷（シナリオの 2 本目以降）。前の 1 本が命中してから SALVO_GAP 秒おきに撃つ
  const salvo = [], SALVO_GAP = 2.5;
  let salvoAt = 0;
  const breachSize = () => [+$('breachW').value, +$('breachH').value];
  // 開口の上限で撃てない・入りきらないとき。続きの魚雷（salvo）も同じ理由で入らないので止める（残すと 1 フレームごとに断って通知が並ぶ）
  const refuseFull = () => { salvo.length = 0; toast(`破口が多すぎて、これ以上は計算できません（開口の上限 ${MAX_OPENINGS}）`, 'warn'); };
  function launch(local, side, [w, hh] = breachSize()) {
    if (run) { toast('魚雷が航走中です。命中してから撃ってください', 'warn'); return; }
    // 開口は格子に MAX_OPENINGS 個まで。埋まっていれば撃たない（命中しても破口を格子に入れられない）
    if (built.openings.length >= MAX_OPENINGS) { refuseFull(); return; }
    const y = Math.min(Math.max(local[1], H.TANK_TOP + 0.4), H.deckY(local[2]) - 0.4);
    const z = Math.max(H.Z_MIN + 1.5, Math.min(H.Z_MAX - 2.5, local[2]));
    if (H.halfBreadth(z, y) <= 0.3) { toast('そこは狙えません（船体の端）', 'warn'); return; }
    const b = breachAt(side * H.halfBreadth(z, y), y, z, w, hh);
    run = { b, w, hh };
    const target = new THREE.Vector3(...b.center).applyMatrix4(model.group.matrixWorld);
    const out = new THREE.Vector3(...b.normal).applyQuaternion(model.group.quaternion).setY(0).normalize();
    torpedo.position.copy(target).addScaledVector(out, 140);
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
    salvoAt = simTime + SALVO_GAP;
    const droppedBefore = built.dropped;
    gridState.breaches.push(b);
    rebuild();
    if (built.dropped > droppedBefore) {
      // 破口が部屋をまたいで片に分かれ、上限に入りきらなかった: 黙って一部だけ開けず、取り消して知らせる（rupture と同じ扱い）
      gridState.breaches.pop();
      rebuild();
      refuseFull();
      return;
    }
    model.addBreachDecal(b.center, b.normal, w, hh);
    const out = new THREE.Vector3(...b.normal).applyQuaternion(model.group.quaternion);
    fx.explosion(tgt, out);
    flash.position.copy(tgt).addScaledVector(out, 1.5);
    flash.intensity = 4000;
    const rooms = [...new Set(built.openings.filter((o) => o.kind === 'breach' && o.breach === gridState.breaches.length - 1).map((o) => Lo.ROOMS[o.room].name))];
    toast(`命中！ 破口 ${w.toFixed(1)}×${hh.toFixed(1)} m → ${rooms.join('・') || '（喫水線より上）'}`, 'danger');
    if (view === 'exterior') setView('xray'); // 命中したら船内が見える表示へ
  }

  // ---------- 空気圧・水圧による破断 ----------
  const KIND_NAME = { hull: '外板', deck: '甲板' };
  // 開口は格子に MAX_OPENINGS 個まで。入りきらない穴は開けない（戻り値 false）: 格子に入らない穴を「破れた」ことにすると
  // 圧力が抜けずに同じ場所で破断を繰り返し、閉じた開口を開けると（破口より先に格子に入るので）魚雷の破口が黙って格子から消える
  function rupture(w) {
    if (built.openings.length >= MAX_OPENINGS) return false;
    const pt = A.envelopePoint(env, w.i);
    const outward = w.dp > 0, bar = Math.abs(w.dp) / 1e5;
    const room = Lo.ROOMS[pt.room];
    const droppedBefore = built.dropped;
    let b = null;
    if (pt.closure) gridState.seaOpenings[pt.closure] = true; // 閉じた開口の蓋・扉は締め付け金具が外れて開く
    else {
      b = ruptureAt(pt.p, pt.n, 0.8, { kind: 'rupture', name: `${outward ? '破裂' : '圧潰'}（${room.name}）` });
      gridState.breaches.push(b);
    }
    rebuild();
    if (built.dropped > droppedBefore) {
      // 部屋をまたいで片が増え、入りきらなかった: 元に戻す（格子の作り直しが 2 回になるので、しばらく試し直さない）
      if (b) gridState.breaches.pop(); else gridState.seaOpenings[pt.closure] = false;
      rebuild();
      ruptureReadyAt = simTime + 1.5;
      return false;
    }
    let where;
    if (b) {
      model.addBreachDecal(b.center, b.normal, 0.8, 0.8);
      where = `${room.name}の${KIND_NAME[A.surfaceKind(pt.room, pt.n)]}`;
    } else {
      model.doors.get(pt.closure)?.set(true);
      renderToggles();
      where = Lo.SEA_OPENINGS.find((o) => o.id === pt.closure).name;
    }
    ruptures++;
    ruptureReadyAt = simTime + 1.5; // 同じ圧力で続けて破れないよう、開いた穴で圧力が抜けるのを待つ
    const wp = new THREE.Vector3(...pt.p).applyMatrix4(model.group.matrixWorld);
    const nW = new THREE.Vector3(...pt.n).applyQuaternion(model.group.quaternion);
    fx.burst(wp, nW, { outward, submerged: wp.y < sim.sea(wp.x, wp.z), size: Math.min(3, 0.6 + bar * 2) });
    toast(`${where}が${outward ? '中の空気圧で破裂' : '外の水圧で圧潰'}（内外の圧力差 ${bar.toFixed(2)} bar）`, 'danger');
    return true;
  }

  // 船体クリックで狙う（ドラッグでの視点操作とは区別する）
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let downAt = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY, e.button]; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!downAt || downAt[2] !== 0 || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
    ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    // raycast はクリッピングを見ない。断面表示では切り取った手前側（船体座標で x·cutSide > 0）の外板は見えないので飛ばす
    // 透視でも同じ: 透かしている外板（船外向きの面がカメラを向く）と、外した甲板より上は飛ばして、その奥（見えている外板の内側）を狙う
    const peelY = view !== 'exterior' ? PEEL[peel] : 1e3;
    const local = ray.intersectObjects(model.hullMeshes).map((hit) => {
      const p = model.group.worldToLocal(hit.point.clone());
      return model.isGhost(hit, p) || p.y > peelY || (cutSide && p.x * cutSide > 0.01) ? null : p;
    }).find((p) => p);
    if (!local) return;
    if (salvo.length) { toast('シナリオの魚雷を撃ち終えるまで待ってください', 'warn'); return; }
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

  // 破口の大きさは九三式・Mk 14 級の魚雷の弾頭（300〜500 kg）が駆逐艦の外板に開ける穴の目安（幅 5〜8 m）
  const K = Lo.BULKHEADS;
  // hits: 撃ち込む魚雷（at = [舷 ±1, 高さ, z]、size = 破口の幅・高さ）。2 本目以降は前の命中から SALVO_GAP 秒おき
  const SCENARIOS = [
    { name: '第1缶室に被雷（右舷）', note: '1 区画浸水。缶室は最大級の区画だが、前後の水密隔壁で止まり浮き続ける', hits: [{ at: [-1, 2.0, 16.5], size: [5.0, 3.0] }] },
    { name: '缶室の隔壁をまたぐ被雷', note: '第1・第2缶室の 2 区画に同時浸水。駆逐艦の設計の目安（隣り合う 2 区画）でも沈まない', hits: [{ at: [1, 2.0, K[5]], size: [7.0, 3.5] }] },
    { name: '機械室に被雷', note: '前部・後部機械室の間の隔壁（強化で追加）に当たる。実艦の共通の機械室なら 1 区画の大浸水', hits: [{ at: [-1, 1.8, K[8]], size: [6.0, 3.2] }] },
    { name: '艦首に被雷', note: '弾薬庫と兵員室に浸水。区画に閉じ込められた空気が縮んで流入を押し返す（エアクッション）', hits: [{ at: [1, 2.6, 46], size: [6.0, 3.5] }] },
    { name: '後部弾薬庫に被雷', note: '弾薬庫と士官室（下甲板の揚弾口でつながる）に浸水。艦尾が沈む', hits: [{ at: [-1, 2.8, -43], size: [5.5, 3.0] }] },
    // 後部を閉じ切ると、沈む艦の後部に空気が閉じ込められる。深くなると閉じたハッチが水圧で押し破られ、流れ込む水に押された空気が
    // 縮んで圧力が上がる（空気圧・破断の観察用）
    {
      name: '4 本被雷で撃沈（後部を密閉）', note: '機関区画と艦尾に 4 本。1〜2 本では沈まない艦も、6 区画以上に浸水すると艦尾から沈む。閉じた後部の区画の空気が縮み、ハッチが水圧で破れる',
      hits: [{ at: [1, 2.0, K[5]], size: [7.0, 3.5] }, { at: [-1, 2.0, K[7]], size: [7.0, 3.5] }, { at: [1, 2.0, K[9]], size: [7.0, 3.5] }, { at: [-1, 2.8, K[11]], size: [7.0, 3.5] }],
      close: ['o9', 'o10'],
    },
  ];
  $('scenarios').replaceChildren(...SCENARIOS.map((s) => {
    const b = document.createElement('button');
    b.className = 'scenario';
    b.append(Object.assign(document.createElement('b'), { textContent: s.name }), Object.assign(document.createElement('span'), { textContent: s.note }));
    b.onclick = () => {
      // 魚雷が走っている間・続きの魚雷が残っている間は扉も変えない（launch と同じ条件）。黙って無視すると押せていないように見える
      // 続きの魚雷を待つ間（run は null）は「航走中」ではなく、1 本命中しても次が撃たれるので、salvo を先に見る
      if (run || salvo.length) { toast(salvo.length ? 'シナリオの魚雷を撃ち終えるまで待ってください' : '魚雷が航走中です。シナリオは命中してから始めてください', 'warn'); return; }
      const toClose = (s.close ?? []).filter((id) => isOpen(id));
      if (toClose.length) {
        // まとめて閉じる（1 枚ずつ setDoor すると格子の作り直しと通知が枚数分起きる）
        for (const id of toClose) {
          if (id in gridState.doors) gridState.doors[id] = false; else gridState.seaOpenings[id] = false;
          model.doors.get(id)?.set(false);
        }
        rebuild(); renderToggles();
        toast(`閉鎖: ${toClose.map((id) => (Lo.DOORS.find((d) => d.id === id) ?? Lo.SEA_OPENINGS.find((o) => o.id === id)).name).join('・')}`);
      }
      const [first, ...rest] = s.hits;
      $('breachW').value = first.size[0]; $('breachH').value = first.size[1]; syncRanges();
      fire(first);
      if (run) salvo.push(...rest); // 1 本目を断られた（開口の上限）なら続きも撃たない
    };
    return b;
  }));
  // 舷の外（半幅 × 3 の点）から狙う。launch が舷側の点に直す
  const fire = (hit) => launch([hit.at[0] * 3, hit.at[1], hit.at[2]], hit.at[0], hit.size);
  const syncRanges = () => { $('breachWOut').textContent = `${(+$('breachW').value).toFixed(1)} m`; $('breachHOut').textContent = `${(+$('breachH').value).toFixed(1)} m`; };
  $('breachW').oninput = $('breachH').oninput = syncRanges;
  syncRanges();

  function syncSeg(id, v) { for (const b of $(id).querySelectorAll('button')) b.classList.toggle('on', Object.values(b.dataset)[0] === String(v)); }
  const onSeg = (id, fn) => $(id).addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; const v = Object.values(b.dataset)[0]; syncSeg(id, v); fn(v); });
  let speed = 1;
  onSeg('speed', (v) => { speed = +v; });
  onSeg('viewMode', setView);
  onSeg('peel', (v) => { peel = v; model.setTopside(view === 'exterior' || v === 'none'); });
  $('labelsOn').onchange = () => { labelsOn = $('labelsOn').checked; };
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
  $('ruptureOn').onchange = () => { airCfg.enabled = $('ruptureOn').checked; };
  $('strength').oninput = () => {
    airCfg.scale = +$('strength').value;
    $('strengthOut').textContent = `×${airCfg.scale.toFixed(1)}`;
    rebuildEnvelope();
  };
  $('reset').onclick = () => location.reload();
  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    for (const x of $('tabs').children) x.classList.toggle('on', x === b);
    for (const p of document.querySelectorAll('.pane')) p.classList.toggle('on', p.dataset.pane === b.dataset.tab);
  });
  $('helpBtn').onclick = () => $('help').classList.remove('hidden');
  $('helpClose').onclick = () => $('help').classList.add('hidden');
  const CAMS = {
    quarter: [95, 38, 85], side: [150, 8, 0], top: [0.5, 190, 0.5], under: [70, -24, 40], bow: [28, 16, 118],
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
  let frameSec = 1 / 60, lastStatus = '', fillNotified = [], deckWet = false, grounded = false;
  const up = [0, 1, 0], upV = new THREE.Vector3();
  const levels = new Array(Lo.ROOMS.length).fill(-Infinity);
  const gauge = new Array(NR).fill(0), heads = new Array(NR).fill(0); // 部屋の空気のゲージ圧 [Pa] と水頭 [m]
  let airFlows = [], worst = null, ruptures = 0, ruptureReadyAt = 0, overSince = null;
  const scratch = new Float32Array(Math.max(...roomNodes.map((a) => a.length / 3)) + 16);
  const camLocal = new THREE.Vector3(), tmp = new THREE.Vector3(), q = new THREE.Quaternion(), shipInv = new THREE.Matrix4();
  const mp = RHO * particleVolume; // 粒子 1 個の質量 [kg]

  let lastFrameAt = 0;
  // forced: 検証用に実時間でなく決まった時間だけ進める
  function frame(now = performance.now(), forced = 0) {
    // 高リフレッシュレートの画面でも 60 fps を上限にする（GPU の負荷を必要以上に上げない）。
    // forced では予定時刻を進めない（advance(600) のように連続で呼ぶと、予定時刻が実時間より先へ行って rAF の描画が止まる）
    if (!forced) {
      const next = nextFrameAt(lastFrameAt, now);
      if (next === null) return;
      lastFrameAt = next;
    }
    clock.update();
    const real = forced || Math.min(clock.getDelta(), 1 / 20);
    // 間隔の平均の逆数で表示する（1/Δt を平均すると、間引きで間隔が揺れる画面では実際より高く出る）
    frameSec = frameSec * 0.95 + 0.05 * real;
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
    // 部屋の水の体積は、粒子ごとの密度で割った実際の体積（弱圧縮で縮んだ分を数えない。満水近くのエアポケットを正しく残す）
    const roomVol = st ? st.roomVolume.slice(0, NR).map((v) => v * particleVolume) : new Array(NR).fill(0);
    // 水位は全部の部屋で要る（空気の体積・部屋どうしの空気のつながり・外板の荷重）。空の部屋は計算しない
    for (let rm = 0; rm < NR; rm++) levels[rm] = roomVol[rm] > 0 ? F.waterLevel(roomNodes[rm], h, roomVol[rm], up, scratch) : -Infinity;

    // 3a) 空気: 水に押されて縮み（ボイル）、開口の水面より上の部分から出入りする
    const vAir = A.airVolumes(built.capacity, roomVol, levels);
    const groupOf = A.airGroups(NR, links, levels, up);
    const ops = built.openings; // この後の破断・魚雷で作り直されても、このフレームの流量と添字をそろえる
    // 空気を押し縮められる上限 = 入ってくる水の圧力（開口の最も深い点）。少し余裕を持たせる（波・動的な押し込み）
    let deepest = 0;
    for (const o of ops) for (const p of o.samples) { const w = sim.toWorld(p); deepest = Math.max(deepest, sim.sea(w[0], w[2]) - w[1]); }
    const pMax = 1 + (RHO * 9.81 * deepest) / A.P_ATM + 0.05;
    A.equalize(air, groupOf, vAir, pMax);
    const vents = ops.map((o) => ({
      room: o.room,
      samples: o.samples.filter((p) => up[0] * p[0] + up[1] * p[1] + up[2] * p[2] > levels[o.room]).map((p) => {
        const w = sim.toWorld(p);
        return { area: o.area / o.samples.length, depth: Math.max(0, sim.sea(w[0], w[2]) - w[1]) };
      }),
    }));
    airFlows = A.exchange(air, groupOf, vAir, vents, dt);
    A.equalize(air, groupOf, vAir, pMax);
    for (let rm = 0; rm < NR; rm++) { gauge[rm] = (air.pressure[rm] - 1) * A.P_ATM; heads[rm] = A.headOf(gauge[rm]); }
    fluid.setRoomHeads(heads, h);

    const spawns = [];
    let inflow = 0;
    flows = ops.map((o, k) => {
      const f = F.openingFlow(o, { toWorld: (p) => sim.toWorld(p), sea: sim.sea, up, level: levels[o.room], airHead: heads[o.room] });
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

    // 3b) 外板の荷重: 内外の圧力差が強度を超えた点を破る（閉じた開口なら蓋が外れて開く）
    worst = A.worstLoad(env, {
      m: model.group.matrixWorld.elements, up, levels, gauge,
      seaY: (rm) => { tmp.set(...roomCenters[rm]).applyMatrix4(model.group.matrixWorld); return sim.sea(tmp.x, tmp.z); },
    });

    // 4) 流体を進める（船体座標の見かけの力）
    if (dt > 0) {
      fluid.uniforms.gravity.value.copy(ff.gravity).divideScalar(h);
      fluid.uniforms.omega.value.copy(ff.omega);
      fluid.uniforms.alpha.value.copy(ff.alpha);
      fluid.uniforms.origin.value.set(-spec.origin[0] / h, -spec.origin[1] / h, -spec.origin[2] / h);
      fluid.step(dt / nSub, nSub, spawns);
    }
    // 破断は流体を進めた後（格子を作り直すと開口の番号が変わり、このフレームの生成数と合わなくなる）
    // 強度を 0.3 s 続けて超えたら破る（水位の見積もりの一瞬の揺れでは破らない）
    if (!(worst && worst.ratio > 1)) overSince = null;
    else if (dt > 0 && overSince === null) overSince = simTime;
    if (dt > 0 && airCfg.enabled && overSince !== null && simTime - overSince >= 0.3 && simTime > ruptureReadyAt && ruptures < MAX_RUPTURES) {
      rupture(worst);
      overSince = null;
    }

    // 5) 描画の更新
    model.update(real, wm && wm.mass > 0 ? 0 : 3 * speed); // 浸水したら機関を止める。回転は再生速度に合わせる（update は実時間で進む）
    updateTorpedo(dt);
    if (!run && salvo.length && simTime >= salvoAt && dt > 0) fire(salvo.shift());
    flash.intensity *= Math.exp(-10 * Math.max(dt, 1 / 240));
    fx.emitOpenings(dt, ops, flows, (p) => sim.toWorld(p));
    fx.emitAir(dt, ops, airFlows, (p) => sim.toWorld(p));
    fx.emitWaterline(dt, sim.body.linvel().y);
    // 煙突は上部構造（top）の一部。「上部構造」を隠している間は煙も出さない（宙から煙が出て見える）
    for (smokeDebt += 14 * dt; smokeDebt >= 1; smokeDebt--) if (model.top.visible) for (const f of model.funnelTops) {
      const ft = f.getWorldPosition(tmp);
      if (ft.y > sim.sea(ft.x, ft.z) + 0.5) fx.emit(P.SMOKE, ft.x, ft.y, ft.z, 0, 1.2, 0, 1.6);
    }

    // カメラ（切り取り・透視の判定より先に動かす。後にすると判定が 1 フレーム遅れて、回り込むと手前の壁がちらつく）
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
    if (keysDown.size) {
      camera.getWorldDirection(fwd);
      const scrUp = tmp2.set(0, 1, 0).applyQuaternion(camera.quaternion); // 画面の上（真下を見ているときの「前」）
      const d = flyDelta(keysDown, [fwd.x, fwd.y, fwd.z], camera.position.distanceTo(controls.target), real, { fast: shiftDown, fallback: [scrUp.x, scrUp.y, scrUp.z] });
      tmp.set(...d);
      camera.position.add(tmp); controls.target.add(tmp);
    }
    controls.update();
    camera.updateMatrixWorld();

    // 切り取り: 断面は船の中心線（カメラ側の半分）、透視はカメラの側の外殻だけを透かす。どちらも甲板を外す高さより上は切る
    camLocal.copy(camera.position);
    model.group.worldToLocal(camLocal);
    model.setViewer(camLocal);
    cutSide = view === 'cutaway' ? (camLocal.x >= 0 ? 1 : -1) : 0;
    const [secPlane, peelPlane] = model.cut.clippingPlanes;
    if (cutSide) secPlane.setFromNormalAndCoplanarPoint(tmp.set(-cutSide, 0, 0).applyQuaternion(model.group.quaternion), model.group.position);
    else secPlane.set(tmp.set(1, 0, 0), 1e5); // 切らない（全部が表側）
    const peelY = view !== 'exterior' ? PEEL[peel] : 1e3;
    if (peelY < 1e3) peelPlane.setFromNormalAndCoplanarPoint(tmp.set(0, -1, 0).applyQuaternion(model.group.quaternion), tmp2.set(0, peelY, 0).applyMatrix4(model.group.matrixWorld));
    else peelPlane.set(tmp.set(1, 0, 0), 1e5);
    // 手前の海を切る向き（船体座標の水平）: 断面は船の横、透視はカメラの方位
    let cutDir = null;
    if (cutSide) cutDir = [cutSide, 0];
    else if (view === 'xray') { const l = Math.hypot(camLocal.x, camLocal.z); if (l > 1e-3) cutDir = [camLocal.x / l, camLocal.z / l]; }
    ocean.update(simTime, camera, model.group, cutDir);

    const under = camera.position.y < sim.sea(camera.position.x, camera.position.z);
    fx.update(dt, { under, cut: cutDir ? { dir: cutDir, inv: shipInv.copy(model.group.matrixWorld).invert(), x: ocean.cutBox.x, z: ocean.cutBox.z } : null });
    stage.setUnderwater(under);
    stage.time.value = simTime;

    // 太陽の影は船の周りだけ高解像度に
    sun.target.position.copy(model.group.position);
    sun.position.copy(model.group.position).addScaledVector(sunDir, 160);

    updateLabels(peelY);
    fluidView.render(camera, model.group.matrixWorld, { cutSide, peelY, sunDir, under });
    pipeline.render();
    labelRenderer.render(scene, camera);

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
    let pr = 0;
    for (let rm = 1; rm < NR; rm++) if (Math.abs(gauge[rm]) > Math.abs(gauge[pr])) pr = rm;
    $('mAir').textContent = `${gauge[pr] >= 0 ? '+' : '−'}${(Math.abs(gauge[pr]) / 1e5).toFixed(2)} bar`;
    $('mAir').parentElement.title = `閉じ込められた空気のゲージ圧の最大: ${Lo.ROOMS[pr].name}`;
    $('mAir').className = gauge[pr] > 0.3e5 ? 'danger' : gauge[pr] > 0.05e5 ? 'warn' : '';
    const load = worst ? worst.ratio : 0;
    $('mLoad').textContent = `${Math.round(load * 100)} %`;
    $('mLoad').className = load > 0.85 ? 'danger' : load > 0.5 ? 'warn' : '';
    if (worst) $('mLoad').parentElement.title = `外板・甲板・閉じた開口にかかる内外の圧力差 ÷ 強度 の最大（100% で破れる）: ${Lo.ROOMS[worst.room].name}、${worst.dp >= 0 ? '外向き' : '内向き'} ${(Math.abs(worst.dp) / 1e5).toFixed(2)} bar`;
    $('perf').textContent = `${(1 / frameSec).toFixed(0)} fps ・ 水の粒子 ${(st?.alive ?? 0).toLocaleString()} / ${Q.max.toLocaleString()} ・ 格子 ${spec.dims.join('×')} (h=${h} m)`;
    chart.push(simTime, [s.rollDeg, s.pitchDeg, water / 1000]);
    chart.draw();

    // 状態の判定と通知
    // 着底: 船体の端（船首・船尾・船底・甲板の角）の最も低い点が海底に届いたか。傾いて沈むと船体中央は海底から遠い
    const lowest = Math.min(...BOTTOM_PROBES.map((p) => tmp.set(...p).applyMatrix4(model.group.matrixWorld).y));
    const onBottom = lowest < SEABED_Y + 1.0;
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
    const alerts = F.fillAlerts(fills, fillNotified);
    fillNotified = alerts.notified;
    for (const e of alerts.events) toast(`${Lo.ROOMS[e.room].name} ${e.kind === 'full' ? 'が満水' : 'に浸水'}`, e.kind === 'full' ? 'danger' : 'warn');
    updateLabelText(fills);
    // 側面図の喫水線（船首・船尾の位置で、海面の高さを船体座標の y に直す）
    q.copy(model.group.quaternion);
    const e = new THREE.Matrix4().makeRotationFromQuaternion(q).elements; // 列優先
    const wlY = (z) => { const w = sim.toWorld([0, 0, z]); return (sim.sea(w[0], w[2]) - model.group.position.y - e[9] * z) / e[5]; };
    const hotRooms = new Array(Lo.ROOMS.length).fill(false);
    built.openings.forEach((o, k) => { if (flows[k]?.mode === 'inflow') hotRooms[o.room] = true; });
    profile.update({
      fills, hot: hotRooms, waterline: WL_Z.map(wlY), pressures: gauge.map((g) => g / 1e5),
      doorStates: { ...gridState.doors, ...gridState.seaOpenings }, breaches: gridState.breaches,
    });
  }

  // 検証用（ブラウザのコンソールから、描画を待たずに進める）
  window.__app = {
    sim, fluid, model, gridState, launch, setDoor, camera, controls, fluidView, fx, ocean, scene, setFollow: (v) => { follow = v; },
    advance: async (n = 60) => { for (let i = 0; i < n; i++) { frame(performance.now(), 1 / 60); await renderer.backend.device.queue.onSubmittedWorkDone(); } return sim.state(); },
    get flows() { return flows; }, get openings() { return built.openings; },
    air, airCfg, gauge, levels, get worst() { return worst; }, get airFlows() { return airFlows; }, get ruptures() { return ruptures; },
  };

  $('loading').classList.add('hidden');
  renderer.setAnimationLoop(frame);
}

main().catch((e) => { console.error(e); if ($('fatal').classList.contains('hidden')) fatal(`エラー: ${e.message}`); });
