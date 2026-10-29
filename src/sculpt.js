/* Argile — moteur de brosses (CPU), masques, polygroupes, annulation. */
(function (root) {
'use strict';
const Core = root.Core || require('./core.js');

const BRUSHES = [
  { id: 'standard', label: 'Standard', key: '1', hint: 'Déplace la surface selon sa normale' },
  { id: 'clay', label: 'Clay', key: '2', hint: 'Ajoute de la matière en aplats' },
  { id: 'claybuildup', label: 'ClayBuildup', key: '3', hint: 'Construit vite, bords carrés' },
  { id: 'move', label: 'Move', key: '4', hint: 'Attrape et déplace une zone' },
  { id: 'inflate', label: 'Inflate', key: '5', hint: 'Gonfle selon les normales locales' },
  { id: 'pinch', label: 'Pinch', key: '6', hint: 'Resserre vers le centre' },
  { id: 'flatten', label: 'Flatten', key: '7', hint: 'Aplanit sur un plan moyen' },
  { id: 'dam', label: 'DamStandard', key: '8', hint: 'Creuse des plis nets' },
  { id: 'smooth', label: 'Smooth', key: 'Maj', hint: 'Lisse (maintenir Maj)' },
  { id: 'mask', label: 'Mask', key: 'Ctrl', hint: 'Peint un masque (maintenir Ctrl/Cmd)' },
  { id: 'paint', label: 'Polypaint', key: '9', hint: 'Peint la couleur des sommets' },
];

function falloff(x, focal) {
  if (x >= 1) return 0;
  const xx = Math.pow(x, Math.pow(2, -focal * 2));
  return 1 - xx * xx * (3 - 2 * xx);
}

function vertexVisibility(level) {
  if (!level.hidden) return null;
  if (level.vVis) return level.vVis;
  const vis = new Uint8Array(level.nv);
  for (let t = 0; t < level.nt; t++) if (!level.hidden[t]) { vis[level.idx[3 * t]] = 1; vis[level.idx[3 * t + 1]] = 1; vis[level.idx[3 * t + 2]] = 1; }
  return (level.vVis = vis);
}

let strokeCounter = 1;
class Stroke {
  constructor(level, mesh) {
    this.level = level; this.mesh = mesh;
    if (!mesh.touch) mesh.touch = new Uint32Array(level.nv);
    this.id = ++strokeCounter;
    this.uIdx = new Core.GrowU32(4096); this.uPos = new Core.GrowF32(4096 * 3); this.uMask = new Core.GrowF32(4096); this.uCol = new Core.GrowU32(4096);
    this.col32 = new Uint32Array(level.col.buffer, level.col.byteOffset, level.nv);
    this.vis = vertexVisibility(level);
    this.list = new Uint32Array(4096); this.dist = new Float32Array(4096); this.w = new Float32Array(4096);
    this.grabs = null;
    this.changed = { pos: false, mask: false, col: false };
  }
  record(v) {
    const touch = this.mesh.touch;
    if (touch[v] === this.id) return;
    touch[v] = this.id; this.uIdx.push(v);
    const p = this.level.pos; this.uPos.push3(p[3 * v], p[3 * v + 1], p[3 * v + 2]);
    this.uMask.push(this.level.mask[v]); this.uCol.push(this.col32[v]);
  }
  gather(cx, cy, cz, r) {
    const mesh = this.mesh, L = this.level, pos = L.pos, idx = L.idx, vis = this.vis;
    const stamp = ++mesh.stampId, vs = mesh.vStamp, r2 = r * r;
    let n = 0;
    mesh.bvh.sphereTris(cx, cy, cz, r, (t) => {
      if (L.hidden && L.hidden[t]) return;
      for (let k = 0; k < 3; k++) {
        const v = idx[3 * t + k];
        if (vs[v] === stamp) continue; vs[v] = stamp;
        if (vis && !vis[v]) continue;
        const dx = pos[3 * v] - cx, dy = pos[3 * v + 1] - cy, dz = pos[3 * v + 2] - cz, d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r2) continue;
        if (n >= this.list.length) this._grow();
        this.list[n] = v; this.dist[n] = Math.sqrt(d2); n++;
      }
    });
    return n;
  }
  _grow() {
    const m = this.list.length * 2;
    const a = new Uint32Array(m); a.set(this.list); this.list = a;
    const b = new Float32Array(m); b.set(this.dist); this.dist = b;
    this.w = new Float32Array(m);
  }
  finish() {
    if (this.uIdx.n === 0) return null;
    const idx = this.uIdx.copy(), n = idx.length, L = this.level;
    const newPos = new Float32Array(n * 3), newMask = new Float32Array(n), newCol = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      const v = idx[i];
      newPos[3 * i] = L.pos[3 * v]; newPos[3 * i + 1] = L.pos[3 * v + 1]; newPos[3 * i + 2] = L.pos[3 * v + 2];
      newMask[i] = L.mask[v]; newCol[i] = this.col32[v];
    }
    return { type: 'verts', level: L, idx, oldPos: this.uPos.copy(), newPos, oldMask: this.uMask.copy(), newMask, oldCol: this.uCol.copy(), newCol };
  }
}

function sampleAlpha(alpha, u, v) {
  if (!alpha) return 1;
  const S = alpha.size;
  const x = (u * 0.5 + 0.5) * (S - 1), y = (0.5 - v * 0.5) * (S - 1);
  if (x < 0 || y < 0 || x > S - 1 || y > S - 1) return 0;
  const x0 = x | 0, y0 = y | 0, x1 = Math.min(S - 1, x0 + 1), y1 = Math.min(S - 1, y0 + 1), fx = x - x0, fy = y - y0;
  const d = alpha.data;
  return (d[y0 * S + x0] * (1 - fx) + d[y0 * S + x1] * fx) * (1 - fy) + (d[y1 * S + x0] * (1 - fx) + d[y1 * S + x1] * fx) * fy;
}

// Pose la couleur C avec l'opacité t ; l'alpha garde la couverture pour se fondre dans le matériau
function paintVertex(col, o, C, t) {
  if (t <= 0) return;
  const a = col[o + 3] / 255, na = a + (1 - a) * t;
  for (let q = 0; q < 3; q++) col[o + q] = Math.round((col[o + q] * a * (1 - t) + C[q] * t) / na);
  col[o + 3] = Math.round(na * 255);
}

// Un "dab" de brosse centré en (px,py,pz). p = { type, sign, strength, radius, focal, alpha, right, up, color }
function dab(S, px, py, pz, p) {
  const L = S.level, mesh = S.mesh, pos = L.pos, nrm = mesh.nrm, mask = L.mask;
  const r = p.radius;
  const n = S.gather(px, py, pz, r);
  if (!n) return 0;
  const list = S.list, dist = S.dist, w = S.w;
  const usesMask = p.type !== 'mask';
  const R = p.right, U = p.up;
  let focal = p.focal;
  if (p.type === 'claybuildup') focal = Math.min(1, focal) - 0.6;
  if (p.type === 'dam') focal = Math.max(-1, focal) + 0.5;
  let nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0, ws = 0;
  for (let i = 0; i < n; i++) {
    const v = list[i];
    let f = falloff(dist[i] / r, focal);
    if (p.alpha) {
      const ox = pos[3 * v] - px, oy = pos[3 * v + 1] - py, oz = pos[3 * v + 2] - pz;
      f *= sampleAlpha(p.alpha, (ox * R[0] + oy * R[1] + oz * R[2]) / r, (ox * U[0] + oy * U[1] + oz * U[2]) / r);
    }
    if (usesMask) f *= 1 - mask[v];
    w[i] = f;
    const g = falloff(dist[i] / r, 0);
    nx += nrm[3 * v] * g; ny += nrm[3 * v + 1] * g; nz += nrm[3 * v + 2] * g;
    cx += pos[3 * v] * g; cy += pos[3 * v + 1] * g; cz += pos[3 * v + 2] * g; ws += g;
  }
  let nl = Math.hypot(nx, ny, nz);
  if (nl < 1e-12) { nx = p.viewDir ? -p.viewDir[0] : 0; ny = p.viewDir ? -p.viewDir[1] : 0; nz = p.viewDir ? -p.viewDir[2] : 1; nl = 1; }
  nx /= nl; ny /= nl; nz /= nl;
  if (ws > 0) { cx /= ws; cy /= ws; cz /= ws; } else { cx = px; cy = py; cz = pz; }
  const k = p.strength, sign = p.sign;

  if (p.type === 'mask') {
    for (let i = 0; i < n; i++) {
      const v = list[i]; if (w[i] <= 0) continue; S.record(v);
      mask[v] = Math.min(1, Math.max(0, mask[v] + sign * w[i] * Math.min(1, k * 2.5)));
    }
    Core.markDirtyList(L, 'mask', list, n); S.changed.mask = true;
    return n;
  }
  if (p.type === 'paint') {
    const col = L.col, C = p.color; const kk = Math.min(1, k * 1.5);
    for (let i = 0; i < n; i++) {
      const v = list[i]; if (w[i] <= 0) continue; S.record(v);
      paintVertex(col, 4 * v, C, w[i] * kk);
    }
    Core.markDirtyList(L, 'col', list, n); S.changed.col = true;
    return n;
  }

  for (let i = 0; i < n; i++) if (w[i] > 0) S.record(list[i]);
  switch (p.type) {
    case 'standard': {
      const amt = sign * k * r * 0.1;
      for (let i = 0; i < n; i++) { const o = 3 * list[i], a = amt * w[i]; pos[o] += nx * a; pos[o + 1] += ny * a; pos[o + 2] += nz * a; }
      break;
    }
    case 'inflate': {
      const amt = sign * k * r * 0.08;
      for (let i = 0; i < n; i++) { const o = 3 * list[i], a = amt * w[i]; pos[o] += nrm[o] * a; pos[o + 1] += nrm[o + 1] * a; pos[o + 2] += nrm[o + 2] * a; }
      break;
    }
    case 'clay': case 'claybuildup': {
      const build = p.type === 'claybuildup';
      const off = r * (build ? 0.24 : 0.14) * sign;
      const ppx = cx + nx * off, ppy = cy + ny * off, ppz = cz + nz * off;
      const kk = Math.min(1, k * (build ? 2.4 : 1.6));
      for (let i = 0; i < n; i++) {
        const o = 3 * list[i];
        const d = (pos[o] - ppx) * nx + (pos[o + 1] - ppy) * ny + (pos[o + 2] - ppz) * nz;
        if (sign * d >= 0) continue;
        const a = -d * w[i] * kk; pos[o] += nx * a; pos[o + 1] += ny * a; pos[o + 2] += nz * a;
      }
      break;
    }
    case 'flatten': {
      const kk = Math.min(1, k * 1.2);
      for (let i = 0; i < n; i++) {
        const o = 3 * list[i];
        const d = (pos[o] - cx) * nx + (pos[o + 1] - cy) * ny + (pos[o + 2] - cz) * nz;
        if (sign < 0 && d < 0) continue; // ZSub : n'aplanit que les bosses
        const a = -d * w[i] * kk; pos[o] += nx * a; pos[o + 1] += ny * a; pos[o + 2] += nz * a;
      }
      break;
    }
    case 'pinch': case 'dam': {
      const dam = p.type === 'dam';
      const pk = (dam ? 0.35 : 0.45) * k * (dam ? 1 : sign);
      const depth = dam ? -sign * k * r * 0.07 : 0;
      for (let i = 0; i < n; i++) {
        const o = 3 * list[i];
        let dx = px - pos[o], dy = py - pos[o + 1], dz = pz - pos[o + 2];
        const dn = dx * nx + dy * ny + dz * nz; dx -= dn * nx; dy -= dn * ny; dz -= dn * nz;
        const ww = w[i];
        pos[o] += dx * ww * pk + nx * depth * ww * ww;
        pos[o + 1] += dy * ww * pk + ny * depth * ww * ww;
        pos[o + 2] += dz * ww * pk + nz * depth * ww * ww;
      }
      break;
    }
    case 'smooth': {
      const kk = Math.min(1, 0.25 + k * 0.9);
      const vvS = mesh.vvStart, vv = mesh.vv, bnd = mesh.boundary;
      for (let i = 0; i < n; i++) {
        const v = list[i]; if (bnd[v] || w[i] <= 0) continue;
        let ax = 0, ay = 0, az = 0; const s = vvS[v], e = vvS[v + 1]; if (e === s) continue;
        for (let j = s; j < e; j++) { const q = 3 * vv[j]; ax += pos[q]; ay += pos[q + 1]; az += pos[q + 2]; }
        const inv = 1 / (e - s), o = 3 * v, a = w[i] * kk;
        pos[o] += (ax * inv - pos[o]) * a; pos[o + 1] += (ay * inv - pos[o + 1]) * a; pos[o + 2] += (az * inv - pos[o + 2]) * a;
      }
      break;
    }
  }
  mesh.updateAfterMove(list, n);
  S.changed.pos = true;
  return n;
}

// Move : capture des sommets au début du trait, puis déplacement absolu
function grabStart(S, px, py, pz, p, mirror) {
  const n = S.gather(px, py, pz, p.radius);
  const verts = S.list.slice(0, n), w = new Float32Array(n), orig = new Float32Array(n * 3);
  const L = S.level;
  for (let i = 0; i < n; i++) {
    const v = verts[i];
    w[i] = falloff(S.dist[i] / p.radius, p.focal) * (1 - L.mask[v]);
    orig[3 * i] = L.pos[3 * v]; orig[3 * i + 1] = L.pos[3 * v + 1]; orig[3 * i + 2] = L.pos[3 * v + 2];
    if (w[i] > 0) S.record(v);
  }
  (S.grabs || (S.grabs = [])).push({ verts, w, orig, mirror });
}
function grabMove(S, dx, dy, dz) {
  const pos = S.level.pos;
  let total = 0;
  for (const g of S.grabs) {
    const mx = dx * g.mirror[0], my = dy * g.mirror[1], mz = dz * g.mirror[2];
    for (let i = 0; i < g.verts.length; i++) {
      const o = 3 * g.verts[i], a = g.w[i];
      if (a <= 0) continue;
      pos[o] = g.orig[3 * i] + mx * a; pos[o + 1] = g.orig[3 * i + 1] + my * a; pos[o + 2] = g.orig[3 * i + 2] + mz * a;
    }
  }
  // les groupes symétriques peuvent se recouvrir : on recalcule une fois pour tous
  for (const g of S.grabs) { S.mesh.updateAfterMove(g.verts, g.verts.length); total += g.verts.length; }
  S.changed.pos = true;
  return total;
}

// ------------------------------------------------------------ annulation
function applyVerts(e, useNew, getMeshFor) {
  const L = e.level, P = useNew ? e.newPos : e.oldPos, M = useNew ? e.newMask : e.oldMask, C = useNew ? e.newCol : e.oldCol;
  const col32 = new Uint32Array(L.col.buffer, L.col.byteOffset, L.nv);
  for (let i = 0; i < e.idx.length; i++) {
    const v = e.idx[i];
    L.pos[3 * v] = P[3 * i]; L.pos[3 * v + 1] = P[3 * i + 1]; L.pos[3 * v + 2] = P[3 * i + 2];
    L.mask[v] = M[i]; col32[v] = C[i];
  }
  const mesh = getMeshFor(L);
  if (mesh) mesh.updateAfterMove(e.idx, e.idx.length);
  const n = e.idx.length;
  Core.markDirtyList(L, 'pos', e.idx, n); Core.markDirtyList(L, 'mask', e.idx, n); Core.markDirtyList(L, 'col', e.idx, n);
}

// ------------------------------------------------------------ masques
function maskInvert(L) { for (let i = 0; i < L.nv; i++) L.mask[i] = 1 - L.mask[i]; Core.markDirty(L, 'mask', 0, L.nv - 1); }
function maskClear(L) { L.mask.fill(0); Core.markDirty(L, 'mask', 0, L.nv - 1); }
function maskBlur(L, mesh, sharpen) {
  const m = L.mask, out = new Float32Array(L.nv);
  for (let v = 0; v < L.nv; v++) {
    const s = mesh.vvStart[v], e = mesh.vvStart[v + 1];
    let a = m[v]; for (let j = s; j < e; j++) a += m[mesh.vv[j]];
    const avg = a / (e - s + 1);
    out[v] = sharpen ? Math.min(1, Math.max(0, m[v] + (m[v] - avg) * 2)) : avg;
  }
  m.set(out); Core.markDirty(L, 'mask', 0, L.nv - 1);
}
function maskFromGroup(L, g) { // masque tout sauf le groupe g
  L.mask.fill(1);
  for (let t = 0; t < L.nt; t++) if (L.groups[t] === g) for (let k = 0; k < 3; k++) L.mask[L.idx[3 * t + k]] = 0;
  Core.markDirty(L, 'mask', 0, L.nv - 1);
}

// ------------------------------------------------------------ polygroupes / visibilité
function maxGroup(L) { let m = 0; for (let t = 0; t < L.nt; t++) if (L.groups[t] > m) m = L.groups[t]; return m; }
function groupFromMask(L) { // les faces non masquées et visibles forment un nouveau groupe
  const g = maxGroup(L) + 1; let n = 0;
  for (let t = 0; t < L.nt; t++) {
    if (L.hidden && L.hidden[t]) continue;
    const a = L.mask[L.idx[3 * t]], b = L.mask[L.idx[3 * t + 1]], c = L.mask[L.idx[3 * t + 2]];
    if (a + b + c < 1.5) { L.groups[t] = g; n++; }
  }
  L.dirty = L.dirty || {}; L.dirty.groups = true;
  return n;
}
function groupVisible(L) {
  const g = maxGroup(L) + 1; let n = 0;
  for (let t = 0; t < L.nt; t++) if (!(L.hidden && L.hidden[t])) { L.groups[t] = g; n++; }
  L.dirty = L.dirty || {}; L.dirty.groups = true; return n;
}
function autoGroups(L) {
  const { comp } = Core.connectedComponents(L.idx, L.nv);
  for (let t = 0; t < L.nt; t++) L.groups[t] = comp[L.idx[3 * t]];
  L.dirty = L.dirty || {}; L.dirty.groups = true;
}
function groupsByNormal(L, mesh, angleDeg) {
  // croissance de régions par angle entre normales de faces voisines
  const nt = L.nt, fn = mesh.fn, idx = L.idx;
  const E = Core.buildEdges(idx, L.nv);
  const nb = new Int32Array(nt * 3).fill(-1);
  for (let e = 0; e < E.ne; e++) if (E.ecount[e] === 2) { const h1 = E.eh1[e], h2 = E.eh2[e]; nb[h1] = (h2 / 3) | 0; nb[h2] = (h1 / 3) | 0; }
  const cosT = Math.cos(angleDeg * Math.PI / 180);
  const g = new Int32Array(nt).fill(-1); let ng = 0; const stack = [];
  const unit = (t) => { const x = fn[3 * t], y = fn[3 * t + 1], z = fn[3 * t + 2], l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };
  for (let s = 0; s < nt; s++) {
    if (g[s] >= 0) continue;
    const ref = unit(s); g[s] = ng; stack.push(s);
    while (stack.length) {
      const t = stack.pop();
      for (let k = 0; k < 3; k++) {
        const o = nb[3 * t + k]; if (o < 0 || g[o] >= 0) continue;
        const u = unit(o);
        if (u[0] * ref[0] + u[1] * ref[1] + u[2] * ref[2] >= cosT) { g[o] = ng; stack.push(o); }
      }
    }
    ng++;
  }
  for (let t = 0; t < nt; t++) L.groups[t] = g[t];
  L.dirty = L.dirty || {}; L.dirty.groups = true;
  return ng;
}
function setHidden(L, hidden) { L.hidden = hidden; L.vVis = null; L.dirty = L.dirty || {}; L.dirty.groups = true; }
function isolateGroup(L, g) { const h = new Uint8Array(L.nt); for (let t = 0; t < L.nt; t++) h[t] = L.groups[t] === g ? 0 : 1; setHidden(L, h); }
function hideGroup(L, g) { const h = L.hidden ? L.hidden.slice() : new Uint8Array(L.nt); for (let t = 0; t < L.nt; t++) if (L.groups[t] === g) h[t] = 1; setHidden(L, h); }
function showAll(L) { setHidden(L, null); }
function invertVisibility(L) { if (!L.hidden) return; const h = new Uint8Array(L.nt); for (let t = 0; t < L.nt; t++) h[t] = L.hidden[t] ? 0 : 1; setHidden(L, h); }

// ------------------------------------------------------------ polypaint
function fillColor(L, rgb, respectMask) {
  for (let v = 0; v < L.nv; v++) paintVertex(L.col, 4 * v, rgb, respectMask ? 1 - L.mask[v] : 1);
  Core.markDirty(L, 'col', 0, L.nv - 1);
}
function clearColor(L) { L.col.fill(0); Core.markDirty(L, 'col', 0, L.nv - 1); }

// ------------------------------------------------------------ alphas procéduraux
function makeAlphas(S = 128) {
  const mk = (f) => { const d = new Float32Array(S * S); for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) d[y * S + x] = Math.max(0, Math.min(1, f(x / (S - 1) * 2 - 1, y / (S - 1) * 2 - 1))); return { size: S, data: d }; };
  const hash = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
  const vnoise = (x, y) => { const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi; const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf); return (hash(xi, yi) * (1 - u) + hash(xi + 1, yi) * u) * (1 - v) + (hash(xi, yi + 1) * (1 - u) + hash(xi + 1, yi + 1) * u) * v; };
  const edge = (x, y) => { const r = Math.hypot(x, y); return r >= 1 ? 0 : 1 - Math.pow(r, 6); };
  return {
    none: null,
    noise: mk((x, y) => edge(x, y) * (0.55 * vnoise(x * 6 + 10, y * 6 + 10) + 0.3 * vnoise(x * 13 + 3, y * 13) + 0.15 * vnoise(x * 27, y * 27 + 7)) * 1.3),
    pores: mk((x, y) => {
      const gx = x * 5, gy = y * 5; let md = 9;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { const cx = Math.floor(gx) + i, cy = Math.floor(gy) + j; const px = cx + hash(cx, cy), py = cy + hash(cy, cx + 3); md = Math.min(md, Math.hypot(gx - px, gy - py)); }
      return edge(x, y) * Math.min(1, md * 1.6);
    }),
    square: mk((x, y) => { const m = Math.max(Math.abs(x), Math.abs(y)); return m > 0.95 ? 0 : (m > 0.8 ? (0.95 - m) / 0.15 : 1); }),
    stripes: mk((x, y) => edge(x, y) * (0.5 + 0.5 * Math.sin(y * 18))),
  };
}

const Sculpt = {
  BRUSHES, falloff, Stroke, dab, grabStart, grabMove, applyVerts, vertexVisibility,
  maskInvert, maskClear, maskBlur, maskFromGroup,
  maxGroup, groupFromMask, groupVisible, autoGroups, groupsByNormal, setHidden, isolateGroup, hideGroup, showAll, invertVisibility,
  fillColor, clearColor, makeAlphas,
};
root.Sculpt = Sculpt;
if (typeof module !== 'undefined' && module.exports) module.exports = Sculpt;
})(typeof window !== 'undefined' ? window : globalThis);
