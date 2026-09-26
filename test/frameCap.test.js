import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextFrameAt, FRAME_MS } from '../src/frameCap.js';

// hz の rAF を ±jitter [ms] の揺らぎ付きで dur [ms] 回し、描いた時刻の列を返す（ticks: rAF の回数）。gap: [開始時刻, 長さ] の間 rAF を止める（タブ非表示）
function run(hz, { jitter = 0.5, dur = 10000, gap = null } = {}) {
  let last = 0, seed = 1, t = 5000;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const drawn = [];
  drawn.ticks = 0;
  while (t < 5000 + dur) {
    drawn.ticks++;
    const now = t + (rnd() * 2 - 1) * jitter;
    const next = nextFrameAt(last, now);
    if (next !== null) { last = next; drawn.push(now); }
    t += 1000 / hz;
    if (gap && t >= gap[0]) { t += gap[1]; gap = null; }
  }
  return drawn;
}
// 任意の 1 秒間に描いた回数の最大
const maxPerSecond = (d) => { let m = 0; for (let i = 0, j = 0; i < d.length; i++) { while (d[i] - d[j] >= 1000) j++; m = Math.max(m, i - j + 1); } return m; };

test('描画上限: 60 Hz 以上のどの画面でも 60 回/秒、60 Hz 未満ではその Hz で描く', () => {
  // 71 / 144 Hz は、前回の描画時刻を now で記録していた旧実装で 35.5 / 48 fps に落ちていた（回帰テスト）
  for (const hz of [30, 50, 59.94, 60, 61, 71, 75, 90, 120, 144, 165, 240, 360]) {
    const d = run(hz);
    const want = Math.min(hz, 60) * 10;
    assert.ok(Math.abs(d.length - want) <= 2, `${hz} Hz: ${d.length} 回 / 10 s（期待 ${want}）`);
    assert.ok(maxPerSecond(d) <= 62, `${hz} Hz: 1 秒に ${maxPerSecond(d)} 回`);
  }
});

test('描画上限: 60 Hz の画面で vsync が 1 ms 揺れても 1 回も落とさない', () => {
  const d = run(60, { jitter: 1 });
  assert.equal(d.length, d.ticks);
});

test('描画上限: 初回（last = 0）は必ず描く', () => {
  assert.notEqual(nextFrameAt(0, 1234), null);
  assert.notEqual(nextFrameAt(0, FRAME_MS), null);
});

test('描画上限: 長く止まった後は遅れを捨て、まとめて描かずに 60 回/秒へ戻る', () => {
  const d = run(144, { gap: [8000, 3000] });
  const after = d.filter((t) => t >= 11000);
  // 復帰直後に取り戻すのは 1 回分だけ（連続で描くのは 2 回まで）
  const burst = after.filter((t) => t < after[0] + FRAME_MS / 2).length;
  assert.ok(burst <= 2, `復帰直後に ${burst} 回描いた`);
  // 止まる前と同じく 60 回/秒で描き続ける（固まらない）
  const tail = after.filter((t) => t >= 12000 && t < 15000).length;
  assert.ok(Math.abs(tail - 180) <= 1, `復帰後 3 s で ${tail} 回`);
  // 1 回の描画で予定時刻は実時間より先へ行かない（先へ行くと rAF が止まったように見える）
  assert.ok(nextFrameAt(0, 1e6) <= 1e6);
});
