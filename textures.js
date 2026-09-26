// canvas で描く手続き的テクスチャ（外部画像なし）。three の npm パッケージにはテクスチャが同梱されないため
import * as THREE from 'three';
import * as H from './hull.js';

const rand = (a, b) => a + Math.random() * (b - a);

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}

function tex(c, { srgb = true, repeat = false } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

// 船体外板。u の前半が左舷、後半が右舷（どちらも文字が正しい向きで読めるよう z の向きを逆にする）。v は船底 → 甲板上端
export const HULL_TEX_Y = [H.Y_MIN, H.Y_MAX + 0.15]; // v = 0..1 に対応する y の範囲（ブルワーク上端まで）
export function hullUV(side, z, y) {
  const f = (z - H.Z_MIN) / H.L;
  return [side > 0 ? 0.5 * (1 - f) : 0.5 + 0.5 * f, (y - HULL_TEX_Y[0]) / (HULL_TEX_Y[1] - HULL_TEX_Y[0])];
}

export function hullTextures(waterline, name = 'KAIYO MARU') {
  const W = 4096, Hh = 512;
  const [c, g] = canvas(W, Hh);
  const [bc, bg] = canvas(W, Hh); // bump（凹凸）用。灰色 0.5 を基準に、継ぎ目は暗く溶接ビードは明るく
  bg.fillStyle = '#808080';
  bg.fillRect(0, 0, W, Hh);
  const px = (side, z) => hullUV(side, z, 0)[0] * W;
  const py = (y) => (1 - hullUV(1, 0, y)[1]) * Hh;
  const mPerPx = H.L / (W / 2);

  for (const side of [1, -1]) {
    const x0 = side > 0 ? 0 : W / 2;
    // 塗り分け: 船底塗料（赤）/ ブーツトップ（黒）/ 外舷（紺）
    g.fillStyle = '#1b2533'; g.fillRect(x0, 0, W / 2, Hh);
    g.fillStyle = '#7d2a20'; g.fillRect(x0, py(waterline - 0.03), W / 2, Hh);
    g.fillStyle = '#121212'; g.fillRect(x0, py(waterline + 0.1), W / 2, py(waterline - 0.03) - py(waterline + 0.1));
    // 舷側の白線（ブルワーク上端）。舷弧に沿うので列ごとに描く
    for (let x = 0; x < W / 2; x += 2) {
      const f = x / (W / 2), z = side > 0 ? H.Z_MAX - f * H.L : H.Z_MIN + f * H.L, dy = H.deckY(z);
      g.fillStyle = '#e8e6df'; g.fillRect(x0 + x, py(dy + 0.15), 2, py(dy + 0.09) - py(dy + 0.15));
      g.fillStyle = '#0e141c'; g.fillRect(x0 + x, py(dy + 0.005), 2, 2); // 甲板の高さの線（ここに外板の継ぎ目がある）
    }
    // 外板の継ぎ目（横: 板の段、縦: 0.9m ごと）
    g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 1.5;
    bg.strokeStyle = '#303030'; bg.lineWidth = 2;
    for (const y of [waterline - 0.3, waterline + 0.3, waterline + 0.6, waterline + 0.9]) {
      for (const k of [g, bg]) { k.beginPath(); k.moveTo(x0, py(y)); k.lineTo(x0 + W / 2, py(y)); k.stroke(); }
    }
    for (let z = H.Z_MIN + 0.45; z < H.Z_MAX; z += 0.9) {
      for (const k of [g, bg]) { k.beginPath(); k.moveTo(px(side, z), 0); k.lineTo(px(side, z), Hh); k.stroke(); }
    }
    // 舷窓の列（黒いガラス + 真鍮の縁）
    for (let z = -1.1; z < 2.6; z += 0.55) {
      const x = px(side, z), y = py(waterline + 0.62);
      g.fillStyle = '#8a7b5a'; g.beginPath(); g.arc(x, y, 9, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#0a1018'; g.beginPath(); g.arc(x, y, 6.5, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(160,190,220,0.5)'; g.beginPath(); g.arc(x - 2, y - 2, 2, 0, Math.PI * 2); g.fill();
      bg.fillStyle = '#c0c0c0'; bg.beginPath(); bg.arc(x, y, 9, 0, Math.PI * 2); bg.fill();
    }
    // 錨の出口（ホースパイプ）と、そこから垂れる錆
    const hx = px(side, 3.35), hy = py(H.deckY(3.35) - 0.28);
    const rust = g.createLinearGradient(0, hy, 0, hy + 90);
    rust.addColorStop(0, 'rgba(140,70,25,0.8)'); rust.addColorStop(1, 'rgba(140,70,25,0)');
    g.fillStyle = rust; g.fillRect(hx - 10, hy, 20, 90);
    g.fillStyle = '#050505'; g.beginPath(); g.ellipse(hx, hy, 16, 12, 0, 0, Math.PI * 2); g.fill();
    // 排水口などから垂れる錆の筋
    for (let i = 0; i < 70; i++) {
      const x = x0 + rand(20, W / 2 - 20), y = rand(py(H.D / 2 + 0.05), py(waterline + 0.3)), len = rand(20, 110);
      const gr = g.createLinearGradient(0, y, 0, y + len);
      gr.addColorStop(0, `rgba(${rand(110, 150)},${rand(55, 75)},25,${rand(0.25, 0.6)})`);
      gr.addColorStop(1, 'rgba(120,60,25,0)');
      g.fillStyle = gr; g.fillRect(x, y, rand(1.5, 5), len);
    }
    // 喫水線付近の汚れ（藻・水垢）
    const scum = g.createLinearGradient(0, py(waterline + 0.12), 0, py(waterline - 0.15));
    scum.addColorStop(0, 'rgba(60,70,40,0)'); scum.addColorStop(0.5, 'rgba(60,70,40,0.35)'); scum.addColorStop(1, 'rgba(60,70,40,0)');
    g.fillStyle = scum; g.fillRect(x0, py(waterline + 0.12), W / 2, py(waterline - 0.15) - py(waterline + 0.12));
    // 喫水標（船首・船尾、0.2m ごと。数字は dm）
    g.fillStyle = '#f2f2f2'; g.font = 'bold 20px sans-serif'; g.textAlign = 'center';
    for (const z of [3.05, -3.75]) for (let k = 2; k <= 8; k += 2) g.fillText(String(k), px(side, z), py(H.Y_MIN + k / 10) + 7);
    // 船名（船首寄り）
    g.font = 'bold 44px serif'; g.fillStyle = '#f4f1e8';
    g.fillText(name, px(side, 2.35), py(H.D / 2 - 0.1));
  }
  // 全体の細かな汚れ・塗装むら
  for (let i = 0; i < 60000; i++) {
    const a = rand(0.02, 0.08);
    g.fillStyle = Math.random() < 0.5 ? `rgba(0,0,0,${a})` : `rgba(255,255,255,${a * 0.5})`;
    g.fillRect(rand(0, W), rand(0, Hh), rand(1, 4), rand(1, 4));
  }
  for (let i = 0; i < 20000; i++) { bg.fillStyle = `rgba(${rand(90, 170)},${rand(90, 170)},${rand(90, 170)},0.15)`; bg.fillRect(rand(0, W), rand(0, Hh), 2, 2); }
  return { map: tex(c), bumpMap: tex(bc, { srgb: false }) };
}

// 木甲板（チーク材）。板は v 方向（船の前後）に走る。1 タイル = 1.2 m 四方
export function deckTexture() {
  const S = 1024, planks = 10, pw = S / planks;
  const [c, g] = canvas(S, S);
  for (let i = 0; i < planks; i++) {
    let y = -rand(0, 400);
    while (y < S) {
      const len = rand(300, 700);
      const l = rand(38, 50);
      g.fillStyle = `hsl(${rand(26, 34)},${rand(35, 50)}%,${l}%)`;
      g.fillRect(i * pw, y, pw, len);
      for (let k = 0; k < 14; k++) { // 木目
        g.strokeStyle = `rgba(60,35,15,${rand(0.05, 0.18)})`; g.lineWidth = rand(0.5, 1.5);
        g.beginPath();
        const x = i * pw + rand(4, pw - 4);
        g.moveTo(x, y); g.bezierCurveTo(x + rand(-4, 4), y + len / 3, x + rand(-4, 4), y + (2 * len) / 3, x + rand(-3, 3), y + len); g.stroke();
      }
      g.fillStyle = '#1a120a'; g.fillRect(i * pw, y, pw, 3); // 突き合わせ部
      y += len;
    }
    g.fillStyle = '#15100b'; g.fillRect(i * pw, 0, 4, S); // コーキング（板の間の黒い詰め物）
  }
  for (let i = 0; i < 25000; i++) { g.fillStyle = `rgba(0,0,0,${rand(0.02, 0.07)})`; g.fillRect(rand(0, S), rand(0, S), rand(1, 3), rand(1, 3)); }
  for (let i = 0; i < 40; i++) { // 雨染み・擦れ
    const x = rand(0, S), y = rand(0, S), r = rand(30, 120);
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, 'rgba(40,40,40,0.12)'); gr.addColorStop(1, 'rgba(40,40,40,0)');
    g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
  return tex(c, { repeat: true });
}

// 上部構造の白塗装（パネル線・錆だれ）
export function paintTexture(base = '#e9e7e0') {
  const S = 512;
  const [c, g] = canvas(S, S);
  g.fillStyle = base; g.fillRect(0, 0, S, S);
  g.strokeStyle = 'rgba(0,0,0,0.12)'; g.lineWidth = 2;
  for (let x = 0; x <= S; x += 128) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, S); g.stroke(); }
  for (let i = 0; i < 25; i++) {
    const x = rand(0, S), y = rand(0, S * 0.6), len = rand(30, 150);
    const gr = g.createLinearGradient(0, y, 0, y + len);
    gr.addColorStop(0, `rgba(140,75,30,${rand(0.2, 0.5)})`); gr.addColorStop(1, 'rgba(140,75,30,0)');
    g.fillStyle = gr; g.fillRect(x, y, rand(1, 4), len);
  }
  for (let i = 0; i < 15000; i++) { g.fillStyle = `rgba(0,0,0,${rand(0.01, 0.05)})`; g.fillRect(rand(0, S), rand(0, S), 2, 2); }
  return tex(c, { repeat: true });
}

// 煙突: 下から クリーム / 赤帯（白線） / 黒い頂部
export function funnelTexture() {
  const [c, g] = canvas(512, 256);
  g.fillStyle = '#d9cfb4'; g.fillRect(0, 0, 512, 256);
  g.fillStyle = '#b3261e'; g.fillRect(0, 60, 512, 90);
  g.fillStyle = '#f2f2f2'; g.fillRect(0, 95, 512, 20);
  g.fillStyle = '#151515'; g.fillRect(0, 0, 512, 45);
  for (let i = 0; i < 4000; i++) { g.fillStyle = `rgba(0,0,0,${rand(0.02, 0.1)})`; g.fillRect(rand(0, 512), rand(0, 256), 2, 2); }
  const soot = g.createLinearGradient(0, 45, 0, 110);
  soot.addColorStop(0, 'rgba(0,0,0,0.5)'); soot.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = soot; g.fillRect(0, 45, 512, 65);
  return tex(c);
}

// 救命艇（オレンジ）
export function lifeboatTexture() {
  const [c, g] = canvas(256, 128);
  g.fillStyle = '#e8641c'; g.fillRect(0, 0, 256, 128);
  g.fillStyle = '#f4f4f4'; g.fillRect(0, 50, 256, 12);
  for (let i = 0; i < 2000; i++) { g.fillStyle = `rgba(0,0,0,${rand(0.02, 0.08)})`; g.fillRect(rand(0, 256), rand(0, 128), 2, 2); }
  return tex(c);
}

// 海底の砂
export function sandTexture() {
  const S = 512;
  const [c, g] = canvas(S, S);
  g.fillStyle = '#9c8a64'; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 60000; i++) {
    const l = rand(35, 70);
    g.fillStyle = `hsla(40,${rand(15, 35)}%,${l}%,0.35)`;
    g.fillRect(rand(0, S), rand(0, S), rand(1, 3), rand(1, 3));
  }
  for (let i = 0; i < 30; i++) { // 砂紋
    g.strokeStyle = 'rgba(70,55,35,0.15)'; g.lineWidth = rand(3, 8);
    const y = rand(0, S);
    g.beginPath(); g.moveTo(0, y);
    for (let x = 0; x <= S; x += 32) g.lineTo(x, y + Math.sin(x / 40 + i) * 10);
    g.stroke();
  }
  return tex(c, { repeat: true });
}

// 破口のデカール: めくれた外板の縁と黒い穴。アルファ付き
export function breachTexture() {
  const S = 256;
  const [c, g] = canvas(S, S);
  const jag = (r, n, amp) => {
    g.beginPath();
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2, rr = r * (1 + rand(-amp, amp));
      g[i ? 'lineTo' : 'moveTo'](S / 2 + Math.cos(a) * rr, S / 2 + Math.sin(a) * rr);
    }
    g.closePath();
  };
  const scorch = g.createRadialGradient(S / 2, S / 2, 20, S / 2, S / 2, S / 2);
  scorch.addColorStop(0, 'rgba(20,15,10,0.95)'); scorch.addColorStop(0.6, 'rgba(60,35,20,0.6)'); scorch.addColorStop(1, 'rgba(60,35,20,0)');
  g.fillStyle = scorch; g.fillRect(0, 0, S, S);
  g.fillStyle = '#5a3a26'; jag(80, 28, 0.25); g.fill(); // めくれた外板（錆びた縁）
  g.fillStyle = '#020202'; jag(62, 22, 0.3); g.fill();
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

// 水面のさざ波用 normal map。整数周波数の sin の和なのでタイル境界で継ぎ目が出ない
export function rippleNormalMap(size = 256, repeat = 40) {
  const waves = [[3, 1, 1], [1, 4, 0.8], [5, -2, 0.5], [-7, 3, 0.3], [2, 9, 0.25], [11, 5, 0.12]]; // [kx, ky, 振幅]
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let dx = 0, dy = 0;
      for (const [kx, ky, a] of waves) {
        const c = a * Math.cos((2 * Math.PI * (kx * x + ky * y)) / size);
        dx += c * kx; dy += c * ky;
      }
      const n = new THREE.Vector3(-dx * 0.08, -dy * 0.08, 1).normalize();
      data.set([(n.x * 0.5 + 0.5) * 255, (n.y * 0.5 + 0.5) * 255, (n.z * 0.5 + 0.5) * 255, 255], (y * size + x) * 4);
    }
  const t = new THREE.DataTexture(data, size, size);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.needsUpdate = true;
  return t;
}

// 船尾旗（日章旗）
export function flagTexture() {
  const [c, g] = canvas(96, 64);
  g.fillStyle = '#f7f7f5'; g.fillRect(0, 0, 96, 64);
  g.fillStyle = '#bc002d'; g.beginPath(); g.arc(48, 32, 19, 0, Math.PI * 2); g.fill();
  return tex(c);
}
