// 時系列の小さなチャート（横傾斜・トリム・浸水量）。系列ごとに自分の範囲で正規化して重ねる
export function createChart(canvas, series, { span = 180 } = {}) {
  const g = canvas.getContext('2d');
  const data = [];
  function push(t, values) {
    data.push([t, ...values]);
    while (data.length && data[0][0] < t - span) data.shift();
  }
  function draw() {
    // 画素数は表示サイズ × devicePixelRatio に合わせる（固定の大きさを CSS で引き伸ばすと、パネル幅が変わる画面で縦横比が崩れる）
    const dpr = devicePixelRatio || 1;
    const cw = Math.round(canvas.clientWidth * dpr), ch = Math.round(canvas.clientHeight * dpr);
    if (cw > 0 && ch > 0 && (canvas.width !== cw || canvas.height !== ch)) { canvas.width = cw; canvas.height = ch; }
    const W = canvas.width, Hh = canvas.height, s = cw > 0 ? dpr : W / 280; // s: CSS 1 px の画素数（非表示のときは元の比率）
    g.clearRect(0, 0, W, Hh);
    g.strokeStyle = 'rgba(160,200,230,0.12)'; g.lineWidth = Math.max(1, 0.5 * s);
    for (let k = 1; k < 4; k++) { g.beginPath(); g.moveTo(0, (Hh * k) / 4); g.lineTo(W, (Hh * k) / 4); g.stroke(); }
    if (data.length < 2) return;
    const t1 = data.at(-1)[0], t0 = Math.max(data[0][0], t1 - span);
    series.forEach((se, i) => {
      const lo = se.min ?? Math.min(...data.map((d) => d[i + 1])), hi = se.max ?? Math.max(1e-6, ...data.map((d) => d[i + 1]));
      g.strokeStyle = se.color; g.lineWidth = 1.1 * s; g.beginPath();
      data.forEach((d, k) => {
        const x = ((d[0] - t0) / Math.max(1e-6, t1 - t0)) * W, y = Hh - ((d[i + 1] - lo) / (hi - lo || 1)) * (Hh - 4 * s) - 2 * s;
        k ? g.lineTo(x, y) : g.moveTo(x, y);
      });
      g.stroke();
    });
    g.fillStyle = 'rgba(142,163,181,0.9)'; g.font = `${Math.round(9.5 * s)}px sans-serif`;
    g.fillText(`${Math.round(Math.min(span, t1 - t0))} s`, 3 * s, 10 * s);
  }
  return { push, draw };
}
