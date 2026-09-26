// canvas で描く手続き的テクスチャ（外部画像なし）。色・粗さ・凹凸（bump）を同じ模様から作り、PBR 材質に使う
import * as THREE from 'three/webgpu';
import * as H from '../hull.js';

let seed = 12345;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647); // 決定的（毎回同じ見た目）
const rand = (a, b) => a + rnd() * (b - a);

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}

export function tex(c, { srgb = true, repeat = false, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  return t;
}

// 汚れ・塗装むら（細かい点を散らす）
function grime(g, w, h, n, dark = 0.06, light = 0.03) {
  for (let i = 0; i < n; i++) {
    const a = rand(0.2, 1);
    g.fillStyle = rnd() < 0.6 ? `rgba(0,0,0,${dark * a})` : `rgba(255,255,255,${light * a})`;
    g.fillRect(rand(0, w), rand(0, h), rand(1, 4), rand(1, 4));
  }
}
// 錆だれ（上から下へ細くなる筋）
function rustStreak(g, x, y, len, wid, alpha) {
  const gr = g.createLinearGradient(0, y, 0, y + len);
  gr.addColorStop(0, `rgba(${rand(120, 150)},${rand(58, 72)},${rand(22, 32)},${alpha})`);
  gr.addColorStop(1, 'rgba(120,60,25,0)');
  g.fillStyle = gr;
  g.beginPath(); g.moveTo(x - wid / 2, y); g.lineTo(x + wid / 2, y); g.lineTo(x + wid * 0.1, y + len); g.lineTo(x - wid * 0.1, y + len); g.fill();
}

// ================= 船体外板 =================
// u の前半が左舷、後半が右舷（どちらも文字が正しく読めるよう z の向きを逆にする）。v は船底 → ブルワーク上端
export const BULWARK = 1.0;
export const HULL_TEX_Y = [H.Y_MIN, H.Y_MAX + BULWARK];
export function hullUV(side, z, y) {
  const f = (z - H.Z_MIN) / H.L;
  return [side > 0 ? 0.5 * (1 - f) : 0.5 + 0.5 * f, (y - HULL_TEX_Y[0]) / (HULL_TEX_Y[1] - HULL_TEX_Y[0])];
}

export function hullTextures(draft, name = 'KAIYO MARU') {
  const W = 8192, Hh = 1024;
  const [c, g] = canvas(W, Hh), [bc, bg] = canvas(W, Hh), [rc, rg] = canvas(W, Hh);
  bg.fillStyle = '#808080'; bg.fillRect(0, 0, W, Hh);
  const px = (side, z) => hullUV(side, z, 0)[0] * W;
  const py = (y) => (1 - hullUV(1, 0, y)[1]) * Hh;
  const ppm = (W / 2) / H.L; // px / m
  const boot = [draft - 0.25, draft + 0.45]; // ブーツトップ（喫水線まわりの黒帯）

  for (const side of [1, -1]) {
    const x0 = side > 0 ? 0 : W / 2;
    // 塗り分け: 外舷（紺灰）/ ブーツトップ（黒）/ 船底塗料（赤）
    g.fillStyle = '#22303c'; g.fillRect(x0, 0, W / 2, Hh);
    g.fillStyle = '#121416'; g.fillRect(x0, py(boot[1]), W / 2, py(boot[0]) - py(boot[1]));
    g.fillStyle = '#8b2c22'; g.fillRect(x0, py(boot[0]), W / 2, Hh - py(boot[0]));
    rg.fillStyle = '#7a7a7a'; rg.fillRect(x0, 0, W / 2, Hh); // 粗さ: 外舷 0.48
    rg.fillStyle = '#b8b8b8'; rg.fillRect(x0, py(boot[0]), W / 2, Hh - py(boot[0])); // 船底塗料はつや消し
    // ブルワーク上端の白線と、甲板の高さの線（ここに外板の継ぎ目がある）
    for (let x = 0; x < W / 2; x += 2) {
      const f = x / (W / 2), z = side > 0 ? H.Z_MAX - f * H.L : H.Z_MIN + f * H.L, dy = H.deckY(z);
      g.fillStyle = '#e9e7e0'; g.fillRect(x0 + x, py(dy + BULWARK), 2, py(dy + BULWARK - 0.12) - py(dy + BULWARK));
      g.fillStyle = '#10161c'; g.fillRect(x0 + x, py(dy + 0.02), 2, 3);
      bg.fillStyle = '#404040'; bg.fillRect(x0 + x, py(dy + 0.02), 2, 3);
    }
    // 外板の継ぎ目（横: 板の列、縦: 6 m ごとの突き合わせ）と溶接ビード
    g.strokeStyle = 'rgba(0,0,0,0.28)'; g.lineWidth = 2;
    bg.strokeStyle = '#a8a8a8'; bg.lineWidth = 3;
    for (const y of [0.9, 1.9, draft + 0.9, draft + 1.9, 4.6]) for (const k of [g, bg]) { k.beginPath(); k.moveTo(x0, py(y)); k.lineTo(x0 + W / 2, py(y)); k.stroke(); }
    for (let z = H.Z_MIN + 3; z < H.Z_MAX; z += 6) for (const k of [g, bg]) { k.beginPath(); k.moveTo(px(side, z), 0); k.lineTo(px(side, z), Hh); k.stroke(); }
    // フレーム（肋骨）の溶接痕がうっすら浮く「痩せ馬」
    bg.fillStyle = 'rgba(96,96,96,0.25)';
    for (let z = H.Z_MIN + 0.3; z < H.Z_MAX; z += 0.6) bg.fillRect(px(side, z) - 3, py(H.D - 0.2), 6, py(0.4) - py(H.D - 0.2));
    // 舷窓（居住区の外板）
    for (let z = -3.8; z < 3.8; z += 1.4) {
      const x = px(side, z), y = py(4.1), r = 0.17 * ppm;
      g.fillStyle = '#9a8a62'; g.beginPath(); g.arc(x, y, r * 1.3, 0, 7); g.fill();
      g.fillStyle = '#0a1018'; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
      g.fillStyle = 'rgba(170,200,230,0.45)'; g.beginPath(); g.arc(x - r * 0.3, y - r * 0.3, r * 0.3, 0, 7); g.fill();
      bg.fillStyle = '#d0d0d0'; bg.beginPath(); bg.arc(x, y, r * 1.3, 0, 7); bg.fill();
      rg.fillStyle = '#202020'; rg.beginPath(); rg.arc(x, y, r, 0, 7); rg.fill();
      rustStreak(g, x, y + r * 1.3, rand(20, 70), 5, 0.35);
    }
    // 錨の出口（ホースパイプ）と錆
    const hx = px(side, 12.7), hy = py(H.deckY(12.7) - 0.9);
    rustStreak(g, hx, hy, 260, 60, 0.75);
    g.fillStyle = '#060606'; g.beginPath(); g.ellipse(hx, hy, 34, 26, 0, 0, 7); g.fill();
    bg.fillStyle = '#e0e0e0'; bg.beginPath(); bg.ellipse(hx, hy, 42, 34, 0, 0, 7); bg.fill();
    // 排水口（スカッパー）からの錆だれ
    for (let z = H.Z_MIN + 1.5; z < H.Z_MAX - 2; z += rand(2.2, 4)) {
      const x = px(side, z), y = py(H.deckY(z) + 0.1);
      g.fillStyle = '#080808'; g.fillRect(x - 10, y - 6, 20, 10);
      rustStreak(g, x, y + 4, rand(80, 260), rand(10, 22), rand(0.35, 0.7));
    }
    for (let i = 0; i < 90; i++) rustStreak(g, x0 + rand(20, W / 2 - 20), rand(py(H.D), py(boot[1] + 0.3)), rand(20, 140), rand(2, 7), rand(0.15, 0.45));
    // 喫水線付近の汚れ（藻・水垢）
    const scum = g.createLinearGradient(0, py(draft + 0.25), 0, py(draft - 0.3));
    scum.addColorStop(0, 'rgba(70,80,45,0)'); scum.addColorStop(0.5, 'rgba(70,80,45,0.4)'); scum.addColorStop(1, 'rgba(70,80,45,0)');
    g.fillStyle = scum; g.fillRect(x0, py(draft + 0.25), W / 2, py(draft - 0.3) - py(draft + 0.25));
    // 喫水標（船首・船尾・中央、0.2 m ごと、m の位置に M）
    g.fillStyle = '#f2f2f2'; g.textAlign = 'center'; g.font = `bold ${Math.round(0.13 * ppm)}px sans-serif`;
    for (const z of [13.2, -14.2, 0.6]) for (let k = 2; k <= 44; k += 2) {
      const y = py(k / 10) + 0.06 * ppm;
      g.fillText(k % 10 === 0 ? `${k / 10}M` : String(k % 10), px(side, z), y);
    }
    // 満載喫水線標（プリムソルマーク）
    const pmx = px(side, -0.8), pmy = py(draft + 0.55);
    g.strokeStyle = '#f2f2f2'; g.lineWidth = 5;
    g.beginPath(); g.arc(pmx, pmy, 0.2 * ppm, 0, 7); g.stroke();
    g.fillStyle = '#f2f2f2'; g.fillRect(pmx - 0.3 * ppm, pmy - 3, 0.6 * ppm, 6);
    g.fillRect(pmx - 0.3 * ppm, py(draft + 0.95) - 3, 0.6 * ppm, 6);
    g.font = `bold ${Math.round(0.12 * ppm)}px sans-serif`; g.fillText('N', pmx - 0.24 * ppm, pmy - 0.22 * ppm); g.fillText('K', pmx + 0.24 * ppm, pmy - 0.22 * ppm);
    // 船名（船首寄り、白）
    g.font = `bold ${Math.round(0.55 * ppm)}px "Segoe UI", sans-serif`; g.fillStyle = '#f4f1e8';
    g.fillText(name, px(side, 9.6), py(4.25));
    bg.font = g.font; bg.fillStyle = '#9a9a9a'; bg.textAlign = 'center'; bg.fillText(name, px(side, 9.6), py(4.25));
  }
  grime(g, W, Hh, 120000);
  for (let i = 0; i < 40000; i++) { const v = rand(100, 160); bg.fillStyle = `rgba(${v},${v},${v},0.18)`; bg.fillRect(rand(0, W), rand(0, Hh), 2, 2); }
  for (let i = 0; i < 30000; i++) { const v = rand(90, 200); rg.fillStyle = `rgba(${v},${v},${v},0.12)`; rg.fillRect(rand(0, W), rand(0, Hh), 3, 3); }
  return { map: tex(c, { aniso: 16 }), bumpMap: tex(bc, { srgb: false }), roughnessMap: tex(rc, { srgb: false }) };
}

// 船尾（トランサム）の船名と船籍港
export function sternTexture(name = 'KAIYO MARU', port = 'YOKOHAMA') {
  const [c, g] = canvas(1024, 512);
  g.fillStyle = '#22303c'; g.fillRect(0, 0, 1024, 512);
  g.fillStyle = '#f4f1e8'; g.textAlign = 'center';
  g.font = 'bold 92px "Segoe UI", sans-serif'; g.fillText(name, 512, 230);
  g.font = 'bold 60px "Segoe UI", sans-serif'; g.fillText(port, 512, 330);
  grime(g, 1024, 512, 6000);
  return tex(c);
}

// ================= 甲板・床 =================
// 鋼製甲板（滑り止め塗装、溶接線）。1 タイル = 3 m 四方
export function steelDeckTexture(base = '#4b5a4a') {
  const S = 1024;
  const [c, g] = canvas(S, S), [bc, bg] = canvas(S, S);
  g.fillStyle = base; g.fillRect(0, 0, S, S);
  bg.fillStyle = '#808080'; bg.fillRect(0, 0, S, S);
  for (let i = 0; i < 90000; i++) { // 滑り止めの粒
    const v = rand(0, 1);
    g.fillStyle = v < 0.5 ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.05)'; g.fillRect(rand(0, S), rand(0, S), 2, 2);
    bg.fillStyle = `rgba(${v < 0.5 ? 60 : 200},${v < 0.5 ? 60 : 200},${v < 0.5 ? 60 : 200},0.35)`; bg.fillRect(rand(0, S), rand(0, S), 2, 2);
  }
  g.strokeStyle = 'rgba(0,0,0,0.3)'; g.lineWidth = 3; bg.strokeStyle = '#b0b0b0'; bg.lineWidth = 4;
  for (const k of [g, bg]) { k.beginPath(); k.moveTo(0, S / 2); k.lineTo(S, S / 2); k.moveTo(S / 3, 0); k.lineTo(S / 3, S); k.stroke(); }
  for (let i = 0; i < 30; i++) { // 擦れ・錆
    const x = rand(0, S), y = rand(0, S), r = rand(20, 90);
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(${rand(90, 130)},${rand(55, 70)},30,0.35)`); gr.addColorStop(1, 'rgba(100,60,30,0)');
    g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
  return { map: tex(c, { repeat: true }), bumpMap: tex(bc, { srgb: false, repeat: true }) };
}

// 縞鋼板（機関室の床）。1 タイル = 1 m
export function checkerPlateTexture() {
  const S = 512;
  const [c, g] = canvas(S, S), [bc, bg] = canvas(S, S);
  g.fillStyle = '#6d7174'; g.fillRect(0, 0, S, S);
  bg.fillStyle = '#707070'; bg.fillRect(0, 0, S, S);
  const step = 32;
  for (let y = 0; y < S; y += step) for (let x = 0; x < S; x += step) {
    const rot = ((x + y) / step) % 2 ? 0.8 : -0.8;
    for (const [k, col] of [[g, 'rgba(200,205,210,0.35)'], [bg, '#e8e8e8']]) {
      k.save(); k.translate(x + step / 2, y + step / 2); k.rotate(rot); k.fillStyle = col;
      k.beginPath(); k.ellipse(0, 0, 11, 3, 0, 0, 7); k.fill(); k.restore();
    }
  }
  grime(g, S, S, 12000, 0.1, 0.04);
  return { map: tex(c, { repeat: true }), bumpMap: tex(bc, { srgb: false, repeat: true }) };
}

// 床材（居住区のリノリウム）
export function floorTexture(base = '#6f6453') {
  const S = 512;
  const [c, g] = canvas(S, S);
  g.fillStyle = base; g.fillRect(0, 0, S, S);
  g.strokeStyle = 'rgba(0,0,0,0.18)'; g.lineWidth = 2;
  for (let x = 0; x <= S; x += 128) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, S); g.stroke(); g.beginPath(); g.moveTo(0, x); g.lineTo(S, x); g.stroke(); }
  grime(g, S, S, 16000, 0.05, 0.03);
  return tex(c, { repeat: true });
}

// 塗装面（パネル線・錆だれ）。上部構造・隔壁など
export function paintTexture(base = '#e9e7e0', { rust = 25, panels = 128 } = {}) {
  const S = 512;
  const [c, g] = canvas(S, S);
  g.fillStyle = base; g.fillRect(0, 0, S, S);
  g.strokeStyle = 'rgba(0,0,0,0.1)'; g.lineWidth = 2;
  for (let x = 0; x <= S; x += panels) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, S); g.stroke(); }
  for (let i = 0; i < rust; i++) rustStreak(g, rand(0, S), rand(0, S * 0.7), rand(30, 160), rand(2, 6), rand(0.15, 0.45));
  grime(g, S, S, 15000, 0.05, 0.02);
  return tex(c, { repeat: true });
}

// 煙突: 下から 灰白 / 社章の帯 / 黒い頂部
export function funnelTexture() {
  const [c, g] = canvas(1024, 512);
  g.fillStyle = '#dcd6c4'; g.fillRect(0, 0, 1024, 512);
  g.fillStyle = '#1d4f91'; g.fillRect(0, 120, 1024, 170);
  g.fillStyle = '#f2f2f2';
  for (const cx of [128, 384, 640, 896]) { g.beginPath(); g.arc(cx, 205, 58, 0, 7); g.fill(); }
  g.fillStyle = '#c8202a'; for (const cx of [128, 384, 640, 896]) { g.beginPath(); g.arc(cx, 205, 36, 0, 7); g.fill(); }
  g.fillStyle = '#141414'; g.fillRect(0, 0, 1024, 90);
  const soot = g.createLinearGradient(0, 90, 0, 220);
  soot.addColorStop(0, 'rgba(0,0,0,0.55)'); soot.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = soot; g.fillRect(0, 90, 1024, 130);
  grime(g, 1024, 512, 10000);
  return tex(c);
}

export function lifeboatTexture() {
  const [c, g] = canvas(512, 256);
  g.fillStyle = '#e8641c'; g.fillRect(0, 0, 512, 256);
  g.fillStyle = '#f4f4f4'; g.fillRect(0, 150, 512, 20);
  grime(g, 512, 256, 3000);
  return tex(c);
}

// 海底の砂（砂紋）
export function sandTexture() {
  const S = 1024;
  const [c, g] = canvas(S, S), [bc, bg] = canvas(S, S);
  g.fillStyle = '#8e7d5a'; g.fillRect(0, 0, S, S);
  bg.fillStyle = '#808080'; bg.fillRect(0, 0, S, S);
  for (let i = 0; i < 160000; i++) {
    g.fillStyle = `hsla(40,${rand(15, 35)}%,${rand(30, 68)}%,0.35)`;
    g.fillRect(rand(0, S), rand(0, S), rand(1, 3), rand(1, 3));
  }
  for (let i = 0; i < 60; i++) {
    const y = (i / 60) * S;
    for (const [k, col, w] of [[g, 'rgba(60,48,30,0.16)', 6], [bg, 'rgba(40,40,40,0.5)', 10]]) {
      k.strokeStyle = col; k.lineWidth = w;
      k.beginPath(); k.moveTo(0, y);
      for (let x = 0; x <= S; x += 16) k.lineTo(x, y + Math.sin((x / S) * Math.PI * 6 + i) * 6);
      k.stroke();
    }
  }
  return { map: tex(c, { repeat: true }), bumpMap: tex(bc, { srgb: false, repeat: true }) };
}

// 破口のデカール: めくれた外板の縁と黒い穴。アルファ付き
export function breachTexture() {
  const S = 512;
  const [c, g] = canvas(S, S);
  const jag = (r, n, amp) => {
    g.beginPath();
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2, rr = r * (1 + rand(-amp, amp));
      g[i ? 'lineTo' : 'moveTo'](S / 2 + Math.cos(a) * rr * 1.25, S / 2 + Math.sin(a) * rr);
    }
    g.closePath();
  };
  const scorch = g.createRadialGradient(S / 2, S / 2, 40, S / 2, S / 2, S / 2);
  scorch.addColorStop(0, 'rgba(15,12,10,0.95)'); scorch.addColorStop(0.55, 'rgba(50,32,20,0.7)'); scorch.addColorStop(1, 'rgba(50,32,20,0)');
  g.fillStyle = scorch; g.fillRect(0, 0, S, S);
  g.fillStyle = '#6a4630'; jag(150, 40, 0.22); g.fill();
  g.fillStyle = '#010101'; jag(118, 30, 0.3); g.fill();
  return tex(c);
}

// 丸いぼかしのスプライト（粒子用）
export function softDotTexture() {
  const [c, g] = canvas(64, 64);
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.6)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return tex(c, { srgb: false });
}

// 船尾旗（日章旗）
export function flagTexture() {
  const [c, g] = canvas(192, 128);
  g.fillStyle = '#f7f7f5'; g.fillRect(0, 0, 192, 128);
  g.fillStyle = '#bc002d'; g.beginPath(); g.arc(96, 64, 38, 0, 7); g.fill();
  return tex(c);
}

// 水面の細かいさざ波の normal map。整数周波数の sin の和なのでタイル境界で継ぎ目が出ない
export function rippleNormalMap(size = 512) {
  const waves = [];
  for (let i = 0; i < 24; i++) waves.push([Math.round(rand(-14, 14)), Math.round(rand(-14, 14)), rand(0.1, 1) / (1 + i * 0.25)]);
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let dx = 0, dy = 0;
    for (const [kx, ky, a] of waves) {
      const cc = a * Math.cos((2 * Math.PI * (kx * x + ky * y)) / size);
      dx += cc * kx; dy += cc * ky;
    }
    const nx = -dx * 0.02, ny = -dy * 0.02, l = Math.hypot(nx, ny, 1);
    data.set([((nx / l) * 0.5 + 0.5) * 255, ((ny / l) * 0.5 + 0.5) * 255, ((1 / l) * 0.5 + 0.5) * 255, 255], (y * size + x) * 4);
  }
  const t = new THREE.DataTexture(data, size, size);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}
