// 質量特性（質量・重心・慣性テンソル）の合成と主軸分解。船体 + 船内の水を 1 つの剛体として Rapier に渡すために使う。
// 慣性テンソルは [Ixx, Iyy, Izz, Ixy, Iyz, Izx]（重心まわり、船体座標、テンソルの成分なので積慣性は −Σ m x y）

// 点群のモーメント（Σm, Σm r, Σm r rᵀ、原点まわり）から、重心まわりの慣性テンソルを作る
export function fromMoments(m, s1, s2) {
  if (!(m > 0)) return { mass: 0, com: [0, 0, 0], inertia: [0, 0, 0, 0, 0, 0] };
  const c = s1.map((v) => v / m);
  // 重心まわりの 2 次モーメント C = Σm r rᵀ − m c cᵀ
  const xx = s2[0] - m * c[0] * c[0], yy = s2[1] - m * c[1] * c[1], zz = s2[2] - m * c[2] * c[2];
  const xy = s2[3] - m * c[0] * c[1], yz = s2[4] - m * c[1] * c[2], zx = s2[5] - m * c[2] * c[0];
  return { mass: m, com: c, inertia: [yy + zz, xx + zz, xx + yy, -xy, -yz, -zx] };
}

// 平行軸の定理で合成する
export function combine(a, b) {
  const m = a.mass + b.mass;
  if (!(m > 0)) return { mass: 0, com: [0, 0, 0], inertia: [0, 0, 0, 0, 0, 0] };
  const c = [0, 1, 2].map((i) => (a.mass * a.com[i] + b.mass * b.com[i]) / m);
  const shifted = (p) => {
    const [dx, dy, dz] = [0, 1, 2].map((i) => p.com[i] - c[i]);
    const I = p.inertia;
    return [I[0] + p.mass * (dy * dy + dz * dz), I[1] + p.mass * (dx * dx + dz * dz), I[2] + p.mass * (dx * dx + dy * dy),
      I[3] - p.mass * dx * dy, I[4] - p.mass * dy * dz, I[5] - p.mass * dz * dx];
  };
  const ia = shifted(a), ib = shifted(b);
  return { mass: m, com: c, inertia: ia.map((v, i) => v + ib[i]) };
}

// 対称 3×3 行列の固有値分解（ヤコビ法）。値と、列が固有ベクトルの回転行列を返す
export function eigenSym([xx, yy, zz, xy, yz, zx]) {
  const a = [[xx, xy, zx], [xy, yy, yz], [zx, yz, zz]];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 32; sweep++) {
    const off = a[0][1] ** 2 + a[1][2] ** 2 + a[0][2] ** 2;
    if (off < 1e-20 * (1 + a[0][0] ** 2 + a[1][1] ** 2 + a[2][2] ** 2)) break;
    for (const [p, q] of [[0, 1], [1, 2], [0, 2]]) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
      for (let k = 0; k < 3; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < 3; k++) { const vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
    }
  }
  // 右手系にする（回転行列 → 四元数に変換できるように）
  const det = v[0][0] * (v[1][1] * v[2][2] - v[1][2] * v[2][1]) - v[0][1] * (v[1][0] * v[2][2] - v[1][2] * v[2][0]) + v[0][2] * (v[1][0] * v[2][1] - v[1][1] * v[2][0]);
  if (det < 0) for (let k = 0; k < 3; k++) v[k][2] = -v[k][2];
  return { values: [a[0][0], a[1][1], a[2][2]], vectors: v };
}

// 回転行列（列ベクトル）→ 四元数 {x, y, z, w}
export function matToQuat(m) {
  const tr = m[0][0] + m[1][1] + m[2][2];
  let x, y, z, w;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    w = 0.25 / s; x = (m[2][1] - m[1][2]) * s; y = (m[0][2] - m[2][0]) * s; z = (m[1][0] - m[0][1]) * s;
  } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
    const s = 2 * Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]);
    w = (m[2][1] - m[1][2]) / s; x = 0.25 * s; y = (m[0][1] + m[1][0]) / s; z = (m[0][2] + m[2][0]) / s;
  } else if (m[1][1] > m[2][2]) {
    const s = 2 * Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]);
    w = (m[0][2] - m[2][0]) / s; x = (m[0][1] + m[1][0]) / s; y = 0.25 * s; z = (m[1][2] + m[2][1]) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]);
    w = (m[1][0] - m[0][1]) / s; x = (m[0][2] + m[2][0]) / s; y = (m[1][2] + m[2][1]) / s; z = 0.25 * s;
  }
  const l = Math.hypot(x, y, z, w);
  return { x: x / l, y: y / l, z: z / l, w: w / l };
}
