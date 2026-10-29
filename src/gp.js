/* Argile — Dessin 3D façon Grease Pencil : calques, traits (x,y,z,rayon), gomme, conversion en tubes. */
(function (root) {
'use strict';
const Core = root.Core || require('./core.js');

let _id = 1;
function makeLayer(name) { return { id: _id++, name, visible: true, locked: false, strokes: [] }; }
function makeState() { return { layers: [makeLayer('Calque 1')], active: 0, version: 1 }; }
function makeStroke(color, pts) { return { id: _id++, color: color.slice(0, 3), pts }; }
const count = (s) => s.pts.length / 4;

// Lissage laplacien des positions et rayons (extrémités fixes)
function smoothPoints(p, iter) {
  const n = p.length / 4; if (n < 3 || iter <= 0) return p;
  let a = p.slice(), b = new Float32Array(p.length);
  for (let it = 0; it < iter; it++) {
    b.set(a);
    for (let i = 1; i < n - 1; i++) for (let k = 0; k < 4; k++) b[4 * i + k] = 0.25 * a[4 * (i - 1) + k] + 0.5 * a[4 * i + k] + 0.25 * a[4 * (i + 1) + k];
    const t = a; a = b; b = t;
  }
  return a;
}
// Retire les points quasi confondus et applique le lissage
function finalize(raw, color, smoothIter, minDist) {
  const out = []; const n = raw.length / 4;
  for (let i = 0; i < n; i++) {
    const x = raw[4 * i], y = raw[4 * i + 1], z = raw[4 * i + 2], r = raw[4 * i + 3];
    if (out.length) {
      const j = out.length - 4, d = Math.hypot(x - out[j], y - out[j + 1], z - out[j + 2]);
      if (d < minDist && i < n - 1) continue;
      if (d < 1e-9) { out[j + 3] = Math.max(out[j + 3], r); continue; }
    }
    out.push(x, y, z, r);
  }
  if (out.length < 8) return null;
  return makeStroke(color, smoothPoints(new Float32Array(out), smoothIter));
}
// Ligne droite échantillonnée
function lineStroke(a, b, r, color, steps) {
  const n = Math.max(2, steps | 0), p = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { const t = i / (n - 1); p[4 * i] = a[0] + (b[0] - a[0]) * t; p[4 * i + 1] = a[1] + (b[1] - a[1]) * t; p[4 * i + 2] = a[2] + (b[2] - a[2]) * t; p[4 * i + 3] = r; }
  return makeStroke(color, p);
}

// Gomme : project(x,y,z) -> [sx, sy] | null. whole = effacer le trait entier.
function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  const qx = ax + dx * t - px, qy = ay + dy * t - py; return qx * qx + qy * qy;
}
function erase(state, project, x, y, radius, whole) {
  let changed = false; const r2 = radius * radius;
  for (const L of state.layers) {
    if (!L.visible || L.locked) continue;
    const next = [];
    for (const s of L.strokes) {
      const n = count(s), P = s.pts;
      const scr = new Array(n); let any = false;
      for (let i = 0; i < n; i++) scr[i] = project(P[4 * i], P[4 * i + 1], P[4 * i + 2]);
      const inside = new Uint8Array(n);
      for (let i = 0; i < n; i++) { const q = scr[i]; if (q && (q[0] - x) ** 2 + (q[1] - y) ** 2 <= r2) { inside[i] = 1; any = true; } }
      if (!any && whole) for (let i = 0; i + 1 < n && !any; i++) { const a = scr[i], b = scr[i + 1]; if (a && b && segDist2(x, y, a[0], a[1], b[0], b[1]) <= r2) any = true; }
      if (!any) { next.push(s); continue; }
      changed = true;
      if (whole) continue;
      let start = -1;
      for (let i = 0; i <= n; i++) {
        if (i < n && !inside[i]) { if (start < 0) start = i; continue; }
        if (start >= 0 && i - start >= 2) next.push(makeStroke(s.color, P.slice(4 * start, 4 * i)));
        start = -1;
      }
    }
    if (changed) L.strokes = next;
  }
  if (changed) state.version++;
  return changed;
}

// Copie pour l'annulation (les traits sont immuables)
function snapshot(state) { return { active: state.active, layers: state.layers.map((l) => ({ ...l, strokes: l.strokes.slice() })) }; }
function restore(state, snap) { state.active = snap.active; state.layers = snap.layers.map((l) => ({ ...l, strokes: l.strokes.slice() })); state.version++; }

// Conversion en tubes fermés (transport parallèle du repère), un polygroupe par trait
function strokesToMesh(strokes, opts = {}) {
  const sides = opts.sides || 8, scale = opts.scale || 1;
  const P = new Core.GrowF32(1 << 14), I = new Core.GrowU32(1 << 14), G = new Core.GrowU32(1 << 12), C = [];
  let g = 0;
  for (const s of strokes) {
    const n = count(s); if (n < 2) continue;
    const pts = s.pts, base = P.n / 3;
    const T = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      let tx = pts[4 * b] - pts[4 * a], ty = pts[4 * b + 1] - pts[4 * a + 1], tz = pts[4 * b + 2] - pts[4 * a + 2];
      const l = Math.hypot(tx, ty, tz) || 1; T[3 * i] = tx / l; T[3 * i + 1] = ty / l; T[3 * i + 2] = tz / l;
    }
    // normale initiale perpendiculaire à T0
    let nx, ny, nz; { const tx = T[0], ty = T[1], tz = T[2]; if (Math.abs(tx) < 0.9) { nx = 0; ny = tz; nz = -ty; } else { nx = -tz; ny = 0; nz = tx; } const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l; }
    const vstart = P.n / 3;
    for (let i = 0; i < n; i++) {
      const tx = T[3 * i], ty = T[3 * i + 1], tz = T[3 * i + 2];
      const d = nx * tx + ny * ty + nz * tz; nx -= d * tx; ny -= d * ty; nz -= d * tz;
      let l = Math.hypot(nx, ny, nz); if (l < 1e-9) { if (Math.abs(tx) < 0.9) { nx = 0; ny = tz; nz = -ty; } else { nx = -tz; ny = 0; nz = tx; } l = Math.hypot(nx, ny, nz); }
      nx /= l; ny /= l; nz /= l;
      const bx = ty * nz - tz * ny, by = tz * nx - tx * nz, bz = tx * ny - ty * nx;
      const r = Math.max(1e-5, pts[4 * i + 3] * scale);
      for (let k = 0; k < sides; k++) {
        const a = (k / sides) * Math.PI * 2, c = Math.cos(a) * r, sn = Math.sin(a) * r;
        P.push3(pts[4 * i] + nx * c + bx * sn, pts[4 * i + 1] + ny * c + by * sn, pts[4 * i + 2] + nz * c + bz * sn);
      }
    }
    const c0 = P.n / 3; P.push3(pts[0], pts[1], pts[2]);
    const c1 = P.n / 3; P.push3(pts[4 * (n - 1)], pts[4 * (n - 1) + 1], pts[4 * (n - 1) + 2]);
    const i0 = I.n;
    for (let i = 0; i + 1 < n; i++) for (let k = 0; k < sides; k++) {
      const a = vstart + i * sides + k, b = vstart + i * sides + (k + 1) % sides, c = a + sides, d = b + sides;
      I.push(a); I.push(b); I.push(d); I.push(a); I.push(d); I.push(c);
    }
    for (let k = 0; k < sides; k++) {
      I.push(c0); I.push(vstart + (k + 1) % sides); I.push(vstart + k);
      const e = vstart + (n - 1) * sides; I.push(c1); I.push(e + k); I.push(e + (k + 1) % sides);
    }
    // orientation vers l'extérieur, tube par tube
    const sub = I.a.subarray(i0, I.n);
    const loc = new Uint32Array(sub.length); for (let q = 0; q < sub.length; q++) loc[q] = sub[q] - base;
    const lp = P.a.subarray(base * 3, P.n);
    if (Core.fixOrientation(lp, loc) < 0) { /* déjà retourné dans loc */ }
    for (let q = 0; q < sub.length; q++) sub[q] = loc[q] + base;
    const nt = (I.n - i0) / 3; for (let q = 0; q < nt; q++) G.push(g);
    const nverts = P.n / 3 - base; for (let q = 0; q < nverts; q++) C.push(s.color);
    g++;
  }
  const nv = P.n / 3;
  const col = new Uint8Array(nv * 4);
  for (let v = 0; v < nv; v++) { const c = C[v]; col[4 * v] = c[0]; col[4 * v + 1] = c[1]; col[4 * v + 2] = c[2]; col[4 * v + 3] = 255; }
  return { pos: P.copy(), idx: I.copy(), nv, groups: G.copy(), col };
}

// Lots GPU : points (x,y,z,r), couleur par point, début de chaque segment
function buildBatch(strokesList) {
  let np = 0, ns = 0;
  for (const s of strokesList) { const n = count(s); np += n; ns += Math.max(0, n - 1); }
  const pts = new Float32Array(Math.max(4, np * 4)), col = new Uint32Array(Math.max(1, np)), seg = new Uint32Array(Math.max(1, ns));
  let o = 0, q = 0;
  for (const s of strokesList) {
    const n = count(s); pts.set(s.pts, o * 4);
    const c = (s.color[0] | (s.color[1] << 8) | (s.color[2] << 16) | (255 << 24)) >>> 0;
    for (let i = 0; i < n; i++) col[o + i] = c;
    for (let i = 0; i + 1 < n; i++) seg[q++] = o + i;
    o += n;
  }
  return { pts, col, seg, np, ns };
}
function visibleStrokes(state) { const out = []; for (const L of state.layers) if (L.visible) for (const s of L.strokes) out.push(s); return out; }

const GP = { makeState, makeLayer, makeStroke, smoothPoints, finalize, lineStroke, erase, snapshot, restore, strokesToMesh, buildBatch, visibleStrokes, count };
root.GP = GP;
if (typeof module !== 'undefined' && module.exports) module.exports = GP;
})(typeof window !== 'undefined' ? window : globalThis);
