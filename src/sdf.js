/* Argile — modélisation par champs de distance signés (SDF) et maillages explicites.
 * Les nœuds sont { f(x,y,z) → distance, bb: [minX,minY,minZ,maxX,maxY,maxZ], label? }.
 * Le mailleur évalue le champ par blocs et ne calcule finement que la bande autour de la surface. */
(function (root) {
'use strict';
const Core = root.Core || require('./core.js');

const BIG = 1e9;
const INF_BB = [-BIG, -BIG, -BIG, BIG, BIG, BIG];
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smooth01 = (x) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
function smin(a, b, k) { if (!(k > 0)) return a < b ? a : b; const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; }
function smax(a, b, k) { return -smin(-a, -b, k); }
const node = (f, bb, label) => (label ? { f, bb, label } : { f, bb });
const bbPad = (bb, r) => [bb[0] - r, bb[1] - r, bb[2] - r, bb[3] + r, bb[4] + r, bb[5] + r];
const bbDist = (b, x, y, z) => {
  const dx = Math.max(b[0] - x, 0, x - b[3]), dy = Math.max(b[1] - y, 0, y - b[4]), dz = Math.max(b[2] - z, 0, z - b[5]);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};

// ------------------------------------------------------------ 2D
const len2 = (x, y) => Math.sqrt(x * x + y * y);
function roundRect2(u, v, hx, hy, r) {
  r = Math.max(0, Math.min(r, hx, hy));
  const qx = Math.abs(u) - hx + r, qy = Math.abs(v) - hy + r;
  return Math.min(Math.max(qx, qy), 0) + len2(Math.max(qx, 0), Math.max(qy, 0)) - r;
}
// Distance exacte à une ellipse (Inigo Quilez), positive à l'extérieur
function ellipse2(px, py, a, b) {
  if (Math.abs(a - b) < 1e-6 * Math.max(a, b)) return len2(px, py) - a;
  px = Math.abs(px); py = Math.abs(py);
  if (px > py) { let t = px; px = py; py = t; t = a; a = b; b = t; }
  const l = b * b - a * a, m = (a * px) / l, m2 = m * m, n = (b * py) / l, n2 = n * n;
  const c = (m2 + n2 - 1) / 3, c3 = c * c * c, q = c3 + m2 * n2 * 2, d = c3 + m2 * n2, g = m + m * n2;
  let co;
  if (d < 0) {
    const h = Math.acos(clamp(q / c3, -1, 1)) / 3, s = Math.cos(h), t = Math.sin(h) * Math.sqrt(3);
    const rx = Math.sqrt(Math.max(0, -c * (s + t + 2) + m2)), ry = Math.sqrt(Math.max(0, -c * (s - t + 2) + m2));
    co = (ry + Math.sign(l) * rx + Math.abs(g) / (rx * ry) - m) / 2;
  } else {
    const h = 2 * m * n * Math.sqrt(d);
    const s = Math.sign(q + h) * Math.pow(Math.abs(q + h), 1 / 3), u = Math.sign(q - h) * Math.pow(Math.abs(q - h), 1 / 3);
    const rx = -s - u - c * 4 + 2 * m2, ry = (s - u) * Math.sqrt(3), rm = Math.sqrt(rx * rx + ry * ry);
    co = (ry / Math.sqrt(rm - rx) + (2 * g) / rm - m) / 2;
  }
  if (!isFinite(co)) return (len2(px / a, py / b) - 1) * Math.min(a, b);
  co = clamp(co, 0, 1);
  const rx = a * co, ry = b * Math.sqrt(Math.max(0, 1 - co * co));
  return len2(rx - px, ry - py) * Math.sign(py - ry || px - rx);
}
function octagon2(px, py, r) {
  const kx = -0.9238795325, ky = 0.3826834323, kz = 0.4142135623;
  px = Math.abs(px); py = Math.abs(py);
  let d = Math.min(kx * px + ky * py, 0); px -= 2 * d * kx; py -= 2 * d * ky;
  d = Math.min(-kx * px + ky * py, 0); px -= 2 * d * -kx; py -= 2 * d * ky;
  px -= clamp(px, -kz * r, kz * r); py -= r;
  return len2(px, py) * Math.sign(py);
}
// Contours de plateau : ovale, rond, carré, coussin, octogone (demi-largeurs a, b)
function shape2D(kind, a, b) {
  switch (kind) {
    case 'rond': { const r = Math.min(a, b); return (u, v) => len2(u, v) - r; }
    case 'carre': { const r = Math.min(a, b) * 0.18; return (u, v) => roundRect2(u, v, a, b, r); }
    case 'coussin': { const r = Math.min(a, b) * 0.55; return (u, v) => roundRect2(u, v, a, b, r); }
    case 'octogone': { const s = Math.min(a, b); return (u, v) => octagon2(u * s / a, v * s / b, s) * Math.min(a / s, b / s); }
    default: return (u, v) => ellipse2(u, v, a, b);
  }
}

// ------------------------------------------------------------ primitives 3D
function sphere(cx, cy, cz, r) {
  return node((x, y, z) => Math.sqrt((x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2) - r, [cx - r, cy - r, cz - r, cx + r, cy + r, cz + r]);
}
function ellipsoid(cx, cy, cz, rx, ry, rz) {
  const m = Math.min(rx, ry, rz);
  return node((x, y, z) => {
    const X = x - cx, Y = y - cy, Z = z - cz;
    const k0 = Math.sqrt((X / rx) ** 2 + (Y / ry) ** 2 + (Z / rz) ** 2);
    const k1 = Math.sqrt((X / (rx * rx)) ** 2 + (Y / (ry * ry)) ** 2 + (Z / (rz * rz)) ** 2);
    return k1 > 1e-12 ? (k0 * (k0 - 1)) / k1 : -m;
  }, [cx - rx, cy - ry, cz - rz, cx + rx, cy + ry, cz + rz]);
}
function box(cx, cy, cz, hx, hy, hz, r = 0) {
  r = Math.max(0, Math.min(r, hx, hy, hz));
  return node((x, y, z) => {
    const qx = Math.abs(x - cx) - hx + r, qy = Math.abs(y - cy) - hy + r, qz = Math.abs(z - cz) - hz + r;
    const ox = Math.max(qx, 0), oy = Math.max(qy, 0), oz = Math.max(qz, 0);
    return Math.sqrt(ox * ox + oy * oy + oz * oz) + Math.min(Math.max(qx, qy, qz), 0) - r;
  }, [cx - hx, cy - hy, cz - hz, cx + hx, cy + hy, cz + hz]);
}
// Boîte définie par ses bornes
const boxMM = (x0, y0, z0, x1, y1, z1, r = 0) => box((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, Math.abs(z1 - z0) / 2, r);
// Cône arrondi entre a (rayon r1) et b (rayon r2), Inigo Quilez
function roundCone(a, b, r1, r2) {
  const bax = b[0] - a[0], bay = b[1] - a[1], baz = b[2] - a[2];
  const l2 = bax * bax + bay * bay + baz * baz;
  const bb = [Math.min(a[0] - r1, b[0] - r2), Math.min(a[1] - r1, b[1] - r2), Math.min(a[2] - r1, b[2] - r2), Math.max(a[0] + r1, b[0] + r2), Math.max(a[1] + r1, b[1] + r2), Math.max(a[2] + r1, b[2] + r2)];
  if (l2 < 1e-12 || Math.abs(r1 - r2) >= Math.sqrt(l2)) {
    const r = Math.max(r1, r2), c = r1 >= r2 ? a : b;
    return node((x, y, z) => Math.sqrt((x - c[0]) ** 2 + (y - c[1]) ** 2 + (z - c[2]) ** 2) - r, bb);
  }
  const rr = r1 - r2, a2 = l2 - rr * rr, il2 = 1 / l2;
  return node((x, y, z) => {
    const pax = x - a[0], pay = y - a[1], paz = z - a[2];
    const yy = pax * bax + pay * bay + paz * baz, zz = yy - l2;
    const qx = pax * l2 - bax * yy, qy = pay * l2 - bay * yy, qz = paz * l2 - baz * yy;
    const x2 = qx * qx + qy * qy + qz * qz, y2 = yy * yy * l2, z2 = zz * zz * l2;
    const k = Math.sign(rr) * rr * rr * x2;
    if (Math.sign(zz) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
    if (Math.sign(yy) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
    return (Math.sqrt(x2 * a2 * il2) + yy * rr) * il2 - r1;
  }, bb);
}
const capsule = (a, b, r) => roundCone(a, b, r, r);
// Cylindre d'axe x|y|z, du niveau lo au niveau hi le long de l'axe, arêtes arrondies rr
function cyl(axis, cx, cy, cz, r, lo, hi, rr = 0) {
  const mid = (lo + hi) / 2, hl = Math.abs(hi - lo) / 2; rr = Math.max(0, Math.min(rr, r, hl));
  const f = (u, v) => { const qx = u + rr, qy = v + rr; return Math.min(Math.max(qx, qy), 0) + len2(Math.max(qx, 0), Math.max(qy, 0)) - rr; };
  if (axis === 'x') return node((x, y, z) => f(len2(y - cy, z - cz) - r, Math.abs(x - mid) - hl), [mid - hl, cy - r, cz - r, mid + hl, cy + r, cz + r]);
  if (axis === 'y') return node((x, y, z) => f(len2(x - cx, z - cz) - r, Math.abs(y - mid) - hl), [cx - r, mid - hl, cz - r, cx + r, mid + hl, cz + r]);
  return node((x, y, z) => f(len2(x - cx, y - cy) - r, Math.abs(z - mid) - hl), [cx - r, cy - r, mid - hl, cx + r, cy + r, mid + hl]);
}
function torus(axis, cx, cy, cz, R, r) {
  const e = R + r;
  if (axis === 'x') return node((x, y, z) => len2(len2(y - cy, z - cz) - R, x - cx) - r, [cx - r, cy - e, cz - e, cx + r, cy + e, cz + e]);
  if (axis === 'y') return node((x, y, z) => len2(len2(x - cx, z - cz) - R, y - cy) - r, [cx - e, cy - r, cz - e, cx + e, cy + r, cz + e]);
  return node((x, y, z) => len2(len2(x - cx, y - cy) - R, z - cz) - r, [cx - e, cy - e, cz - r, cx + e, cy + e, cz + r]);
}
const custom = (f, bb) => node(f, bb || INF_BB);

// ------------------------------------------------------------ opérations
// Union (lissée si k > 0). Les enfants hors de portée sont ignorés grâce à leurs boîtes englobantes.
function union(list, k = 0, labeled = false) {
  list = list.filter(Boolean);
  if (list.length === 1 && !labeled) return list[0];
  const n = list.length, fs = list.map((c) => c.f), bbs = list.map((c) => c.bb);
  const bb = [BIG, BIG, BIG, -BIG, -BIG, -BIG];
  for (const b of bbs) for (let i = 0; i < 3; i++) { bb[i] = Math.min(bb[i], b[i] - k); bb[i + 3] = Math.max(bb[i + 3], b[i + 3] + k); }
  const f = (x, y, z) => {
    let d = BIG;
    for (let i = 0; i < n; i++) {
      if (d < BIG && bbDist(bbs[i], x, y, z) > d + k) continue;
      const di = fs[i](x, y, z);
      d = k > 0 ? smin(d, di, k) : Math.min(d, di);
    }
    return d;
  };
  const label = labeled ? (x, y, z) => {
    let best = BIG, bi = 0;
    for (let i = 0; i < n; i++) { if (bbDist(bbs[i], x, y, z) > best) continue; const di = fs[i](x, y, z); if (di < best) { best = di; bi = i; } }
    return bi;
  } : null;
  return node(f, bb, label);
}
function inter(list, k = 0) {
  list = list.filter(Boolean);
  const fs = list.map((c) => c.f), bb = [-BIG, -BIG, -BIG, BIG, BIG, BIG];
  for (const c of list) for (let i = 0; i < 3; i++) { bb[i] = Math.max(bb[i], c.bb[i]); bb[i + 3] = Math.min(bb[i + 3], c.bb[i + 3]); }
  return node((x, y, z) => { let d = -BIG; for (const f of fs) d = k > 0 ? smax(d, f(x, y, z), k) : Math.max(d, f(x, y, z)); return d; }, bb, list[0].label);
}
// a privé de b ; b n'est évalué que près de sa boîte
function sub(a, b, k = 0) {
  if (!b) return a;
  const fa = a.f, fb = b.f, bbb = b.bb;
  return node((x, y, z) => {
    const da = fa(x, y, z);
    if (bbDist(bbb, x, y, z) > -da + k) return da; // b trop loin pour changer le résultat
    const db = fb(x, y, z);
    return k > 0 ? smax(da, -db, k) : Math.max(da, -db);
  }, a.bb, a.label);
}
// Repère : p_monde = M·p_local + t (M orthonormée, ligne par ligne)
function xform(n, M, t) {
  const f = n.f, lbl = n.label;
  const loc = (x, y, z) => { const X = x - t[0], Y = y - t[1], Z = z - t[2]; return [M[0] * X + M[3] * Y + M[6] * Z, M[1] * X + M[4] * Y + M[7] * Z, M[2] * X + M[5] * Y + M[8] * Z]; };
  let bb = INF_BB;
  if (n.bb[0] > -BIG / 2) {
    bb = [BIG, BIG, BIG, -BIG, -BIG, -BIG];
    for (let c = 0; c < 8; c++) {
      const p = [n.bb[c & 1 ? 3 : 0], n.bb[c & 2 ? 4 : 1], n.bb[c & 4 ? 5 : 2]];
      const w = [M[0] * p[0] + M[1] * p[1] + M[2] * p[2] + t[0], M[3] * p[0] + M[4] * p[1] + M[5] * p[2] + t[1], M[6] * p[0] + M[7] * p[1] + M[8] * p[2] + t[2]];
      for (let i = 0; i < 3; i++) { bb[i] = Math.min(bb[i], w[i]); bb[i + 3] = Math.max(bb[i + 3], w[i]); }
    }
  }
  return node((x, y, z) => { const l = loc(x, y, z); return f(l[0], l[1], l[2]); }, bb, lbl ? (x, y, z) => { const l = loc(x, y, z); return lbl(l[0], l[1], l[2]); } : null);
}
function rot(axis, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  if (axis === 'x') return [1, 0, 0, 0, c, -s, 0, s, c];
  if (axis === 'y') return [c, 0, s, 0, 1, 0, -s, 0, c];
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}
function mirrorX(n) {
  const f = n.f, m = Math.max(Math.abs(n.bb[0]), Math.abs(n.bb[3]));
  return node((x, y, z) => f(Math.abs(x), y, z), [-m, n.bb[1], n.bb[2], m, n.bb[4], n.bb[5]], n.label ? (x, y, z) => n.label(Math.abs(x), y, z) : null);
}
function scale(n, sx, sy, sz) {
  const f = n.f, m = Math.min(sx, sy, sz);
  return node((x, y, z) => f(x / sx, y / sy, z / sz) * m, [n.bb[0] * sx, n.bb[1] * sy, n.bb[2] * sz, n.bb[3] * sx, n.bb[4] * sy, n.bb[5] * sz], n.label ? (x, y, z) => n.label(x / sx, y / sy, z / sz) : null);
}
const offset = (n, r) => node((x, y, z) => n.f(x, y, z) - r, bbPad(n.bb, Math.max(0, r)), n.label);
const clip = (n, bb) => node(n.f, bb, n.label);

// ------------------------------------------------------------ mailleur
function meshSDF(nd, opts = {}) {
  const bb = opts.bb || nd.bb;
  const ext = Math.max(bb[3] - bb[0], bb[4] - bb[1], bb[5] - bb[2]);
  const h = opts.h || ext / (opts.res || 128);
  const pad = 3 * h;
  const ox = bb[0] - pad, oy = bb[1] - pad, oz = bb[2] - pad;
  const NX = Math.ceil((bb[3] - bb[0] + 2 * pad) / h) + 1, NY = Math.ceil((bb[4] - bb[1] + 2 * pad) / h) + 1, NZ = Math.ceil((bb[5] - bb[2] + 2 * pad) / h) + 1;
  const N = NX * NY * NZ;
  if (!(N > 0) || N > (opts.maxVoxels || 48e6)) throw new Error('Résolution trop élevée pour cette pièce (' + Math.round(N / 1e6) + ' M voxels) : baissez la résolution.');
  const f = nd.f, sdf = new Float32Array(N), SXY = NX * NY, B = 4;
  const thr = (B - 1) * h * 0.8661 + 2 * h;
  let exact = 0;
  for (let k0 = 0; k0 < NZ; k0 += B) {
    const k1 = Math.min(NZ, k0 + B), zc = oz + (k0 + (k1 - k0 - 1) / 2) * h;
    for (let j0 = 0; j0 < NY; j0 += B) {
      const j1 = Math.min(NY, j0 + B), yc = oy + (j0 + (j1 - j0 - 1) / 2) * h;
      for (let i0 = 0; i0 < NX; i0 += B) {
        const i1 = Math.min(NX, i0 + B), xc = ox + (i0 + (i1 - i0 - 1) / 2) * h;
        const dc = f(xc, yc, zc);
        if (Math.abs(dc) > thr) {
          for (let k = k0; k < k1; k++) for (let j = j0; j < j1; j++) { const o = k * SXY + j * NX; sdf.fill(dc, o + i0, o + i1); }
        } else {
          for (let k = k0; k < k1; k++) { const z = oz + k * h; for (let j = j0; j < j1; j++) { const y = oy + j * h, o = k * SXY + j * NX; for (let i = i0; i < i1; i++) sdf[o + i] = f(ox + i * h, y, z); } }
          exact += (k1 - k0) * (j1 - j0) * (i1 - i0);
        }
      }
    }
  }
  const net = Core.surfaceNets(sdf, NX, NY, NZ, ox, oy, oz, h);
  const nt = net.idx.length / 3, groups = new Uint32Array(nt);
  if (nd.label && nt) {
    const lab = new Uint32Array(net.nv), P = net.pos;
    for (let v = 0; v < net.nv; v++) lab[v] = nd.label(P[3 * v], P[3 * v + 1], P[3 * v + 2]);
    for (let t = 0; t < nt; t++) { const a = lab[net.idx[3 * t]], b = lab[net.idx[3 * t + 1]], c = lab[net.idx[3 * t + 2]]; groups[t] = b === c ? b : a; }
  }
  return { pos: net.pos, idx: net.idx, nv: net.nv, groups, info: { h, voxels: N, exact } };
}

// ------------------------------------------------------------ maillages explicites
// Anneau elliptique (demi-axes A, B de l'âme) de fil r, dans le plan XY
function ringMesh(A, B, r, nu = 24, nv = 10) {
  const pos = new Float32Array(nu * nv * 3), idx = new Uint32Array(nu * nv * 6);
  let o = 0;
  for (let i = 0; i < nu; i++) {
    const u = (i / nu) * Math.PI * 2, cx = A * Math.cos(u), cy = B * Math.sin(u);
    let tx = -A * Math.sin(u), ty = B * Math.cos(u); const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
    const nx = ty, ny = -tx;
    for (let j = 0; j < nv; j++) {
      const v = (j / nv) * Math.PI * 2, c = Math.cos(v) * r, s = Math.sin(v) * r;
      pos[o++] = cx + nx * c; pos[o++] = cy + ny * c; pos[o++] = s;
    }
  }
  let q = 0;
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const a = i * nv + j, b = ((i + 1) % nu) * nv + j, c = ((i + 1) % nu) * nv + (j + 1) % nv, d = i * nv + (j + 1) % nv;
    idx[q++] = a; idx[q++] = b; idx[q++] = c; idx[q++] = a; idx[q++] = c; idx[q++] = d;
  }
  Core.fixOrientation(pos, idx);
  return { pos, idx, nv: nu * nv, groups: new Uint32Array(idx.length / 3) };
}
// Cylindre fermé entre deux points
function cylinderMesh(a, b, r, n = 20) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L = Math.hypot(d[0], d[1], d[2]) || 1;
  const t = [d[0] / L, d[1] / L, d[2] / L];
  let u = Math.abs(t[0]) < 0.9 ? [0, -t[2], t[1]] : [-t[2], 0, t[0]]; const ul = Math.hypot(u[0], u[1], u[2]); u = u.map((x) => x / ul);
  const w = [t[1] * u[2] - t[2] * u[1], t[2] * u[0] - t[0] * u[2], t[0] * u[1] - t[1] * u[0]];
  const pos = new Float32Array((2 * n + 2) * 3); let o = 0;
  for (const P of [a, b]) for (let k = 0; k < n; k++) { const ang = (k / n) * Math.PI * 2, c = Math.cos(ang) * r, s = Math.sin(ang) * r; pos[o++] = P[0] + u[0] * c + w[0] * s; pos[o++] = P[1] + u[1] * c + w[1] * s; pos[o++] = P[2] + u[2] * c + w[2] * s; }
  pos.set(a, o); pos.set(b, o + 3);
  const idx = []; const ca = 2 * n, cb = 2 * n + 1;
  for (let k = 0; k < n; k++) { const k2 = (k + 1) % n; idx.push(k, k2, n + k2, k, n + k2, n + k, ca, k2, k, cb, n + k, n + k2); }
  const I = new Uint32Array(idx); Core.fixOrientation(pos, I);
  return { pos, idx: I, nv: 2 * n + 2, groups: new Uint32Array(I.length / 3) };
}
// p' = M·p + t (M ligne par ligne)
function xformMesh(m, M, t) {
  const P = new Float32Array(m.pos.length);
  for (let i = 0; i < P.length; i += 3) {
    const x = m.pos[i], y = m.pos[i + 1], z = m.pos[i + 2];
    P[i] = M[0] * x + M[1] * y + M[2] * z + t[0]; P[i + 1] = M[3] * x + M[4] * y + M[5] * z + t[1]; P[i + 2] = M[6] * x + M[7] * y + M[8] * z + t[2];
  }
  return { pos: P, idx: m.idx, nv: m.nv, groups: m.groups };
}
// Repère à partir de trois axes (colonnes X, Y, Z locales exprimées en monde)
const frameM = (X, Y, Z) => [X[0], Y[0], Z[0], X[1], Y[1], Z[1], X[2], Y[2], Z[2]];
function rotateMesh(m, axis, center, ang) {
  const R = rot(axis, ang), c = center;
  const t = [c[0] - (R[0] * c[0] + R[1] * c[1] + R[2] * c[2]), c[1] - (R[3] * c[0] + R[4] * c[1] + R[5] * c[2]), c[2] - (R[6] * c[0] + R[7] * c[1] + R[8] * c[2])];
  return xformMesh(m, R, t);
}
const translateMesh = (m, d) => xformMesh(m, [1, 0, 0, 0, 1, 0, 0, 0, 1], d);
function mergeMeshes(list, groupPer = 'keep') {
  let nv = 0, ni = 0; for (const m of list) { nv += m.nv; ni += m.idx.length; }
  const pos = new Float32Array(nv * 3), idx = new Uint32Array(ni), groups = new Uint32Array(ni / 3);
  let ov = 0, oi = 0, g0 = 0;
  list.forEach((m, k) => {
    pos.set(m.pos.subarray(0, m.nv * 3), ov * 3);
    for (let i = 0; i < m.idx.length; i++) idx[oi + i] = m.idx[i] + ov;
    const nt = m.idx.length / 3; let mg = 0;
    for (let t = 0; t < nt; t++) { const g = groupPer === 'piece' ? k : groupPer === 'alternate' ? k % 2 : (m.groups ? m.groups[t] : 0) + g0; groups[oi / 3 + t] = g; if (g > mg) mg = g; }
    if (groupPer === 'keep') g0 = mg + 1;
    ov += m.nv; oi += m.idx.length;
  });
  return { pos, idx, nv, groups };
}
function mirrorMeshX(m, dx = 0) {
  const P = new Float32Array(m.pos.length);
  for (let i = 0; i < P.length; i += 3) { P[i] = -m.pos[i] + dx; P[i + 1] = m.pos[i + 1]; P[i + 2] = m.pos[i + 2]; }
  const I = new Uint32Array(m.idx.length);
  for (let t = 0; t < I.length; t += 3) { I[t] = m.idx[t]; I[t + 1] = m.idx[t + 2]; I[t + 2] = m.idx[t + 1]; }
  return { pos: P, idx: I, nv: m.nv, groups: m.groups };
}
function meshBounds(m) {
  const b = [BIG, BIG, BIG, -BIG, -BIG, -BIG];
  for (let i = 0; i < m.nv * 3; i += 3) for (let k = 0; k < 3; k++) { b[k] = Math.min(b[k], m.pos[i + k]); b[k + 3] = Math.max(b[k + 3], m.pos[i + k]); }
  return b;
}

const SDF = {
  BIG, INF_BB, clamp, smooth01, smin, smax, node, bbPad, bbDist,
  roundRect2, ellipse2, octagon2, shape2D,
  sphere, ellipsoid, box, boxMM, roundCone, capsule, cyl, torus, custom,
  union, inter, sub, xform, rot, mirrorX, scale, offset, clip,
  meshSDF, ringMesh, cylinderMesh, xformMesh, frameM, rotateMesh, translateMesh, mergeMeshes, mirrorMeshX, meshBounds,
};
root.SDF = SDF;
if (typeof module !== 'undefined' && module.exports) module.exports = SDF;
})(typeof window !== 'undefined' ? window : globalThis);
