// キーボードでのカメラ移動: W A S D で水平の前後左右、Q E で下降・上昇、Shift で速く。three に依存しないので node でテストできる
export const MOVE_KEYS = { KeyW: [0, 0, 1], KeyS: [0, 0, -1], KeyA: [-1, 0, 0], KeyD: [1, 0, 0], KeyE: [0, 1, 0], KeyQ: [0, -1, 0] };

/**
 * この dt の移動量（ワールド座標 [x, y, z]）。
 * pressed: 押されているキー（KeyboardEvent.code の集合）、forward: カメラの向き（ワールド）、dist: カメラから注視点までの距離 [m]。
 * 前後はカメラの向きを水平面に投影した向き（見下ろしていても海にもぐらない）。真下を見ているときは画面の上（fallback）を前にする。
 * 速さは注視点までの距離に比例（近くでは細かく、遠くでは大きく動く）。斜め移動も同じ速さ
 */
export function flyDelta(pressed, forward, dist, dt, { fast = false, fallback = [0, 0, -1] } = {}) {
  let m = [0, 0, 0];
  for (const code of pressed) { const k = MOVE_KEYS[code]; if (k) m = [m[0] + k[0], m[1] + k[1], m[2] + k[2]]; }
  const ml = Math.hypot(...m);
  if (ml === 0 || !(dt > 0)) return [0, 0, 0];
  let fx = forward[0], fz = forward[2], fl = Math.hypot(fx, fz);
  if (fl < 1e-3) { fx = fallback[0]; fz = fallback[2]; fl = Math.hypot(fx, fz) || 1; }
  fx /= fl; fz /= fl;
  const speed = Math.min(60, Math.max(3, dist * 0.9)) * (fast ? 3 : 1) * dt / ml;
  // 右 = 前 × 上 = (−fz, 0, fx)
  return [(-fz * m[0] + fx * m[2]) * speed, m[1] * speed, (fx * m[0] + fz * m[2]) * speed];
}
