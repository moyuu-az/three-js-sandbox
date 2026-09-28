// GPU 流体と船体（CPU）のあいだの単位・座標の変換。ここを間違えると船の運動が狂うのでテストで守る
import { fromMoments } from './massprops.js';

/**
 * GPU の集計（格子点の質量と、格子の中心 center からの相対位置 r のモーメント）を、船体座標 [m]・質量 [kg] の質量特性に直す。
 * moments = [Σm, Σm·rx, Σm·ry, Σm·rz, Σm·rx², Σm·ry², Σm·rz², Σm·rx·ry, Σm·ry·rz, Σm·rz·rx]（m は粒子の個数単位）
 * 船体座標 p = origin + (center + r)·h = a + h·r
 */
export function waterMassProps(moments, center, { origin, h }, particleMass) {
  const m = moments, n = m[0];
  if (!(n > 0.5)) return { mass: 0, com: [0, 0, 0], inertia: [0, 0, 0, 0, 0, 0] };
  const a = [0, 1, 2].map((i) => origin[i] + center[i] * h);
  const s1 = [0, 1, 2].map((i) => particleMass * (n * a[i] + h * m[1 + i]));
  const sq = (i) => particleMass * (n * a[i] * a[i] + 2 * h * a[i] * m[1 + i] + h * h * m[4 + i]);
  const cr = (i, j, k) => particleMass * (n * a[i] * a[j] + h * (a[i] * m[1 + j] + a[j] * m[1 + i]) + h * h * m[k]);
  return fromMoments(n * particleMass, s1, [sq(0), sq(1), sq(2), cr(0, 1, 7), cr(1, 2, 8), cr(2, 0, 9)]);
}

// 船体座標 [m] → 格子座標（格子点 i の中心が i + 0.5）
export const toGridCoords = (p, { origin, h }) => [(p[0] - origin[0]) / h, (p[1] - origin[1]) / h, (p[2] - origin[2]) / h];

// 開口部の流量の結果を GPU の開口部の設定（格子単位）にする。噴流は、流入なら開口の外向き法線の逆向き、流出（q < 0）なら外向き
export function openingParams(opening, flow, spec) {
  const dir = flow.q < 0 ? 1 : -1;
  const vel = opening.normal.map((c) => (dir * c * flow.speed) / spec.h);
  return {
    mode: flow.mode,
    inflow: vel,
    center: toGridCoords(opening.spawn.center, spec),
    ax: opening.spawn.ax.map((c) => c / spec.h),
    ay: opening.spawn.ay.map((c) => c / spec.h),
    spawnVel: vel,
  };
}
