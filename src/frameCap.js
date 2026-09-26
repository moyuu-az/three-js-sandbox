// 描画回数の上限（rAF の間引き）。main.js の描画ループから呼ぶ。ブラウザに依存しないので node でテストできる
export const FRAME_MS = 1000 / 60;
// vsync の揺らぎで 60 Hz の画面の 1 回を取りこぼさないための余裕 [ms]
const SLACK_MS = 1.5;

// last: 前回描いたフレームの予定時刻、now: rAF の時刻 [ms]。描くなら新しい予定時刻を、描かないなら null を返す。
// 予定時刻は FRAME_MS ずつ進める（now を記録すると、144 Hz では 3 回に 1 回 = 48 fps に落ちる）。
// 予定時刻は now より最大 FRAME_MS 遅れてよい（高リフレッシュレートで rAF の刻みと 1/60 s がずれる分の余裕）。
// それより遅れたら（タブ復帰・重いフレーム）遅れは捨てる。取り戻すのは 1 回分だけ（直後の rAF で 1 回描く）
export function nextFrameAt(last, now) {
  if (now - last < FRAME_MS - SLACK_MS) return null;
  return Math.max(last + FRAME_MS, now - FRAME_MS);
}
