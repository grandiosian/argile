/* Argile — modélisation surfacique : maillages polygonaux, subdivision Catmull-Clark,
 * enveloppe convexe et peau adaptative de ZSpheres (méthode B-Mesh : tubes à section carrée,
 * enveloppe convexe aux embranchements, puis subdivision). */
(function (root) {
'use strict';
const Core = root.Core || require('./core.js');

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a); return l > 1e-15 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; };
const perp = (d) => norm(Math.abs(d[0]) < 0.8 ? cross(d, [1, 0, 0]) : cross(d, [0, 1, 0]));
// Rotation minimale qui amène a sur b, appliquée à v
function minRot(a, b, v) {
  const c = dot(a, b);
  if (c > 0.99999) return v.slice();
  if (c < -0.99999) { const ax = perp(a); return sub(mul(ax, 2 * dot(ax, v)), v); }
  const k = norm(cross(a, b)), s = Math.sqrt(1 - c * c);
  return add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1 - c)));
}

// ------------------------------------------------------------ maillage polygonal { V: [[x,y,z]], F: [[i,j,k,…]], G: [groupe] }
function edgeKey(a, b, n) { return a < b ? a * n + b : b * n + a; }
// Oriente toutes les faces de façon cohérente puis vers l'extérieur
function orient(M) {
  const n = M.V.length, map = new Map();
  M.F.forEach((f, fi) => { for (let i = 0; i < f.length; i++) { const k = edgeKey(f[i], f[(i + 1) % f.length], n); let l = map.get(k); if (!l) map.set(k, (l = [])); l.push(fi); } });
  const seen = new Uint8Array(M.F.length);
  const dir = (f, a, b) => { for (let i = 0; i < f.length; i++) if (f[i] === a && f[(i + 1) % f.length] === b) return 1; return -1; };
  for (let s = 0; s < M.F.length; s++) {
    if (seen[s]) continue; seen[s] = 1; const stack = [s];
    while (stack.length) {
      const fi = stack.pop(), f = M.F[fi];
      for (let i = 0; i < f.length; i++) {
        const a = f[i], b = f[(i + 1) % f.length];
        for (const gi of map.get(edgeKey(a, b, n)) || []) {
          if (gi === fi || seen[gi]) continue;
          if (dir(M.F[gi], a, b) === 1) M.F[gi].reverse();
          seen[gi] = 1; stack.push(gi);
        }
      }
    }
  }
  if (volume(M) < 0) for (const f of M.F) f.reverse();
  return M;
}
function volume(M) {
  let v = 0;
  for (const f of M.F) for (let i = 1; i + 1 < f.length; i++) { const a = M.V[f[0]], b = M.V[f[i]], c = M.V[f[i + 1]]; v += dot(a, cross(b, c)); }
  return v / 6;
}
// Une étape de Catmull-Clark (faces quelconques → quads), polygroupes hérités
function catmullClark(M) {
  const V = M.V, F = M.F, nV = V.length, nF = F.length;
  const fp = F.map((f) => { let c = [0, 0, 0]; for (const i of f) c = add(c, V[i]); return mul(c, 1 / f.length); });
  const emap = new Map(), E = [];
  F.forEach((f, fi) => {
    for (let i = 0; i < f.length; i++) {
      const a = f[i], b = f[(i + 1) % f.length], k = edgeKey(a, b, nV);
      let e = emap.get(k); if (e === undefined) { e = E.length; emap.set(k, e); E.push({ a, b, f: [fi] }); } else E[e].f.push(fi);
    }
  });
  const ep = E.map((e) => (e.f.length === 2 ? mul(add(add(V[e.a], V[e.b]), add(fp[e.f[0]], fp[e.f[1]])), 0.25) : mul(add(V[e.a], V[e.b]), 0.5)));
  const fsum = V.map(() => [0, 0, 0]), fcnt = new Int32Array(nV), rsum = V.map(() => [0, 0, 0]), rcnt = new Int32Array(nV), bnd = V.map(() => []);
  F.forEach((f, fi) => { for (const i of f) { fsum[i] = add(fsum[i], fp[fi]); fcnt[i]++; } });
  for (const e of E) {
    const m = mul(add(V[e.a], V[e.b]), 0.5);
    rsum[e.a] = add(rsum[e.a], m); rcnt[e.a]++; rsum[e.b] = add(rsum[e.b], m); rcnt[e.b]++;
    if (e.f.length === 1) { bnd[e.a].push(e.b); bnd[e.b].push(e.a); }
  }
  const vp = V.map((P, i) => {
    if (bnd[i].length >= 2) return add(mul(P, 0.75), mul(add(V[bnd[i][0]], V[bnd[i][1]]), 0.125));
    const n = fcnt[i]; if (!n) return P.slice();
    return mul(add(add(mul(fsum[i], 1 / n), mul(rsum[i], 2 / rcnt[i])), mul(P, n - 3)), 1 / n);
  });
  const NV = [...vp, ...ep, ...fp], oE = nV, oF = nV + E.length, NF = [], NG = [];
  F.forEach((f, fi) => {
    const k = f.length;
    for (let i = 0; i < k; i++) {
      const a = f[i], b = f[(i + 1) % k], p = f[(i - 1 + k) % k];
      NF.push([a, oE + emap.get(edgeKey(a, b, nV)), oF + fi, oE + emap.get(edgeKey(p, a, nV))]);
      NG.push(M.G ? M.G[fi] : 0);
    }
  });
  return { V: NV, F: NF, G: NG };
}
function subdivide(M, levels) { let m = M; for (let i = 0; i < levels; i++) m = catmullClark(m); return m; }
// Vers le format triangles d'Argile, avec drapeaux pour masquer les diagonales des quads dans le polyframe
function toTriMesh(M) {
  let nt = 0; for (const f of M.F) nt += f.length - 2;
  const pos = new Float32Array(M.V.length * 3), idx = new Uint32Array(nt * 3), groups = new Uint32Array(nt), qflags = new Uint8Array(nt);
  M.V.forEach((p, i) => { pos[3 * i] = p[0]; pos[3 * i + 1] = p[1]; pos[3 * i + 2] = p[2]; });
  let t = 0;
  M.F.forEach((f, fi) => {
    for (let i = 1; i + 1 < f.length; i++) {
      idx[3 * t] = f[0]; idx[3 * t + 1] = f[i]; idx[3 * t + 2] = f[i + 1];
      let fl = 0; if (i > 1) fl |= 1 << 2; if (i + 1 < f.length - 1) fl |= 1 << 1;
      qflags[t] = fl; groups[t] = M.G ? M.G[fi] : 0; t++;
    }
  });
  return { pos, idx, nv: M.V.length, groups, qflags };
}

// ------------------------------------------------------------ enveloppe convexe 3D (incrémentale)
function convexHull(P) {
  const n = P.length; if (n < 4) return null;
  let c = [0, 0, 0]; for (const p of P) c = add(c, p); c = mul(c, 1 / n);
  let scale = 0; for (const p of P) scale = Math.max(scale, len(sub(p, c)));
  const eps = 1e-10 * scale;
  // tétraèdre initial
  let i0 = 0, i1 = -1, i2 = -1, i3 = -1, best = 0;
  for (let i = 1; i < n; i++) { const d = len(sub(P[i], P[i0])); if (d > best) { best = d; i1 = i; } }
  best = 0; for (let i = 0; i < n; i++) { const d = len(cross(sub(P[i1], P[i0]), sub(P[i], P[i0]))); if (d > best) { best = d; i2 = i; } }
  best = 0; const nn = cross(sub(P[i1], P[i0]), sub(P[i2], P[i0]));
  for (let i = 0; i < n; i++) { const d = Math.abs(dot(nn, sub(P[i], P[i0]))); if (d > best) { best = d; i3 = i; } }
  if (i1 < 0 || i2 < 0 || i3 < 0 || best < eps * scale) return null;
  const inner = mul(add(add(P[i0], P[i1]), add(P[i2], P[i3])), 0.25);
  let faces = [];
  const mk = (a, b, cc) => { let f = [a, b, cc]; let nrm = cross(sub(P[b], P[a]), sub(P[cc], P[a])); if (dot(nrm, sub(P[a], inner)) < 0) { f = [a, cc, b]; nrm = mul(nrm, -1); } nrm = norm(nrm); return { v: f, n: nrm, d: dot(nrm, P[f[0]]) }; };
  faces.push(mk(i0, i1, i2), mk(i0, i1, i3), mk(i0, i2, i3), mk(i1, i2, i3));
  const used = new Set([i0, i1, i2, i3]);
  for (let i = 0; i < n; i++) {
    if (used.has(i)) continue;
    const p = P[i], vis = faces.map((f) => dot(f.n, p) - f.d > eps);
    if (!vis.some(Boolean)) continue;
    const ecount = new Map();
    faces.forEach((f, fi) => { if (!vis[fi]) return; for (let k = 0; k < 3; k++) { const a = f.v[k], b = f.v[(k + 1) % 3]; ecount.set(a + ',' + b, [a, b]); } });
    const horizon = [];
    for (const [key, [a, b]] of ecount) if (!ecount.has(b + ',' + a)) horizon.push([a, b]);
    faces = faces.filter((f, fi) => !vis[fi]);
    for (const [a, b] of horizon) { const nrm = norm(cross(sub(P[b], P[a]), sub(p, P[a]))); faces.push({ v: [a, b, i], n: nrm, d: dot(nrm, P[a]) }); }
    used.add(i);
  }
  return faces.map((f) => f.v);
}

// ------------------------------------------------------------ peau adaptative des ZSpheres
// nodes : [{ p:[x,y,z], r, parent: index|-1, part?: entier }]
function zsphereCage(nodes, opts = {}) {
  const N = nodes.length, dens = opts.density || 1;
  if (!N) return null;
  const kids = nodes.map(() => []);
  let rootI = -1;
  nodes.forEach((nd, i) => { if (nd.parent >= 0 && nd.parent < N) kids[nd.parent].push(i); else if (rootI < 0) rootI = i; });
  if (rootI < 0) rootI = 0;
  const V = [], F = [], G = [];
  const part = (i) => nodes[i].part || 0;
  if (N === 1) { // sphère isolée : cube
    const s = nodes[0].r * 1.25, c = nodes[0].p;
    for (let k = 0; k < 8; k++) V.push(add(c, [k & 1 ? s : -s, k & 2 ? s : -s, k & 4 ? s : -s]));
    for (const f of [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]]) { F.push(f); G.push(part(0)); }
    return orient({ V, F, G });
  }
  const dirTo = (a, b) => norm(sub(nodes[b].p, nodes[a].p));
  const deg = nodes.map((nd, i) => kids[i].length + (i !== rootI ? 1 : 0));
  // repères des liens (transport le long de l'arbre)
  const eu = new Array(N); // eu[c] = vecteur u du lien parent(c) → c
  const order = [rootI]; const refD = new Array(N), refU = new Array(N);
  for (let q = 0; q < order.length; q++) {
    const i = order[q];
    let dIn, uIn;
    if (i === rootI) { const d0 = dirTo(i, kids[i][0]); dIn = mul(d0, -1); uIn = perp(d0); }
    else { dIn = dirTo(nodes[i].parent, i); uIn = eu[i]; }
    refD[i] = dIn; refU[i] = uIn;
    kids[i].forEach((c, k) => {
      const d = dirTo(i, c);
      let u = i === rootI && k === 0 ? uIn : minRot(dIn, d, uIn);
      u = norm(sub(u, mul(d, dot(u, d)))); if (len(u) < 0.5) u = perp(d);
      eu[c] = u; order.push(c);
    });
  }
  const K = 1.52; // rayon des coins pour une peau de rayon r après subdivision
  const ring = (center, d, u, rad, pertDir) => {
    const v = cross(d, u), out = [];
    for (let k = 0; k < 4; k++) {
      const a = Math.PI / 4 + (k * Math.PI) / 2;
      let p = add(center, mul(add(mul(u, Math.cos(a)), mul(v, Math.sin(a))), rad * K));
      if (pertDir) p = add(p, mul(pertDir, (k % 2 ? 1 : -1) * rad * 2e-3));
      out.push(V.length); V.push(p);
    }
    return out;
  };
  const connect = (A, B, g) => {
    let best = Infinity, bs = 0, bd = 1;
    for (const dd of [1, -1]) for (let s = 0; s < 4; s++) {
      let e = 0; for (let k = 0; k < 4; k++) e += len(sub(V[A[k]], V[B[(s + dd * k + 8) % 4]]));
      if (e < best) { best = e; bs = s; bd = dd; }
    }
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4;
      F.push([A[k], A[k2], B[(bs + bd * k2 + 8) % 4], B[(bs + bd * k + 8) % 4]]); G.push(g);
    }
  };
  // ports et anneaux de nœuds
  const nodeRing = new Array(N), port = new Array(N), portInfo = new Array(N);
  for (let i = 0; i < N; i++) {
    const nd = nodes[i];
    const inc = []; // liens incidents : direction sortante, u, clé
    if (i !== rootI) inc.push({ d: mul(dirTo(nodes[i].parent, i), -1), u: eu[i], key: 'p' });
    for (const c of kids[i]) inc.push({ d: dirTo(i, c), u: eu[c], key: c });
    if (deg[i] >= 3) {
      let shrink = 1, ok = false;
      for (let attempt = 0; attempt < 6 && !ok; attempt++) {
        const save = V.length, P = [], owner = [];
        const ports = {};
        const info = {};
        for (const e of inc) {
          let th = Math.PI; for (const o of inc) if (o !== e) th = Math.min(th, Math.acos(Math.max(-1, Math.min(1, dot(e.d, o.d)))));
          const delta = nd.r * 0.95;
          const w = Math.max(0.15 * nd.r, Math.min(1.0 * nd.r, delta * Math.tan(th / 2) * 0.8)) * shrink;
          const rad = (w * Math.SQRT2) / K;
          const rg = ring(add(nd.p, mul(e.d, delta)), e.d, e.u, rad, e.d);
          ports[e.key] = rg; info[e.key] = { center: add(nd.p, mul(e.d, delta)), rad };
          for (const vi of rg) { P.push(V[vi]); owner.push(e.key); }
        }
        const hull = convexHull(P);
        if (hull) {
          const base = save, onHull = new Set(); for (const f of hull) for (const k of f) onHull.add(k);
          const keep = [], removed = {};
          ok = owner.every((_, k) => onHull.has(k));
          for (const f of hull) {
            const o = owner[f[0]];
            if (owner[f[1]] === o && owner[f[2]] === o) { removed[o] = (removed[o] || 0) + 1; continue; }
            keep.push(f);
          }
          if (ok) for (const e of inc) if (removed[e.key] !== 2) ok = false;
          if (ok) { for (const f of keep) { F.push(f.map((k) => base + k)); G.push(part(i)); } port[i] = ports; portInfo[i] = info; }
        }
        if (!ok) { V.length = save; shrink *= 0.75; }
      }
      if (!ok) throw new Error('Embranchement trop serré au nœud ' + i + ' : écartez les sphères qui en partent.');
    } else if (deg[i] === 2) {
      let a, b, u;
      if (i === rootI) { const c0 = kids[i][0], c1 = kids[i][1]; a = mul(dirTo(i, c1), -1); b = dirTo(i, c0); u = eu[c0]; }
      else { a = dirTo(nodes[i].parent, i); b = dirTo(i, kids[i][0]); u = eu[i]; }
      let nrm = norm(add(a, b)); if (len(nrm) < 0.5) nrm = a;
      u = norm(sub(u, mul(nrm, dot(u, nrm)))); if (len(u) < 0.5) u = perp(nrm);
      nodeRing[i] = ring(nd.p, nrm, u, nd.r);
    } else {
      const e = inc[0], out = mul(e.d, -1); // direction vers l'extérieur du bout
      const rg = ring(nd.p, out, e.u, nd.r), cap = ring(add(nd.p, mul(out, nd.r * 0.6)), out, e.u, nd.r * 0.55);
      connect(rg, cap, part(i)); F.push(cap.slice()); G.push(part(i));
      nodeRing[i] = rg;
    }
  }
  // tubes
  for (let c = 0; c < N; c++) {
    if (c === rootI) continue;
    const a = nodes[c].parent, d = dirTo(a, c), u = eu[c];
    const A = deg[a] >= 3 ? port[a][c] : nodeRing[a], B = deg[c] >= 3 ? port[c].p : nodeRing[c];
    const ca = deg[a] >= 3 ? portInfo[a][c].center : nodes[a].p, cb = deg[c] >= 3 ? portInfo[c].p.center : nodes[c].p;
    const ra = deg[a] >= 3 ? portInfo[a][c].rad : nodes[a].r, rb = deg[c] >= 3 ? portInfo[c].p.rad : nodes[c].r;
    const L = len(sub(cb, ca));
    // anneaux de maintien près des sphères (hors embranchements) : la subdivision ne les dégonfle pas
    const t0 = deg[a] <= 2 ? Math.min(0.5 * ra, 0.3 * L) / L : 0, t1 = 1 - (deg[c] <= 2 ? Math.min(0.5 * rb, 0.3 * L) / L : 0);
    const steps = [];
    if (t0 > 0) steps.push([t0, ra * 0.93]);
    const m = Math.max(0, Math.round(((t1 - t0) * L / Math.max(1e-9, (ra + rb) * 0.5)) * 0.9 * dens) - 1);
    for (let k = 1; k <= m; k++) { const t = t0 + ((t1 - t0) * k) / (m + 1); steps.push([t, ra + (rb - ra) * t]); }
    if (t1 < 1) steps.push([t1, rb * 0.93]);
    let prev = A;
    for (const [t, rad] of steps) { const rg = ring(add(ca, mul(sub(cb, ca), t)), d, u, rad); connect(prev, rg, part(c)); prev = rg; }
    connect(prev, B, part(c));
  }
  return orient({ V, F, G });
}
function skinZSpheres(nodes, levels = 3, opts = {}) {
  const cage = zsphereCage(nodes, opts);
  return toTriMesh(subdivide(cage, levels));
}

const Surface = { orient, volume, catmullClark, subdivide, toTriMesh, convexHull, zsphereCage, skinZSpheres, minRot, v: { add, sub, mul, dot, cross, len, norm, perp } };
root.Surface = Surface;
if (typeof module !== 'undefined' && module.exports) module.exports = Surface;
})(typeof window !== 'undefined' ? window : globalThis);
