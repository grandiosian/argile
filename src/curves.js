/* Argile — courbes de Bézier 3D : ajustement sur un tracé, édition, profils,
 * balayage en cylindre (curve tube) et forme plane vers solide (SDF + surface nets). */
(function (root) {
'use strict';
const Core = root.Core || require('./core.js');

// ------------------------------------------------------------ vecteurs
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a); return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; };
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const anyPerp = (t) => norm(Math.abs(t[0]) < 0.9 ? cross(t, [1, 0, 0]) : cross(t, [0, 1, 0]));

// ------------------------------------------------------------ modèle
let _id = 1;
const DEFAULTS = {
  shape: { thickness: 0.12, bevel: 0.02, inflate: 0, anchor: 'center', res: 160 },
  sweep: { profile: 'circle', profileRef: 0, sides: 16, radius: 0.06, aspect: 1, taperStart: 1, taperEnd: 1, twist: 0, rotate: 0, caps: true, density: 1 },
};
function makeCurve(kind, pts, closed, extra = {}) {
  const c = {
    id: _id++, name: extra.name || (kind === 'shape' ? 'Forme' : 'Courbe'), kind, closed: !!closed, visible: true,
    pts, plane: extra.plane || null, up: extra.up || [0, 1, 0],
    params: Object.assign({}, DEFAULTS.shape, DEFAULTS.sweep, extra.params || {}),
  };
  return c;
}
function syncIds(curves) { for (const c of curves) if (c.id >= _id) _id = c.id + 1; }
const clone = (x) => JSON.parse(JSON.stringify(x));
const anchor = (p, i, o, smooth = true) => ({ p: p.slice(), i: (i || p).slice(), o: (o || p).slice(), smooth });

// ------------------------------------------------------------ évaluation
const nSeg = (c) => (c.closed ? c.pts.length : c.pts.length - 1);
function segment(c, k) {
  const a = c.pts[k], b = c.pts[(k + 1) % c.pts.length];
  return [a.p, a.o, b.i, b.p];
}
function bez(P, t) {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
  return [a * P[0][0] + b * P[1][0] + d * P[2][0] + e * P[3][0], a * P[0][1] + b * P[1][1] + d * P[2][1] + e * P[3][1], a * P[0][2] + b * P[1][2] + d * P[2][2] + e * P[3][2]];
}
function bezD(P, t) {
  const u = 1 - t, a = 3 * u * u, b = 6 * u * t, e = 3 * t * t;
  return [0, 1, 2].map((k) => a * (P[1][k] - P[0][k]) + b * (P[2][k] - P[1][k]) + e * (P[3][k] - P[2][k]));
}
function bezDD(P, t) {
  const u = 1 - t;
  return [0, 1, 2].map((k) => 6 * u * (P[2][k] - 2 * P[1][k] + P[0][k]) + 6 * t * (P[3][k] - 2 * P[2][k] + P[1][k]));
}
// Polyligne dense : `per` échantillons par segment (au moins), points de jonction non dupliqués
function polyline(c, per = 24) {
  const out = []; const ns = nSeg(c);
  if (c.pts.length === 1) return [c.pts[0].p.slice()];
  for (let k = 0; k < ns; k++) {
    const P = segment(c, k);
    const L = len(sub(P[1], P[0])) + len(sub(P[2], P[1])) + len(sub(P[3], P[2]));
    const n = Math.max(2, Math.min(256, Math.ceil(per * Math.max(1, L / (len(sub(P[3], P[0])) + 1e-9)))));
    for (let i = 0; i < n; i++) out.push(bez(P, i / n));
  }
  if (!c.closed) out.push(c.pts[c.pts.length - 1].p.slice());
  return out;
}
function polyLength(pts, closed) {
  let L = 0; for (let i = 1; i < pts.length; i++) L += len(sub(pts[i], pts[i - 1]));
  if (closed && pts.length > 2) L += len(sub(pts[0], pts[pts.length - 1]));
  return L;
}
// Rééchantillonnage uniforme en longueur d'arc : n points (fermé : sans répéter le premier)
function resample(pts, n, closed) {
  const P = closed ? pts.concat([pts[0]]) : pts;
  const cum = [0]; for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + len(sub(P[i], P[i - 1])));
  const L = cum[cum.length - 1]; const out = [];
  const m = closed ? n : n - 1; let j = 0;
  for (let q = 0; q < n; q++) {
    const s = m > 0 ? (q / m) * L : 0;
    while (j < P.length - 2 && cum[j + 1] < s) j++;
    const seg = cum[j + 1] - cum[j]; const t = seg > 1e-12 ? (s - cum[j]) / seg : 0;
    out.push(lerp(P[j], P[j + 1], Math.min(1, Math.max(0, t))));
  }
  return out;
}
function curveLength(c) { return polyLength(polyline(c, 16), c.closed); }

// ------------------------------------------------------------ édition
// Coupe le segment k en t (de Casteljau) et insère une ancre ; renvoie l'index de la nouvelle ancre
function splitAt(c, k, t) {
  const [p0, p1, p2, p3] = segment(c, k);
  const a = lerp(p0, p1, t), b = lerp(p1, p2, t), d = lerp(p2, p3, t);
  const e = lerp(a, b, t), f = lerp(b, d, t), g = lerp(e, f, t);
  const A = c.pts[k], B = c.pts[(k + 1) % c.pts.length];
  A.o = a; B.i = d;
  c.pts.splice(k + 1, 0, anchor(g, e, f, true));
  return k + 1;
}
function removeAnchor(c, idx) {
  const min = c.closed ? 3 : 2;
  if (c.pts.length <= min) return false;
  c.pts.splice(idx, 1); return true;
}
// Rend une ancre lisse (poignées alignées) ou anguleuse (poignées rétractées)
function setSmooth(c, idx, smooth) {
  const A = c.pts[idx]; A.smooth = smooth;
  const n = c.pts.length;
  const prev = c.closed || idx > 0 ? c.pts[(idx - 1 + n) % n] : null;
  const next = c.closed || idx < n - 1 ? c.pts[(idx + 1) % n] : null;
  if (!smooth) { A.i = A.p.slice(); A.o = A.p.slice(); return; }
  let dir = norm(sub(next ? next.p : A.p, prev ? prev.p : A.p));
  if (len(dir) < 1e-9) dir = norm(sub(A.o, A.i));
  if (len(dir) < 1e-9) return;
  const li = prev ? len(sub(A.p, prev.p)) / 3 : 0, lo = next ? len(sub(next.p, A.p)) / 3 : 0;
  A.i = sub(A.p, mul(dir, li || lo)); A.o = add(A.p, mul(dir, lo || li));
}
// Déplace une poignée ; une ancre lisse garde l'autre poignée alignée (longueur conservée)
function moveHandle(c, idx, which, pos) {
  const A = c.pts[idx]; A[which] = pos.slice();
  if (!A.smooth) return;
  const other = which === 'o' ? 'i' : 'o';
  const d = sub(A.p, pos); const l = len(sub(A[other], A.p));
  if (len(d) > 1e-12 && l > 1e-12) A[other] = add(A.p, mul(norm(d), l));
}
function moveAnchor(c, idx, pos) {
  const A = c.pts[idx], d = sub(pos, A.p);
  A.p = pos.slice(); A.i = add(A.i, d); A.o = add(A.o, d);
}
function setClosed(c, closed) {
  if (closed === c.closed) return;
  c.closed = closed;
  if (closed && c.pts.length >= 2) { const n = c.pts.length; setSmooth(c, 0, c.pts[0].smooth); setSmooth(c, n - 1, c.pts[n - 1].smooth); }
}
function translate(c, d) {
  for (const A of c.pts) { A.p = add(A.p, d); A.i = add(A.i, d); A.o = add(A.o, d); }
  if (c.plane) c.plane.o = add(c.plane.o, d);
}
// Recherche du point de la courbe le plus proche d'une position écran ; project(p) → [x, y] | null
function nearest(c, project, x, y, steps = 32) {
  let best = { d: Infinity, k: -1, t: 0 };
  const ns = nSeg(c);
  for (let k = 0; k < ns; k++) {
    const P = segment(c, k);
    let prev = null;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, q = project(bez(P, t));
      if (q && prev) {
        const dx = q[0] - prev[0], dy = q[1] - prev[1], l2 = dx * dx + dy * dy;
        let u = l2 > 0 ? ((x - prev[0]) * dx + (y - prev[1]) * dy) / l2 : 0; u = Math.max(0, Math.min(1, u));
        const ex = prev[0] + dx * u - x, ey = prev[1] + dy * u - y, d = Math.hypot(ex, ey);
        if (d < best.d) best = { d, k, t: (i - 1 + u) / steps };
      }
      prev = q;
    }
  }
  return best;
}

// ------------------------------------------------------------ plan moyen (ACP)
function fitPlane(points, hint) {
  const n = points.length; let o = [0, 0, 0];
  for (const p of points) o = add(o, p); o = mul(o, 1 / Math.max(1, n));
  const C = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const p of points) { const d = sub(p, o); for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) C[r * 3 + s] += d[r] * d[s]; }
  const mv = (M, v) => [M[0] * v[0] + M[1] * v[1] + M[2] * v[2], M[3] * v[0] + M[4] * v[1] + M[5] * v[2], M[6] * v[0] + M[7] * v[1] + M[8] * v[2]];
  const power = (M, seed) => { let v = norm(seed); for (let i = 0; i < 64; i++) { const w = mv(M, v); const l = len(w); if (l < 1e-18) break; v = mul(w, 1 / l); } return v; };
  let e1 = power(C, [1, 0.37, 0.21]); const l1 = dot(e1, mv(C, e1));
  const C2 = C.map((x, i) => x - l1 * e1[(i / 3) | 0] * e1[i % 3]);
  let e2 = power(C2, anyPerp(e1)); e2 = norm(sub(e2, mul(e1, dot(e1, e2))));
  let nn = norm(cross(e1, e2));
  if (len(nn) < 0.5 || dot(e2, mv(C, e2)) < 1e-14) { nn = norm(hint || [0, 0, 1]); e1 = anyPerp(nn); }
  if (hint && dot(nn, hint) < 0) nn = mul(nn, -1);
  const u = norm(sub(e1, mul(nn, dot(e1, nn)))); const v = cross(nn, u);
  return { o, u, v, n: nn };
}
const toPlane = (pl, p) => { const d = sub(p, pl.o); return [dot(d, pl.u), dot(d, pl.v)]; };
const fromPlane = (pl, x, y, z = 0) => add(add(add(pl.o, mul(pl.u, x)), mul(pl.v, y)), mul(pl.n, z));
const projectOnPlane = (pl, p) => sub(p, mul(pl.n, dot(sub(p, pl.o), pl.n)));
function flattenToPlane(c) {
  if (!c.plane) return;
  for (const A of c.pts) { A.p = projectOnPlane(c.plane, A.p); A.i = projectOnPlane(c.plane, A.i); A.o = projectOnPlane(c.plane, A.o); }
}

// ------------------------------------------------------------ ajustement de Bézier (Schneider, Graphics Gems I)
function fitPath(raw, tol, closed, cornerDeg = 55) {
  // nettoyage + rééchantillonnage régulier
  let pts = [];
  for (const p of raw) if (!pts.length || len(sub(p, pts[pts.length - 1])) > tol * 0.05) pts.push(p);
  if (closed && pts.length > 3 && len(sub(pts[0], pts[pts.length - 1])) < tol * 2) pts.pop();
  if (pts.length < 2) return null;
  const L = polyLength(pts, closed);
  const spacing = Math.max(tol * 0.6, L / 2000);
  const n = Math.max(closed ? 6 : 3, Math.round(L / spacing) + (closed ? 0 : 1));
  pts = resample(pts, n, closed);
  // coins : angle de rotation sur une fenêtre de w échantillons
  const w = 3, cosT = Math.cos(cornerDeg * Math.PI / 180), N = pts.length;
  const at = (i) => pts[closed ? ((i % N) + N) % N : Math.max(0, Math.min(N - 1, i))];
  const score = new Float32Array(N), corners = [];
  for (let i = 0; i < N; i++) {
    if (!closed && (i < w || i > N - 1 - w)) { score[i] = 1; continue; }
    score[i] = dot(norm(sub(at(i), at(i - w))), norm(sub(at(i + w), at(i))));
  }
  for (let i = 0; i < N; i++) {
    if (score[i] > cosT) continue;
    let isMin = true; for (let k = -w; k <= w; k++) if (k && score[closed ? (i + k + N) % N : Math.max(0, Math.min(N - 1, i + k))] < score[i]) isMin = false;
    if (isMin && (!corners.length || i - corners[corners.length - 1] > w)) corners.push(i);
  }
  if (closed && corners.length > 1 && corners[0] + N - corners[corners.length - 1] <= w) corners.pop();
  // découpage en tronçons entre coins
  const beziers = []; const cornerFlags = [];
  const tanAt = (arr, i, dir) => { let t = [0, 0, 0]; for (let k = 1; k <= 3; k++) { const j = i + dir * k; if (j < 0 || j >= arr.length) break; t = add(t, norm(sub(arr[j], arr[i]))); } return norm(t); };
  const runs = [];
  if (!closed) {
    const cuts = [0, ...corners.filter((i) => i > 0 && i < N - 1), N - 1];
    for (let q = 0; q + 1 < cuts.length; q++) runs.push({ arr: pts.slice(cuts[q], cuts[q + 1] + 1), startCorner: q > 0, t1: null, t2: null });
  } else if (corners.length) {
    for (let q = 0; q < corners.length; q++) {
      const a = corners[q], b = corners[(q + 1) % corners.length];
      const arr = []; for (let i = a; ; i = (i + 1) % N) { arr.push(pts[i]); if (i === b && arr.length > 1) break; if (arr.length > N + 1) break; }
      runs.push({ arr, startCorner: true, t1: null, t2: null });
    }
  } else {
    const arr = pts.concat([pts[0]]);
    const tc = norm(sub(pts[1], pts[N - 1]));
    runs.push({ arr, startCorner: false, t1: tc, t2: mul(tc, -1) });
  }
  for (const r of runs) {
    if (r.arr.length < 2) continue;
    const t1 = r.t1 || tanAt(r.arr, 0, 1), t2 = r.t2 || tanAt(r.arr, r.arr.length - 1, -1);
    const segs = []; fitCubic(r.arr, 0, r.arr.length - 1, t1, t2, tol, segs);
    segs.forEach((s, q) => { beziers.push(s); cornerFlags.push(q === 0 && r.startCorner); });
  }
  if (!beziers.length) return null;
  const out = [];
  beziers.forEach((B, q) => {
    if (q === 0) out.push(anchor(B[0], B[0], B[1], !cornerFlags[0]));
    else { const A = out[out.length - 1]; A.o = B[1]; A.smooth = !cornerFlags[q]; }
    out.push(anchor(B[3], B[2], B[3], true));
  });
  if (closed) { const last = out.pop(); out[0].i = last.i; out[0].smooth = !cornerFlags[0]; }
  else { out[0].smooth = true; out[out.length - 1].smooth = true; }
  return out;
}
function fitCubic(d, first, last, t1, t2, err, out, depth = 0) {
  const nPts = last - first + 1;
  if (nPts === 2) {
    const dist = len(sub(d[last], d[first])) / 3;
    out.push([d[first], add(d[first], mul(t1, dist)), add(d[last], mul(t2, dist)), d[last]]);
    return;
  }
  let u = chordParam(d, first, last);
  let B = generateBezier(d, first, last, u, t1, t2);
  let [maxErr, split] = maxError(d, first, last, B, u);
  if (maxErr < err) { out.push(B); return; }
  if (maxErr < err * 4) {
    for (let it = 0; it < 6; it++) {
      u = reparam(d, first, last, u, B);
      B = generateBezier(d, first, last, u, t1, t2);
      [maxErr, split] = maxError(d, first, last, B, u);
      if (maxErr < err) { out.push(B); return; }
    }
  }
  if (depth > 40) { out.push(B); return; }
  split = Math.max(first + 1, Math.min(last - 1, split));
  let tc = norm(sub(d[split - 1], d[split + 1]));
  if (len(tc) < 1e-9) tc = norm(sub(d[first], d[last]));
  fitCubic(d, first, split, t1, tc, err, out, depth + 1);
  fitCubic(d, split, last, mul(tc, -1), t2, err, out, depth + 1);
}
function chordParam(d, first, last) {
  const u = [0];
  for (let i = first + 1; i <= last; i++) u.push(u[u.length - 1] + len(sub(d[i], d[i - 1])));
  const L = u[u.length - 1] || 1; return u.map((x) => x / L);
}
function generateBezier(d, first, last, u, t1, t2) {
  const p0 = d[first], p3 = d[last];
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i < u.length; i++) {
    const t = u[i], s = 1 - t;
    const b0 = s * s * s, b1 = 3 * t * s * s, b2 = 3 * t * t * s, b3 = t * t * t;
    const A1 = mul(t1, b1), A2 = mul(t2, b2);
    c00 += dot(A1, A1); c01 += dot(A1, A2); c11 += dot(A2, A2);
    const tmp = sub(d[first + i], add(mul(p0, b0 + b1), mul(p3, b2 + b3)));
    x0 += dot(A1, tmp); x1 += dot(A2, tmp);
  }
  const det = c00 * c11 - c01 * c01;
  let a1 = det !== 0 ? (x0 * c11 - c01 * x1) / det : 0, a2 = det !== 0 ? (c00 * x1 - c01 * x0) / det : 0;
  const segLen = len(sub(p3, p0)), eps = 1e-6 * segLen;
  if (!(a1 >= eps) || !(a2 >= eps) || a1 > segLen * 2 || a2 > segLen * 2) { a1 = a2 = segLen / 3; }
  return [p0, add(p0, mul(t1, a1)), add(p3, mul(t2, a2)), p3];
}
function maxError(d, first, last, B, u) {
  let m = 0, split = (first + last) >> 1;
  for (let i = first + 1; i < last; i++) { const e = len(sub(bez(B, u[i - first]), d[i])); if (e > m) { m = e; split = i; } }
  return [m, split];
}
function reparam(d, first, last, u, B) {
  return u.map((t, i) => {
    const p = d[first + i], q = sub(bez(B, t), p), q1 = bezD(B, t), q2 = bezDD(B, t);
    const num = dot(q, q1), den = dot(q1, q1) + dot(q, q2);
    const nt = den !== 0 ? t - num / den : t;
    return Math.max(0, Math.min(1, nt));
  });
}

// ------------------------------------------------------------ polygones 2D
function area2(poly) { let a = 0; for (let i = 0, n = poly.length; i < n; i++) { const p = poly[i], q = poly[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; }
function earClip(poly) { // poly CCW, renvoie une liste d'indices de triangles
  const n = poly.length; const idx = []; for (let i = 0; i < n; i++) idx.push(i);
  const tris = []; let guard = 0;
  const cr = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inTri = (p, a, b, c) => cr(a, b, p) >= 0 && cr(b, c, p) >= 0 && cr(c, a, p) >= 0;
  while (idx.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const ia = idx[(k - 1 + idx.length) % idx.length], ib = idx[k], ic = idx[(k + 1) % idx.length];
      const a = poly[ia], b = poly[ib], c = poly[ic];
      if (cr(a, b, c) <= 1e-14) continue;
      let ok = true;
      for (const j of idx) { if (j === ia || j === ib || j === ic) continue; if (inTri(poly[j], a, b, c)) { ok = false; break; } }
      if (!ok) continue;
      tris.push(ia, ib, ic); idx.splice(k, 1); clipped = true; break;
    }
    if (!clipped) { // polygone dégénéré : éventail de secours
      for (let k = 1; k + 1 < idx.length; k++) tris.push(idx[0], idx[k], idx[k + 1]);
      return tris;
    }
  }
  if (idx.length === 3) tris.push(idx[0], idx[1], idx[2]);
  return tris;
}

// ------------------------------------------------------------ profils (unitaires, sens trigonométrique)
const PROFILES = [
  { id: 'circle', label: 'Cercle' }, { id: 'square', label: 'Carré' }, { id: 'rounded', label: 'Carré arrondi' },
  { id: 'triangle', label: 'Triangle' }, { id: 'hexagon', label: 'Hexagone' }, { id: 'star', label: 'Étoile' },
  { id: 'half', label: 'Demi-rond' }, { id: 'diamond', label: 'Losange' }, { id: 'shape', label: 'Forme dessinée' },
];
function polyFromCorners(corners, total) {
  const n = corners.length, per = Math.max(1, Math.round(total / n)), out = [];
  for (let i = 0; i < n; i++) { const a = corners[i], b = corners[(i + 1) % n]; for (let k = 0; k < per; k++) out.push([a[0] + (b[0] - a[0]) * k / per, a[1] + (b[1] - a[1]) * k / per]); }
  return out;
}
function profilePoly(type, sides, shapeCurve) {
  sides = Math.max(3, Math.min(128, sides | 0));
  const ring = (n, f) => Array.from({ length: n }, (_, i) => f((i / n) * Math.PI * 2));
  let P;
  switch (type) {
    case 'square': P = polyFromCorners([[-1, -1], [1, -1], [1, 1], [-1, 1]], Math.max(4, sides)); break;
    case 'rounded': P = ring(Math.max(16, sides), (a) => { const c = Math.cos(a), s = Math.sin(a); return [Math.sign(c) * Math.pow(Math.abs(c), 0.5), Math.sign(s) * Math.pow(Math.abs(s), 0.5)]; }); break;
    case 'triangle': P = polyFromCorners([0, 1, 2].map((i) => [Math.cos(-Math.PI / 2 + i * 2 * Math.PI / 3), Math.sin(-Math.PI / 2 + i * 2 * Math.PI / 3)]), Math.max(3, sides)); break;
    case 'hexagon': P = polyFromCorners([0, 1, 2, 3, 4, 5].map((i) => [Math.cos(i * Math.PI / 3), Math.sin(i * Math.PI / 3)]), Math.max(6, sides)); break;
    case 'diamond': P = polyFromCorners([[0, -1], [1, 0], [0, 1], [-1, 0]], Math.max(4, sides)); break;
    case 'star': P = polyFromCorners(Array.from({ length: 10 }, (_, i) => { const r = i % 2 ? 0.45 : 1, a = Math.PI / 2 + i * Math.PI / 5; return [r * Math.cos(a), r * Math.sin(a)]; }), Math.max(10, sides)); break;
    case 'half': {
      const n = Math.max(8, sides); P = [];
      const arc = Math.ceil(n * 0.7), flat = Math.max(2, n - arc);
      for (let i = 0; i <= arc; i++) { const a = (i / arc) * Math.PI; P.push([Math.cos(a), Math.sin(a) * 1.0 - 0.4]); }
      for (let i = 1; i < flat; i++) P.push([-1 + 2 * i / flat, -0.4]);
      break;
    }
    case 'shape': {
      if (shapeCurve && shapeCurve.plane && shapeCurve.pts.length >= 2) {
        const pl = shapeCurve.plane; const c2 = { ...shapeCurve, closed: true };
        const poly = resample(polyline(c2, 24), Math.max(12, sides), true).map((p) => toPlane(pl, p));
        let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
        for (const [x, y] of poly) { mnx = Math.min(mnx, x); mxx = Math.max(mxx, x); mny = Math.min(mny, y); mxy = Math.max(mxy, y); }
        const cx = (mnx + mxx) / 2, cy = (mny + mxy) / 2, s = Math.max(mxx - mnx, mxy - mny) / 2 || 1;
        P = poly.map(([x, y]) => [(x - cx) / s, (y - cy) / s]);
        break;
      }
      P = ring(sides, (a) => [Math.cos(a), Math.sin(a)]); break;
    }
    default: P = ring(sides, (a) => [Math.cos(a), Math.sin(a)]);
  }
  if (area2(P) < 0) P.reverse();
  return P;
}

// ------------------------------------------------------------ balayage : courbe → cylindre extrudé
function sweepMesh(c, opts = {}) {
  const pr = c.params;
  if (c.pts.length < 2) return null;
  const prof = profilePoly(pr.profile, pr.sides, opts.profileCurve);
  const m = prof.length;
  const radius = Math.max(1e-5, pr.radius), w = radius * Math.max(0.05, pr.aspect), h = radius;
  const dense = polyline(c, 32);
  const L = polyLength(dense, c.closed);
  if (L < 1e-9) return null;
  const step = Math.max(L / 6000, (radius * 0.35) / Math.max(0.1, pr.density));
  const n = Math.max(c.closed ? 6 : 2, Math.min(6000, Math.round(L / step) + (c.closed ? 0 : 1)));
  const P = resample(dense, n, c.closed);
  const T = P.map((p, i) => {
    const a = c.closed ? P[(i - 1 + n) % n] : P[Math.max(0, i - 1)], b = c.closed ? P[(i + 1) % n] : P[Math.min(n - 1, i + 1)];
    let t = norm(sub(b, a)); if (len(t) < 0.5) t = [1, 0, 0]; return t;
  });
  // repères par transport parallèle (double réflexion, Wang et al. 2008)
  const N = new Array(n);
  let n0 = sub(c.up || [0, 1, 0], mul(T[0], dot(c.up || [0, 1, 0], T[0])));
  N[0] = len(n0) > 1e-6 ? norm(n0) : anyPerp(T[0]);
  for (let i = 0; i + 1 < n; i++) {
    const v1 = sub(P[i + 1], P[i]), c1 = dot(v1, v1);
    if (c1 < 1e-20) { N[i + 1] = N[i]; continue; }
    const rL = sub(N[i], mul(v1, 2 * dot(v1, N[i]) / c1)), tL = sub(T[i], mul(v1, 2 * dot(v1, T[i]) / c1));
    const v2 = sub(T[i + 1], tL), c2 = dot(v2, v2);
    let ni = c2 > 1e-20 ? sub(rL, mul(v2, 2 * dot(v2, rL) / c2)) : rL;
    ni = norm(sub(ni, mul(T[i + 1], dot(ni, T[i + 1]))));
    N[i + 1] = len(ni) > 0.5 ? ni : anyPerp(T[i + 1]);
  }
  // fermeture : répartit l'écart angulaire le long de la boucle
  let closure = 0;
  if (c.closed) {
    const v1 = sub(P[0], P[n - 1]), c1 = dot(v1, v1);
    let nn = N[n - 1];
    if (c1 > 1e-20) {
      const rL = sub(N[n - 1], mul(v1, 2 * dot(v1, N[n - 1]) / c1)), tL = sub(T[n - 1], mul(v1, 2 * dot(v1, T[n - 1]) / c1));
      const v2 = sub(T[0], tL), c2 = dot(v2, v2);
      nn = norm(c2 > 1e-20 ? sub(rL, mul(v2, 2 * dot(v2, rL) / c2)) : rL);
    }
    const b0 = cross(T[0], N[0]);
    closure = Math.atan2(dot(nn, b0), dot(nn, N[0]));
  }
  const pos = new Float32Array(n * m * 3); let o = 0;
  const twist = (pr.twist || 0) * Math.PI / 180, rot0 = (pr.rotate || 0) * Math.PI / 180;
  for (let i = 0; i < n; i++) {
    const f = c.closed ? i / n : (n > 1 ? i / (n - 1) : 0);
    const ang = rot0 + twist * f - closure * f;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const Ni = N[i], Bi = cross(T[i], Ni);
    const NN = add(mul(Ni, ca), mul(Bi, sa)), BB = add(mul(Bi, ca), mul(Ni, -sa));
    let s = 1;
    if (!c.closed) {
      const ts = Math.max(0.02, pr.taperStart), te = Math.max(0.02, pr.taperEnd);
      const e = f * f * (3 - 2 * f); s = ts + (te - ts) * e;
    }
    for (let k = 0; k < m; k++) {
      const x = prof[k][0] * w * s, y = prof[k][1] * h * s;
      pos[o++] = P[i][0] + NN[0] * x + BB[0] * y; pos[o++] = P[i][1] + NN[1] * x + BB[1] * y; pos[o++] = P[i][2] + NN[2] * x + BB[2] * y;
    }
  }
  const I = new Core.GrowU32(n * m * 6 + 64);
  const rings = c.closed ? n : n - 1;
  for (let i = 0; i < rings; i++) {
    const i2 = (i + 1) % n;
    for (let k = 0; k < m; k++) {
      const k2 = (k + 1) % m;
      const a = i * m + k, b = i * m + k2, cc = i2 * m + k2, d = i2 * m + k;
      I.push(a); I.push(b); I.push(cc); I.push(a); I.push(cc); I.push(d);
    }
  }
  if (!c.closed && pr.caps !== false) {
    const tri = earClip(prof);
    for (let q = 0; q < tri.length; q += 3) {
      I.push(tri[q]); I.push(tri[q + 2]); I.push(tri[q + 1]);
      const e = (n - 1) * m; I.push(e + tri[q]); I.push(e + tri[q + 1]); I.push(e + tri[q + 2]);
    }
  }
  const idx = I.copy();
  if (!c.closed && pr.caps !== false) Core.fixOrientation(pos, idx);
  return { pos, idx, nv: n * m };
}

// ------------------------------------------------------------ forme plane → solide (champ signé + surface nets)
function edt1d(f, n, d, v, z) { // Felzenszwalb & Huttenlocher, distance au carré
  let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
}
function edt2d(seed, NX, NY) { // distance (en cellules) à la cellule graine la plus proche
  const INF = 1e20, g = new Float64Array(NX * NY);
  for (let i = 0; i < g.length; i++) g[i] = seed[i] ? 0 : INF;
  const mx = Math.max(NX, NY), f = new Float64Array(mx), d = new Float64Array(mx), v = new Int32Array(mx), z = new Float64Array(mx + 1);
  for (let x = 0; x < NX; x++) { for (let y = 0; y < NY; y++) f[y] = g[x + y * NX]; edt1d(f, NY, d, v, z); for (let y = 0; y < NY; y++) g[x + y * NX] = d[y]; }
  for (let y = 0; y < NY; y++) { for (let x = 0; x < NX; x++) f[x] = g[x + y * NX]; edt1d(f, NX, d, v, z); for (let x = 0; x < NX; x++) g[x + y * NX] = Math.sqrt(d[x]); }
  return g;
}
// Champ signé 2D d'un polygone (négatif à l'intérieur), exact près du bord
function polygonSDF(poly, ox, oy, h, NX, NY) {
  const M = poly.length, inside = new Uint8Array(NX * NY);
  for (let j = 0; j < NY; j++) { // remplissage pair-impair par ligne
    const y = oy + j * h, xs = [];
    for (let e = 0; e < M; e++) {
      const a = poly[e], b = poly[(e + 1) % M];
      if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + (y - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
    }
    xs.sort((p, q) => p - q);
    for (let q = 0; q + 1 < xs.length; q += 2) {
      const i0 = Math.max(0, Math.ceil((xs[q] - ox) / h)), i1 = Math.min(NX - 1, Math.floor((xs[q + 1] - ox) / h));
      for (let i = i0; i <= i1; i++) inside[i + j * NX] ^= 1;
    }
  }
  const outsideSeed = new Uint8Array(NX * NY); for (let i = 0; i < inside.length; i++) outsideSeed[i] = inside[i] ? 0 : 1;
  const dIn = edt2d(outsideSeed, NX, NY), dOut = edt2d(inside, NX, NY);
  const sdf = new Float32Array(NX * NY);
  for (let i = 0; i < sdf.length; i++) sdf[i] = inside[i] ? -(dIn[i] - 0.5) * h : (dOut[i] - 0.5) * h;
  // affinage exact dans une bande de 3 cellules autour du bord
  const B = 3, buckets = new Map();
  for (let e = 0; e < M; e++) {
    const a = poly[e], b = poly[(e + 1) % M];
    const i0 = Math.max(0, Math.floor((Math.min(a[0], b[0]) - ox) / h) - B), i1 = Math.min(NX - 1, Math.ceil((Math.max(a[0], b[0]) - ox) / h) + B);
    const j0 = Math.max(0, Math.floor((Math.min(a[1], b[1]) - oy) / h) - B), j1 = Math.min(NY - 1, Math.ceil((Math.max(a[1], b[1]) - oy) / h) + B);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const g = i + j * NX; let l = buckets.get(g); if (!l) buckets.set(g, (l = [])); l.push(e); }
  }
  for (const [g, list] of buckets) {
    const i = g % NX, j = (g / NX) | 0, px = ox + i * h, py = oy + j * h; let best = Infinity;
    for (const e of list) {
      const a = poly[e], b = poly[(e + 1) % M], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
      let t = l2 > 0 ? ((px - a[0]) * dx + (py - a[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
      const qx = a[0] + dx * t - px, qy = a[1] + dy * t - py; best = Math.min(best, qx * qx + qy * qy);
    }
    const d = Math.sqrt(best);
    if (d < B * h) sdf[g] = inside[g] ? -d : d;
  }
  return { sdf, inside };
}
function shapeSolid(c, opts = {}) {
  if (!c.plane || c.pts.length < 2) return null;
  const pr = c.params, pl = c.plane;
  const c2 = c.closed ? c : { ...c, closed: true };
  const dense = polyline(c2, 32);
  let poly = dense.map((p) => toPlane(pl, p));
  if (Math.abs(area2(poly)) < 1e-12) return null;
  let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
  for (const [x, y] of poly) { mnx = Math.min(mnx, x); mxx = Math.max(mxx, x); mny = Math.min(mny, y); mxy = Math.max(mxy, y); }
  const maxDim = Math.max(mxx - mnx, mxy - mny);
  const T = Math.max(1e-5, pr.thickness);
  const res = Math.max(24, Math.min(512, (opts.res || pr.res) | 0));
  let h = Math.min(maxDim / res, T / 2.5);
  h = Math.max(h, maxDim / 1024);
  const pad = 3, bevel = Math.min(Math.max(0, pr.bevel), T / 2 - h * 0.25);
  const ox = mnx - pad * h, oy = mny - pad * h;
  const NX = Math.ceil(maxDim > 0 ? (mxx - mnx) / h : 1) + 2 * pad + 1, NY = Math.ceil((mxy - mny) / h) + 2 * pad + 1;
  let z0, z1; const anc = pr.anchor || 'center';
  if (anc === 'top') { z0 = 0; z1 = T; } else if (anc === 'bottom') { z0 = -T; z1 = 0; } else { z0 = -T / 2; z1 = T / 2; }
  const oz = z0 - pad * h, NZ = Math.ceil((z1 - z0) / h) + 2 * pad + 1;
  const N = NX * NY * NZ;
  if (N > 60e6) throw new Error('Forme trop fine pour cette résolution : augmentez l’épaisseur ou baissez la résolution.');
  // contour échantillonné à ~h/2 pour l'affinage exact
  const per = polyLength(poly.map((p) => [p[0], p[1], 0]), true);
  poly = resample(poly.map((p) => [p[0], p[1], 0]), Math.max(16, Math.min(20000, Math.ceil(per / (h * 0.5)))), true).map((p) => [p[0], p[1]]);
  const { sdf: s2 } = polygonSDF(poly, ox, oy, h, NX, NY);
  let maxIn = 0; for (let i = 0; i < s2.length; i++) if (-s2[i] > maxIn) maxIn = -s2[i];
  const inf = Math.max(0, Math.min(1, pr.inflate || 0));
  const W = Math.max(h, maxIn * 0.9);
  const sdf = new Float32Array(N), SXY = NX * NY;
  for (let k = 0; k < NZ; k++) {
    const z = oz + k * h;
    for (let g = 0; g < SXY; g++) {
      const d2 = s2[g]; let d;
      if (inf > 0) {
        const x = Math.min(1, Math.max(0, -d2 / W)), prof = Math.sqrt(Math.max(0, 1 - (1 - x) * (1 - x)));
        const k2 = (1 - inf) + inf * prof, minHalf = 0.6 * h;
        let lo, hi;
        if (anc === 'top') { lo = 0; hi = Math.max(minHalf * 2, T * k2); } else if (anc === 'bottom') { hi = 0; lo = -Math.max(minHalf * 2, T * k2); } else { const hz = Math.max(minHalf, (T / 2) * k2); lo = -hz; hi = hz; }
        d = Math.max(d2, lo - z, z - hi);
      } else {
        const zc = (z0 + z1) / 2, hz = (z1 - z0) / 2, r = bevel;
        const wx = d2 + r, wy = Math.abs(z - zc) - hz + r;
        d = Math.min(Math.max(wx, wy), 0) + Math.hypot(Math.max(wx, 0), Math.max(wy, 0)) - r;
      }
      sdf[g + k * SXY] = d;
    }
  }
  const net = Core.surfaceNets(sdf, NX, NY, NZ, ox, oy, oz, h);
  const P = net.pos;
  for (let i = 0; i < P.length; i += 3) {
    const x = P[i], y = P[i + 1], z = P[i + 2];
    P[i] = pl.o[0] + pl.u[0] * x + pl.v[0] * y + pl.n[0] * z;
    P[i + 1] = pl.o[1] + pl.u[1] * x + pl.v[1] * y + pl.n[1] * z;
    P[i + 2] = pl.o[2] + pl.u[2] * x + pl.v[2] * y + pl.n[2] * z;
  }
  return { pos: P, idx: net.idx, nv: net.nv, cell: h };
}

// Maillage d'une courbe selon son type
function bake(c, curves, opts = {}) {
  if (c.kind === 'shape') return shapeSolid(c, opts);
  const ref = c.params.profile === 'shape' ? (curves || []).find((x) => x.id === c.params.profileRef && x.kind === 'shape') : null;
  return sweepMesh(c, { profileCurve: ref });
}

// Aperçu filaire : liste de polylignes 3D
function previewLines(c, curves) {
  const out = [], pr = c.params;
  if (c.kind === 'shape' && c.plane && c.pts.length >= 2) {
    const c2 = c.closed ? c : { ...c, closed: true }, pl = c.plane;
    const poly = resample(polyline(c2, 16), 160, true);
    let z0, z1; const T = pr.thickness, a = pr.anchor || 'center';
    if (a === 'top') { z0 = 0; z1 = T; } else if (a === 'bottom') { z0 = -T; z1 = 0; } else { z0 = -T / 2; z1 = T / 2; }
    if (pr.inflate > 0) { const m = (z0 + z1) / 2; z0 = a === 'top' ? 0 : m - (T / 2) * (1 - pr.inflate * 0.5); z1 = a === 'bottom' ? 0 : m + (T / 2) * (1 - pr.inflate * 0.5); }
    for (const z of [z0, z1]) { const l = poly.map((p) => add(p, mul(pl.n, z))); l.push(l[0]); out.push(l); }
    for (let i = 0; i < poly.length; i += 20) out.push([add(poly[i], mul(pl.n, z0)), add(poly[i], mul(pl.n, z1))]);
    return out;
  }
  if (c.kind === 'sweep' && c.pts.length >= 2) {
    const ref = pr.profile === 'shape' ? (curves || []).find((x) => x.id === pr.profileRef && x.kind === 'shape') : null;
    const m = sweepMesh({ ...c, params: { ...pr, density: Math.min(pr.density, 0.25), sides: Math.min(pr.sides, 24) } }, { profileCurve: ref });
    if (!m) return out;
    const ringN = profilePoly(pr.profile, Math.min(pr.sides, 24), ref).length, n = m.nv / ringN;
    const step = Math.max(1, Math.round(n / 24));
    for (let i = 0; i < n; i += step) { const l = []; for (let k = 0; k <= ringN; k++) { const v = (i * ringN + (k % ringN)) * 3; l.push([m.pos[v], m.pos[v + 1], m.pos[v + 2]]); } out.push(l); }
    for (let k = 0; k < ringN; k += Math.max(1, Math.round(ringN / 6))) { const l = []; for (let i = 0; i < n; i++) { const v = (i * ringN + k) * 3; l.push([m.pos[v], m.pos[v + 1], m.pos[v + 2]]); } out.push(l); }
  }
  return out;
}

const Curves = {
  DEFAULTS, PROFILES, makeCurve, syncIds, clone, anchor, nSeg, segment, bez, bezD, polyline, resample, polyLength, curveLength,
  splitAt, removeAnchor, setSmooth, moveHandle, moveAnchor, setClosed, translate, nearest,
  fitPlane, toPlane, fromPlane, projectOnPlane, flattenToPlane, fitPath, area2, earClip, profilePoly,
  sweepMesh, polygonSDF, shapeSolid, bake, previewLines,
  v: { add, sub, mul, dot, cross, len, norm, lerp },
};
root.Curves = Curves;
if (typeof module !== 'undefined' && module.exports) module.exports = Curves;
})(typeof window !== 'undefined' ? window : globalThis);
