/* Argile — cœur géométrique (aucune dépendance au navigateur, testable sous Node).
 * Maillages triangulaires indexés, adjacences, BVH avec refit, subdivision Loop
 * multirésolution à détails en repère local, remesh voxel (DynaMesh), OBJ. */
(function (root) {
'use strict';

// ---------------------------------------------------------------- utilitaires
class GrowF32 {
  constructor(n = 1024) { this.a = new Float32Array(n); this.n = 0; }
  push(x) { if (this.n >= this.a.length) this._grow(); this.a[this.n++] = x; }
  push3(x, y, z) { if (this.n + 3 > this.a.length) this._grow(); const a = this.a; a[this.n] = x; a[this.n + 1] = y; a[this.n + 2] = z; this.n += 3; }
  _grow() { const b = new Float32Array(this.a.length * 2); b.set(this.a); this.a = b; }
  view() { return this.a.subarray(0, this.n); }
  copy() { return this.a.slice(0, this.n); }
}
class GrowU32 {
  constructor(n = 1024) { this.a = new Uint32Array(n); this.n = 0; }
  push(x) { if (this.n >= this.a.length) { const b = new Uint32Array(this.a.length * 2); b.set(this.a); this.a = b; } this.a[this.n++] = x; }
  copy() { return this.a.slice(0, this.n); }
}

// ---------------------------------------------------------------- arêtes
// Regroupe les demi-arêtes par sommet minimal (tri par comptage), O(n).
function buildEdges(idx, nv) {
  const nt = (idx.length / 3) | 0, nh = nt * 3;
  const start = new Uint32Array(nv + 1);
  for (let h = 0; h < nh; h++) {
    const t = (h / 3) | 0, k = h - t * 3;
    const a = idx[h], b = idx[t * 3 + (k + 1) % 3];
    start[(a < b ? a : b) + 1]++;
  }
  for (let i = 0; i < nv; i++) start[i + 1] += start[i];
  const fill = start.slice(0, nv);
  const bucket = new Uint32Array(nh);
  const other = new Uint32Array(nh);
  for (let h = 0; h < nh; h++) {
    const t = (h / 3) | 0, k = h - t * 3;
    const a = idx[h], b = idx[t * 3 + (k + 1) % 3];
    const lo = a < b ? a : b;
    bucket[fill[lo]++] = h;
    other[h] = a < b ? b : a;
  }
  const heEdge = new Uint32Array(nh);
  const ea = new Uint32Array(nh), eb = new Uint32Array(nh);
  const eh1 = new Int32Array(nh), eh2 = new Int32Array(nh);
  const ecount = new Uint8Array(nh);
  let ne = 0;
  for (let v = 0; v < nv; v++) {
    const s = start[v], e = start[v + 1];
    for (let i = s; i < e; i++) {
      const h = bucket[i], o = other[h];
      let found = -1;
      for (let j = s; j < i; j++) { const h2 = bucket[j]; if (other[h2] === o) { found = heEdge[h2]; break; } }
      if (found < 0) {
        found = ne++; ea[found] = v; eb[found] = o; eh1[found] = h; eh2[found] = -1; ecount[found] = 1;
      } else {
        if (ecount[found] === 1) eh2[found] = h;
        if (ecount[found] < 255) ecount[found]++;
      }
      heEdge[h] = found;
    }
  }
  return { ne, ea: ea.slice(0, ne), eb: eb.slice(0, ne), eh1: eh1.slice(0, ne), eh2: eh2.slice(0, ne), ecount: ecount.slice(0, ne), heEdge };
}
function heOpposite(idx, h) { const t = (h / 3) | 0, k = h - t * 3; return idx[t * 3 + (k + 2) % 3]; }

// ---------------------------------------------------------------- normales
function computeNormals(pos, idx, nv, out) {
  const n = out || new Float32Array(nv * 3);
  n.fill(0);
  const nt = idx.length / 3;
  for (let t = 0; t < nt; t++) {
    const a = idx[3 * t] * 3, b = idx[3 * t + 1] * 3, c = idx[3 * t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    n[a] += x; n[a + 1] += y; n[a + 2] += z;
    n[b] += x; n[b + 1] += y; n[b + 2] += z;
    n[c] += x; n[c + 1] += y; n[c + 2] += z;
  }
  for (let i = 0; i < nv * 3; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]);
    if (l > 1e-20) { n[i] /= l; n[i + 1] /= l; n[i + 2] /= l; } else { n[i] = 0; n[i + 1] = 0; n[i + 2] = 1; }
  }
  return n;
}

// ---------------------------------------------------------------- BVH
const LEAF = 8;
class BVH {
  constructor(pos, idx) {
    this.pos = pos; this.idx = idx;
    const nt = this.nt = idx.length / 3;
    const maxNodes = Math.max(1, 2 * nt);
    this.bb = new Float32Array(maxNodes * 6);
    this.left = new Int32Array(maxNodes);
    this.right = new Int32Array(maxNodes);
    this.start = new Uint32Array(maxNodes);
    this.count = new Uint32Array(maxNodes);
    this.parent = new Int32Array(maxNodes);
    this.tris = new Uint32Array(nt);
    this.triLeaf = new Int32Array(nt);
    this.leafStamp = new Uint32Array(maxNodes);
    this.stampId = 1;
    this.stack = new Int32Array(512);
    this._build();
  }
  _build() {
    const { pos, idx, nt, tris } = this;
    const cen = new Float32Array(nt * 3);
    for (let t = 0; t < nt; t++) {
      tris[t] = t;
      const a = idx[3 * t] * 3, b = idx[3 * t + 1] * 3, c = idx[3 * t + 2] * 3;
      cen[3 * t] = (pos[a] + pos[b] + pos[c]) / 3;
      cen[3 * t + 1] = (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3;
      cen[3 * t + 2] = (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3;
    }
    let nn = 1;
    const work = [0, 0, nt]; // node, s, e
    this.parent[0] = -1;
    while (work.length) {
      const e = work.pop(), s = work.pop(), node = work.pop();
      this.start[node] = s; this.count[node] = e - s;
      if (e - s <= LEAF) { this.left[node] = -1; this.right[node] = -1; for (let i = s; i < e; i++) this.triLeaf[tris[i]] = node; continue; }
      let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
      for (let i = s; i < e; i++) {
        const t = tris[i] * 3; const x = cen[t], y = cen[t + 1], z = cen[t + 2];
        if (x < mnx) mnx = x; if (x > mxx) mxx = x; if (y < mny) mny = y; if (y > mxy) mxy = y; if (z < mnz) mnz = z; if (z > mxz) mxz = z;
      }
      const dx = mxx - mnx, dy = mxy - mny, dz = mxz - mnz;
      const ax = dx >= dy && dx >= dz ? 0 : (dy >= dz ? 1 : 2);
      const mid = ax === 0 ? (mnx + mxx) / 2 : ax === 1 ? (mny + mxy) / 2 : (mnz + mxz) / 2;
      let i = s, j = e - 1;
      while (i <= j) {
        if (cen[tris[i] * 3 + ax] < mid) i++;
        else { const tmp = tris[i]; tris[i] = tris[j]; tris[j] = tmp; j--; }
      }
      let m = i;
      if (m === s || m === e) m = (s + e) >> 1;
      const L = nn++, R = nn++;
      this.left[node] = L; this.right[node] = R;
      this.parent[L] = node; this.parent[R] = node;
      work.push(L, s, m, R, m, e);
    }
    this.nn = nn;
    this.refitAll();
  }
  _leafBounds(node) {
    const { pos, idx, tris, bb } = this;
    let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    const s = this.start[node], e = s + this.count[node];
    for (let i = s; i < e; i++) {
      const t = tris[i] * 3;
      for (let k = 0; k < 3; k++) {
        const v = idx[t + k] * 3; const x = pos[v], y = pos[v + 1], z = pos[v + 2];
        if (x < mnx) mnx = x; if (x > mxx) mxx = x; if (y < mny) mny = y; if (y > mxy) mxy = y; if (z < mnz) mnz = z; if (z > mxz) mxz = z;
      }
    }
    const o = node * 6; bb[o] = mnx; bb[o + 1] = mny; bb[o + 2] = mnz; bb[o + 3] = mxx; bb[o + 4] = mxy; bb[o + 5] = mxz;
  }
  refitAll() {
    const bb = this.bb;
    for (let n = this.nn - 1; n >= 0; n--) {
      const L = this.left[n];
      if (L < 0) { this._leafBounds(n); continue; }
      const R = this.right[n], o = n * 6, a = L * 6, b = R * 6;
      bb[o] = Math.min(bb[a], bb[b]); bb[o + 1] = Math.min(bb[a + 1], bb[b + 1]); bb[o + 2] = Math.min(bb[a + 2], bb[b + 2]);
      bb[o + 3] = Math.max(bb[a + 3], bb[b + 3]); bb[o + 4] = Math.max(bb[a + 4], bb[b + 4]); bb[o + 5] = Math.max(bb[a + 5], bb[b + 5]);
    }
  }
  // Refit conservateur (les boîtes ne font que grossir) pour une liste de triangles.
  refitTris(list, count) {
    const stamp = ++this.stampId, bb = this.bb;
    const leaves = [];
    for (let i = 0; i < count; i++) {
      const leaf = this.triLeaf[list[i]];
      if (this.leafStamp[leaf] !== stamp) { this.leafStamp[leaf] = stamp; this._leafBounds(leaf); leaves.push(leaf); }
    }
    for (const leaf of leaves) {
      let c = leaf, n = this.parent[c];
      while (n >= 0) {
        const o = n * 6, a = c * 6; let ch = false;
        if (bb[a] < bb[o]) { bb[o] = bb[a]; ch = true; } if (bb[a + 1] < bb[o + 1]) { bb[o + 1] = bb[a + 1]; ch = true; } if (bb[a + 2] < bb[o + 2]) { bb[o + 2] = bb[a + 2]; ch = true; }
        if (bb[a + 3] > bb[o + 3]) { bb[o + 3] = bb[a + 3]; ch = true; } if (bb[a + 4] > bb[o + 4]) { bb[o + 4] = bb[a + 4]; ch = true; } if (bb[a + 5] > bb[o + 5]) { bb[o + 5] = bb[a + 5]; ch = true; }
        if (!ch) break;
        c = n; n = this.parent[n];
      }
    }
  }
  // Lancer de rayon ; hidden = Uint8Array par triangle (optionnel)
  raycast(ox, oy, oz, dx, dy, dz, hidden) {
    const { pos, idx, bb, tris } = this;
    const nz0 = (x) => (Math.abs(x) < 1e-12 ? (x < 0 ? -1e-12 : 1e-12) : x);
    const ix = 1 / nz0(dx), iy = 1 / nz0(dy), iz = 1 / nz0(dz);
    const st = this.stack; let sp = 0; st[sp++] = 0;
    let best = Infinity, bestT = -1, bu = 0, bv = 0;
    while (sp > 0) {
      const n = st[--sp], o = n * 6;
      let t1 = (bb[o] - ox) * ix, t2 = (bb[o + 3] - ox) * ix;
      let tmin = Math.min(t1, t2), tmax = Math.max(t1, t2);
      t1 = (bb[o + 1] - oy) * iy; t2 = (bb[o + 4] - oy) * iy;
      tmin = Math.max(tmin, Math.min(t1, t2)); tmax = Math.min(tmax, Math.max(t1, t2));
      t1 = (bb[o + 2] - oz) * iz; t2 = (bb[o + 5] - oz) * iz;
      tmin = Math.max(tmin, Math.min(t1, t2)); tmax = Math.min(tmax, Math.max(t1, t2));
      if (!(tmax >= Math.max(tmin, 0)) || tmin > best) continue;
      const L = this.left[n];
      if (L >= 0) { if (sp + 2 >= st.length) continue; st[sp++] = L; st[sp++] = this.right[n]; continue; }
      const s = this.start[n], e = s + this.count[n];
      for (let i = s; i < e; i++) {
        const t = tris[i];
        if (hidden && hidden[t]) continue;
        const a = idx[3 * t] * 3, b = idx[3 * t + 1] * 3, c = idx[3 * t + 2] * 3;
        const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2];
        const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2];
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (det > -1e-14 && det < 1e-14) continue;
        const inv = 1 / det;
        const tx = ox - pos[a], ty = oy - pos[a + 1], tz = oz - pos[a + 2];
        const u = (tx * px + ty * py + tz * pz) * inv; if (u < -1e-6 || u > 1 + 1e-6) continue;
        const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv; if (v < -1e-6 || u + v > 1 + 1e-6) continue;
        const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (tt > 1e-9 && tt < best) { best = tt; bestT = t; bu = u; bv = v; }
      }
    }
    return bestT < 0 ? null : { t: best, tri: bestT, u: bu, v: bv };
  }
  // Appelle cb(tri) pour chaque triangle dont la boîte touche la sphère
  sphereTris(cx, cy, cz, r, cb) {
    const { bb, tris } = this; const r2 = r * r;
    const st = this.stack; let sp = 0; st[sp++] = 0;
    while (sp > 0) {
      const n = st[--sp], o = n * 6;
      let d = 0, q;
      q = cx < bb[o] ? bb[o] - cx : cx > bb[o + 3] ? cx - bb[o + 3] : 0; d += q * q;
      q = cy < bb[o + 1] ? bb[o + 1] - cy : cy > bb[o + 4] ? cy - bb[o + 4] : 0; d += q * q;
      q = cz < bb[o + 2] ? bb[o + 2] - cz : cz > bb[o + 5] ? cz - bb[o + 5] : 0; d += q * q;
      if (d > r2) continue;
      const L = this.left[n];
      if (L >= 0) { if (sp + 2 >= st.length) continue; st[sp++] = L; st[sp++] = this.right[n]; continue; }
      const s = this.start[n], e = s + this.count[n];
      for (let i = s; i < e; i++) cb(tris[i]);
    }
  }
  // Point le plus proche ; renvoie {tri, x,y,z, u,v,w, d2}
  closest(px, py, pz, out) {
    const { pos, idx, bb, tris } = this;
    const st = this.stack; let sp = 0; st[sp++] = 0;
    let best = Infinity;
    const tmp = { x: 0, y: 0, z: 0, u: 0, v: 0, w: 0 };
    out.tri = -1;
    const boxD = (n) => {
      const o = n * 6; let d = 0, q;
      q = px < bb[o] ? bb[o] - px : px > bb[o + 3] ? px - bb[o + 3] : 0; d += q * q;
      q = py < bb[o + 1] ? bb[o + 1] - py : py > bb[o + 4] ? py - bb[o + 4] : 0; d += q * q;
      q = pz < bb[o + 2] ? bb[o + 2] - pz : pz > bb[o + 5] ? pz - bb[o + 5] : 0; d += q * q;
      return d;
    };
    while (sp > 0) {
      const n = st[--sp];
      if (boxD(n) >= best) continue;
      const L = this.left[n];
      if (L >= 0) {
        const R = this.right[n]; const dl = boxD(L), dr = boxD(R);
        if (sp + 2 >= st.length) continue;
        if (dl < dr) { st[sp++] = R; st[sp++] = L; } else { st[sp++] = L; st[sp++] = R; }
        continue;
      }
      const s = this.start[n], e = s + this.count[n];
      for (let i = s; i < e; i++) {
        const t = tris[i];
        closestOnTri(px, py, pz, pos, idx[3 * t] * 3, idx[3 * t + 1] * 3, idx[3 * t + 2] * 3, tmp);
        const dx = tmp.x - px, dy = tmp.y - py, dz = tmp.z - pz, d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < best) { best = d2; out.tri = t; out.x = tmp.x; out.y = tmp.y; out.z = tmp.z; out.u = tmp.u; out.v = tmp.v; out.w = tmp.w; }
      }
    }
    out.d2 = best;
    return out;
  }
}

// Ericson, Real-Time Collision Detection 5.1.5 ; barycentriques (u:a, v:b, w:c)
function closestOnTri(px, py, pz, P, a, b, c, o) {
  const ax = P[a], ay = P[a + 1], az = P[a + 2];
  const abx = P[b] - ax, aby = P[b + 1] - ay, abz = P[b + 2] - az;
  const acx = P[c] - ax, acy = P[c + 1] - ay, acz = P[c + 2] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) { o.x = ax; o.y = ay; o.z = az; o.u = 1; o.v = 0; o.w = 0; return; }
  const bpx = px - P[b], bpy = py - P[b + 1], bpz = pz - P[b + 2];
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) { o.x = P[b]; o.y = P[b + 1]; o.z = P[b + 2]; o.u = 0; o.v = 1; o.w = 0; return; }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3); o.x = ax + v * abx; o.y = ay + v * aby; o.z = az + v * abz; o.u = 1 - v; o.v = v; o.w = 0; return;
  }
  const cpx = px - P[c], cpy = py - P[c + 1], cpz = pz - P[c + 2];
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) { o.x = P[c]; o.y = P[c + 1]; o.z = P[c + 2]; o.u = 0; o.v = 0; o.w = 1; return; }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6); o.x = ax + w * acx; o.y = ay + w * acy; o.z = az + w * acz; o.u = 1 - w; o.v = 0; o.w = w; return;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    o.x = P[b] + w * (P[c] - P[b]); o.y = P[b + 1] + w * (P[c + 1] - P[b + 1]); o.z = P[b + 2] + w * (P[c + 2] - P[b + 2]);
    o.u = 0; o.v = 1 - w; o.w = w; return;
  }
  const den = 1 / (va + vb + vc); const v = vb * den, w = vc * den;
  o.x = ax + abx * v + acx * w; o.y = ay + aby * v + acy * w; o.z = az + abz * v + acz * w; o.u = 1 - v - w; o.v = v; o.w = w;
}

// ---------------------------------------------------------------- Mesh (structure d'édition d'un niveau)
class Mesh {
  constructor(level) {
    this.level = level;
    const { pos, idx, nv } = level;
    this.pos = pos; this.idx = idx; this.nv = nv; this.nt = idx.length / 3;
    const E = buildEdges(idx, nv);
    // voisins sommet-sommet
    const deg = new Uint32Array(nv + 1);
    const bnd = new Uint8Array(nv);
    for (let e = 0; e < E.ne; e++) { deg[E.ea[e] + 1]++; deg[E.eb[e] + 1]++; if (E.ecount[e] === 1) { bnd[E.ea[e]] = 1; bnd[E.eb[e]] = 1; } }
    for (let i = 0; i < nv; i++) deg[i + 1] += deg[i];
    const vv = new Uint32Array(deg[nv]); const f = deg.slice(0, nv);
    for (let e = 0; e < E.ne; e++) { const a = E.ea[e], b = E.eb[e]; vv[f[a]++] = b; vv[f[b]++] = a; }
    this.vvStart = deg; this.vv = vv; this.boundary = bnd;
    // sommet -> triangles
    const vts = new Uint32Array(nv + 1);
    for (let i = 0; i < idx.length; i++) vts[idx[i] + 1]++;
    for (let i = 0; i < nv; i++) vts[i + 1] += vts[i];
    const vt = new Uint32Array(idx.length); const g = vts.slice(0, nv);
    for (let i = 0; i < idx.length; i++) vt[g[idx[i]]++] = (i / 3) | 0;
    this.vtStart = vts; this.vt = vt;
    this.fn = new Float32Array(this.nt * 3);
    this.nrm = level.nrm || (level.nrm = new Float32Array(nv * 3));
    this.vStamp = new Uint32Array(nv); this.tStamp = new Uint32Array(this.nt); this.stampId = 1;
    this.refreshAll();
    this.bvh = new BVH(pos, idx);
    this.tmpT = new Uint32Array(1024); this.tmpV = new Uint32Array(1024);
  }
  refreshAll() {
    for (let t = 0; t < this.nt; t++) this.faceNormal(t);
    for (let v = 0; v < this.nv; v++) this.vertexNormal(v);
    if (this.bvh) this.bvh.refitAll();
  }
  faceNormal(t) {
    const pos = this.pos, idx = this.idx;
    const a = idx[3 * t] * 3, b = idx[3 * t + 1] * 3, c = idx[3 * t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    this.fn[3 * t] = uy * vz - uz * vy; this.fn[3 * t + 1] = uz * vx - ux * vz; this.fn[3 * t + 2] = ux * vy - uy * vx;
  }
  vertexNormal(v) {
    let x = 0, y = 0, z = 0; const fn = this.fn;
    for (let i = this.vtStart[v], e = this.vtStart[v + 1]; i < e; i++) { const t = this.vt[i] * 3; x += fn[t]; y += fn[t + 1]; z += fn[t + 2]; }
    const l = Math.hypot(x, y, z), n = this.nrm, o = v * 3;
    if (l > 1e-20) { n[o] = x / l; n[o + 1] = y / l; n[o + 2] = z / l; }
  }
  // Met à jour normales + BVH pour une liste de sommets déplacés
  updateAfterMove(vlist, count) {
    const stamp = ++this.stampId;
    let nt = 0, nvv = 0;
    for (let i = 0; i < count; i++) {
      const v = vlist[i];
      for (let j = this.vtStart[v], e = this.vtStart[v + 1]; j < e; j++) {
        const t = this.vt[j];
        if (this.tStamp[t] !== stamp) { this.tStamp[t] = stamp; if (nt >= this.tmpT.length) this.tmpT = growU(this.tmpT); this.tmpT[nt++] = t; }
      }
    }
    for (let i = 0; i < nt; i++) {
      const t = this.tmpT[i]; this.faceNormal(t);
      for (let k = 0; k < 3; k++) {
        const v = this.idx[3 * t + k];
        if (this.vStamp[v] !== stamp) { this.vStamp[v] = stamp; if (nvv >= this.tmpV.length) this.tmpV = growU(this.tmpV); this.tmpV[nvv++] = v; }
      }
    }
    for (let i = 0; i < nvv; i++) this.vertexNormal(this.tmpV[i]);
    this.bvh.refitTris(this.tmpT, nt);
    markDirtyList(this.level, 'pos', this.tmpV, nvv);
  }
}
function growU(a) { const b = new Uint32Array(a.length * 2); b.set(a); return b; }
// Suivi des zones à renvoyer au GPU, par blocs de DB sommets
const DB = 1024;
function dirtyBlocks(level, key) {
  const d = level.dirty || (level.dirty = {});
  const n = Math.max(1, Math.ceil(level.nv / DB));
  let b = d[key];
  if (!b || b.length !== n) b = d[key] = new Uint8Array(n);
  return b;
}
function markDirty(level, key, mn, mx) {
  if (mx < mn) return;
  dirtyBlocks(level, key).fill(1, (mn / DB) | 0, ((mx / DB) | 0) + 1);
}
function markDirtyList(level, key, list, count) {
  const b = dirtyBlocks(level, key);
  for (let i = 0; i < count; i++) b[(list[i] / DB) | 0] = 1;
}
function fullDirty(level) {
  level.dirty = { groups: true };
  for (const k of ['pos', 'col', 'mask']) markDirty(level, k, 0, level.nv - 1);
}
function markAllDirty(level) {
  level.nrmDirty = true;
  fullDirty(level);
}

// ---------------------------------------------------------------- niveaux / subtools
let _stId = 1;
function makeLevel(pos, idx, nv, opts = {}) {
  const nt = idx.length / 3;
  const L = {
    pos, idx, nv, nt,
    col: opts.col || new Uint8Array(nv * 4),
    mask: opts.mask || new Float32Array(nv),
    groups: opts.groups || new Uint32Array(nt),
    hidden: opts.hidden || null,
    qflags: opts.qflags || null,
    detail: null, ref: null, op: null, firstNb: null,
    mesh: null, nrm: null, gpu: null, dirty: null,
  };
  markAllDirty(L);
  return L;
}
function makeSubtool(name, level) {
  return { id: _stId++, name, levels: [level], cur: 0, visible: true };
}
function curLevel(st) { return st.levels[st.cur]; }
function getMesh(level) {
  if (!level.mesh) level.mesh = new Mesh(level);
  return level.mesh;
}
function dropMesh(level) { level.mesh = null; }

// ---------------------------------------------------------------- subdivision de Loop
function buildLoopOp(idx, nv) {
  const E = buildEdges(idx, nv);
  const { ne, ea, eb, eh1, eh2, ecount, heEdge } = E;
  const deg = new Uint32Array(nv), bdeg = new Uint32Array(nv);
  for (let e = 0; e < ne; e++) {
    deg[ea[e]]++; deg[eb[e]]++;
    if (ecount[e] !== 2) { bdeg[ea[e]]++; bdeg[eb[e]]++; }
  }
  // poids des anciens sommets
  const nbStart = new Uint32Array(nv + 1);
  for (let v = 0; v < nv; v++) nbStart[v + 1] = nbStart[v] + (bdeg[v] === 0 ? deg[v] : (bdeg[v] === 2 ? 2 : 0));
  const nbList = new Uint32Array(nbStart[nv]); const nbW = new Float32Array(nbStart[nv]);
  const selfW = new Float32Array(nv);
  const fill = nbStart.slice(0, nv);
  for (let v = 0; v < nv; v++) {
    if (bdeg[v] === 0) { const n = deg[v]; const beta = n === 3 ? 3 / 16 : (n > 0 ? 3 / (8 * n) : 0); selfW[v] = 1 - n * beta; nbW[nbStart[v]] = beta; }
    else if (bdeg[v] === 2) selfW[v] = 3 / 4;
    else selfW[v] = 1;
  }
  for (let e = 0; e < ne; e++) {
    const a = ea[e], b = eb[e], bnd = ecount[e] !== 2;
    if (bdeg[a] === 0) { nbList[fill[a]] = b; nbW[fill[a]++] = nbW[nbStart[a]]; }
    else if (bdeg[a] === 2 && bnd) { nbList[fill[a]] = b; nbW[fill[a]++] = 1 / 8; }
    if (bdeg[b] === 0) { nbList[fill[b]] = a; nbW[fill[b]++] = nbW[nbStart[b]]; }
    else if (bdeg[b] === 2 && bnd) { nbList[fill[b]] = a; nbW[fill[b]++] = 1 / 8; }
  }
  const ec = new Int32Array(ne), ed = new Int32Array(ne);
  for (let e = 0; e < ne; e++) {
    if (ecount[e] === 2) { ec[e] = heOpposite(idx, eh1[e]); ed[e] = heOpposite(idx, eh2[e]); }
    else { ec[e] = -1; ed[e] = -1; }
  }
  const nt = idx.length / 3;
  const nidx = new Uint32Array(nt * 12);
  for (let t = 0; t < nt; t++) {
    const a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2];
    const mab = nv + heEdge[3 * t], mbc = nv + heEdge[3 * t + 1], mca = nv + heEdge[3 * t + 2];
    const o = t * 12;
    nidx[o] = a; nidx[o + 1] = mab; nidx[o + 2] = mca;
    nidx[o + 3] = b; nidx[o + 4] = mbc; nidx[o + 5] = mab;
    nidx[o + 6] = c; nidx[o + 7] = mca; nidx[o + 8] = mbc;
    nidx[o + 9] = mab; nidx[o + 10] = mbc; nidx[o + 11] = mca;
  }
  return { nv, ne, nbStart, nbList, nbW, selfW, ea, eb, ec, ed, nidx };
}
function applyLoop(op, src, comps) {
  const { nv, ne, nbStart, nbList, nbW, selfW, ea, eb, ec, ed } = op;
  const dst = new Float32Array((nv + ne) * comps);
  for (let v = 0; v < nv; v++) {
    const w0 = selfW[v];
    for (let k = 0; k < comps; k++) {
      let s = w0 * src[v * comps + k];
      for (let i = nbStart[v], e = nbStart[v + 1]; i < e; i++) s += nbW[i] * src[nbList[i] * comps + k];
      dst[v * comps + k] = s;
    }
  }
  for (let e = 0; e < ne; e++) {
    const a = ea[e] * comps, b = eb[e] * comps, o = (nv + e) * comps;
    if (ec[e] >= 0) {
      const c = ec[e] * comps, d = ed[e] * comps;
      for (let k = 0; k < comps; k++) dst[o + k] = 0.375 * (src[a + k] + src[b + k]) + 0.125 * (src[c + k] + src[d + k]);
    } else for (let k = 0; k < comps; k++) dst[o + k] = 0.5 * (src[a + k] + src[b + k]);
  }
  return dst;
}
function midColors(op, col) {
  const { nv, ne, ea, eb } = op;
  const out = new Uint8Array((nv + ne) * 4);
  out.set(col.subarray(0, nv * 4));
  for (let e = 0; e < ne; e++) {
    const a = ea[e] * 4, b = eb[e] * 4, o = (nv + e) * 4;
    for (let k = 0; k < 4; k++) out[o + k] = (col[a + k] + col[b + k] + 1) >> 1;
  }
  return out;
}
function computeFirstNb(idx, nv) {
  const f = new Int32Array(nv).fill(-1);
  for (let i = 0; i < idx.length; i++) { const v = idx[i]; if (f[v] < 0) { const t = (i / 3) | 0, k = i - t * 3; f[v] = idx[t * 3 + (k + 1) % 3]; } }
  for (let v = 0; v < nv; v++) if (f[v] < 0) f[v] = v;
  return new Uint32Array(f.buffer);
}
// repère local (n, t, b) sur la surface de base
function frame(base, nrm, firstNb, v, out) {
  const o = v * 3, nx = nrm[o], ny = nrm[o + 1], nz = nrm[o + 2];
  const j = firstNb[v] * 3;
  let ex = base[j] - base[o], ey = base[j + 1] - base[o + 1], ez = base[j + 2] - base[o + 2];
  const d = ex * nx + ey * ny + ez * nz; ex -= d * nx; ey -= d * ny; ez -= d * nz;
  let l = Math.hypot(ex, ey, ez);
  if (l < 1e-20) { // repli : axe le moins aligné
    if (Math.abs(nx) < 0.9) { ex = 0; ey = -nz; ez = ny; } else { ex = nz; ey = 0; ez = -nx; }
    l = Math.hypot(ex, ey, ez);
  }
  ex /= l; ey /= l; ez /= l;
  out[0] = nx; out[1] = ny; out[2] = nz; out[3] = ex; out[4] = ey; out[5] = ez;
  out[6] = ny * ez - nz * ey; out[7] = nz * ex - nx * ez; out[8] = nx * ey - ny * ex;
}
function encodeDetail(pos, base, idx, nv, firstNb) {
  const nrm = computeNormals(base, idx, nv);
  const det = new Float32Array(nv * 3), F = new Float32Array(9);
  for (let v = 0; v < nv; v++) {
    frame(base, nrm, firstNb, v, F); const o = v * 3;
    const dx = pos[o] - base[o], dy = pos[o + 1] - base[o + 1], dz = pos[o + 2] - base[o + 2];
    det[o] = dx * F[0] + dy * F[1] + dz * F[2];
    det[o + 1] = dx * F[3] + dy * F[4] + dz * F[5];
    det[o + 2] = dx * F[6] + dy * F[7] + dz * F[8];
  }
  return det;
}
function decodeDetail(base, det, idx, nv, firstNb, out) {
  const nrm = computeNormals(base, idx, nv);
  const F = new Float32Array(9);
  for (let v = 0; v < nv; v++) {
    frame(base, nrm, firstNb, v, F); const o = v * 3;
    const a = det[o], b = det[o + 1], c = det[o + 2];
    out[o] = base[o] + a * F[0] + b * F[3] + c * F[6];
    out[o + 1] = base[o + 1] + a * F[1] + b * F[4] + c * F[7];
    out[o + 2] = base[o + 2] + a * F[2] + b * F[5] + c * F[8];
  }
}

// Ajoute un niveau de subdivision au sommet de la pile (on doit être au niveau max)
function subtoolDivide(st) {
  while (st.cur < st.levels.length - 1) subtoolStepUp(st);
  const lo = st.levels[st.cur];
  const op = lo.op || (lo.op = buildLoopOp(lo.idx, lo.nv));
  const pos = applyLoop(op, lo.pos, 3);
  const nv = op.nv + op.ne;
  const mask = applyLoop(op, lo.mask, 1);
  const col = midColors(op, lo.col);
  const groups = new Uint32Array(lo.nt * 4);
  for (let t = 0; t < lo.nt; t++) { const g = lo.groups[t]; groups[4 * t] = g; groups[4 * t + 1] = g; groups[4 * t + 2] = g; groups[4 * t + 3] = g; }
  let hidden = null;
  if (lo.hidden) { hidden = new Uint8Array(lo.nt * 4); for (let t = 0; t < lo.nt; t++) if (lo.hidden[t]) hidden.fill(1, 4 * t, 4 * t + 4); }
  const hi = makeLevel(pos, op.nidx, nv, { col, mask, groups, hidden });
  hi.firstNb = computeFirstNb(hi.idx, nv);
  hi.detail = new Float32Array(nv * 3);
  hi.ref = pos.slice();
  dropMesh(lo);
  st.levels.push(hi);
  st.cur = st.levels.length - 1;
  return hi;
}
function subtoolStepUp(st) {
  if (st.cur >= st.levels.length - 1) return;
  const lo = st.levels[st.cur], hi = st.levels[st.cur + 1];
  const op = lo.op || (lo.op = buildLoopOp(lo.idx, lo.nv));
  const base = applyLoop(op, lo.pos, 3);
  decodeDetail(base, hi.detail, hi.idx, hi.nv, hi.firstNb, hi.pos);
  hi.ref = hi.pos.slice();
  dropMesh(lo);
  st.cur++;
  if (hi.mesh) hi.mesh.refreshAll();
  markAllDirty(hi);
}
function subtoolStepDown(st) {
  if (st.cur <= 0) return;
  const hi = st.levels[st.cur], lo = st.levels[st.cur - 1];
  const n = lo.nv * 3, hp = hi.pos, hr = hi.ref, lp = lo.pos;
  for (let i = 0; i < n; i++) lp[i] += hp[i] - hr[i];
  const op = lo.op || (lo.op = buildLoopOp(lo.idx, lo.nv));
  const base = applyLoop(op, lp, 3);
  hi.detail = encodeDetail(hp, base, hi.idx, hi.nv, hi.firstNb);
  dropMesh(hi);
  st.cur--;
  if (lo.mesh) lo.mesh.refreshAll();
  markAllDirty(lo);
}
function subtoolSetLevel(st, k) {
  k = Math.max(0, Math.min(st.levels.length - 1, k));
  while (st.cur < k) subtoolStepUp(st);
  while (st.cur > k) subtoolStepDown(st);
}
function subtoolDelLower(st) {
  if (st.cur === 0) return false;
  const L = st.levels[st.cur];
  L.detail = null; L.ref = null; L.firstNb = null;
  st.levels = st.levels.slice(st.cur); st.cur = 0;
  return true;
}
function subtoolDelHigher(st) {
  if (st.cur === st.levels.length - 1) return false;
  st.levels = st.levels.slice(0, st.cur + 1);
  return true;
}
// Transformation affine (rotation*échelle uniforme + translation) appliquée à tous les niveaux
function subtoolTransform(st, m /* 3x3 colonne */, tx, ty, tz, s) {
  for (const L of st.levels) {
    for (const arr of [L.pos, L.ref]) {
      if (!arr) continue;
      for (let i = 0; i < arr.length; i += 3) {
        const x = arr[i], y = arr[i + 1], z = arr[i + 2];
        arr[i] = m[0] * x + m[3] * y + m[6] * z + tx;
        arr[i + 1] = m[1] * x + m[4] * y + m[7] * z + ty;
        arr[i + 2] = m[2] * x + m[5] * y + m[8] * z + tz;
      }
    }
    if (L.detail && s !== 1) for (let i = 0; i < L.detail.length; i++) L.detail[i] *= s;
    if (L.mesh) L.mesh.refreshAll();
    markAllDirty(L);
  }
}

// ---------------------------------------------------------------- primitives
function icosphere(sub, radius = 1) {
  const t = (1 + Math.sqrt(5)) / 2;
  let P = [-1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, 0, 0, -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, t, 0, -1, t, 0, 1, -t, 0, -1, -t, 0, 1];
  let I = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];
  let pos = new Float32Array(P), idx = new Uint32Array(I), nv = 12;
  for (let s = 0; s < sub; s++) {
    const E = buildEdges(idx, nv);
    const np = new Float32Array((nv + E.ne) * 3); np.set(pos);
    for (let e = 0; e < E.ne; e++) for (let k = 0; k < 3; k++) np[(nv + e) * 3 + k] = (pos[E.ea[e] * 3 + k] + pos[E.eb[e] * 3 + k]) / 2;
    const nt = idx.length / 3, ni = new Uint32Array(nt * 12);
    for (let q = 0; q < nt; q++) {
      const a = idx[3 * q], b = idx[3 * q + 1], c = idx[3 * q + 2];
      const ab = nv + E.heEdge[3 * q], bc = nv + E.heEdge[3 * q + 1], ca = nv + E.heEdge[3 * q + 2];
      ni.set([a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca], q * 12);
    }
    pos = np; idx = ni; nv += E.ne;
  }
  for (let i = 0; i < pos.length; i += 3) { const l = Math.hypot(pos[i], pos[i + 1], pos[i + 2]) / radius; pos[i] /= l; pos[i + 1] /= l; pos[i + 2] /= l; }
  return { pos, idx, nv };
}
function box(n, half = 0.8) {
  // cube à faces quadrillées n×n, sommets partagés via une table de hachage
  const map = new Map(); const P = []; const I = [];
  const key = (x, y, z) => x + ',' + y + ',' + z;
  const vid = (x, y, z) => { const k = key(x, y, z); let i = map.get(k); if (i === undefined) { i = P.length / 3; map.set(k, i); P.push((x / n * 2 - 1) * half, (y / n * 2 - 1) * half, (z / n * 2 - 1) * half); } return i; };
  const faces = [
    (u, v) => [n, u, v], (u, v) => [0, v, u], (u, v) => [v, n, u], (u, v) => [u, 0, v], (u, v) => [u, v, n], (u, v) => [v, u, 0],
  ];
  for (const F of faces) for (let u = 0; u < n; u++) for (let v = 0; v < n; v++) {
    const a = vid(...F(u, v)), b = vid(...F(u + 1, v)), c = vid(...F(u + 1, v + 1)), d = vid(...F(u, v + 1));
    I.push(a, b, c, a, c, d);
  }
  const pos = new Float32Array(P), idx = new Uint32Array(I);
  fixOrientation(pos, idx);
  return { pos, idx, nv: P.length / 3 };
}
function torus(nu, nv_, R = 0.75, r = 0.3) {
  const pos = new Float32Array(nu * nv_ * 3), idx = new Uint32Array(nu * nv_ * 6);
  let p = 0, q = 0;
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv_; j++) {
    const u = i / nu * Math.PI * 2, v = j / nv_ * Math.PI * 2;
    pos[p++] = (R + r * Math.cos(v)) * Math.cos(u); pos[p++] = r * Math.sin(v); pos[p++] = (R + r * Math.cos(v)) * Math.sin(u);
  }
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv_; j++) {
    const a = i * nv_ + j, b = ((i + 1) % nu) * nv_ + j, c = ((i + 1) % nu) * nv_ + (j + 1) % nv_, d = i * nv_ + (j + 1) % nv_;
    idx[q++] = a; idx[q++] = c; idx[q++] = b; idx[q++] = a; idx[q++] = d; idx[q++] = c;
  }
  fixOrientation(pos, idx);
  return { pos, idx, nv: nu * nv_ };
}
// Oriente les normales vers l'extérieur (volume signé > 0)
function fixOrientation(pos, idx) {
  let vol = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    vol += pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c]) + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
  }
  if (vol < 0) for (let t = 0; t < idx.length; t += 3) { const x = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = x; }
  return vol;
}

// ---------------------------------------------------------------- composantes connexes / groupes
function connectedComponents(idx, nv) {
  const parent = new Int32Array(nv); for (let i = 0; i < nv; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let t = 0; t < idx.length; t += 3) {
    const a = find(idx[t]), b = find(idx[t + 1]), c = find(idx[t + 2]);
    if (a !== b) parent[b] = a; const a2 = find(a); if (a2 !== find(c)) parent[find(c)] = a2;
  }
  const label = new Int32Array(nv).fill(-1); let n = 0;
  const comp = new Uint32Array(nv);
  for (let v = 0; v < nv; v++) { const r = find(v); if (label[r] < 0) label[r] = n++; comp[v] = label[r]; }
  return { comp, n };
}

// ---------------------------------------------------------------- fusion / suppression
function mergeLevels(list) {
  let nv = 0, nt = 0; for (const L of list) { nv += L.nv; nt += L.nt; }
  const pos = new Float32Array(nv * 3), idx = new Uint32Array(nt * 3), col = new Uint8Array(nv * 4), groups = new Uint32Array(nt), mask = new Float32Array(nv);
  let ov = 0, ot = 0, og = 0;
  for (const L of list) {
    pos.set(L.pos, ov * 3); col.set(L.col, ov * 4); mask.set(L.mask, ov);
    let mg = 0;
    for (let i = 0; i < L.nt * 3; i++) idx[ot * 3 + i] = L.idx[i] + ov;
    for (let t = 0; t < L.nt; t++) { groups[ot + t] = L.groups[t] + og; if (L.groups[t] > mg) mg = L.groups[t]; }
    ov += L.nv; ot += L.nt; og += mg + 1;
  }
  return makeLevel(pos, idx, nv, { col, groups, mask });
}
// Garde les triangles où keep[t] est vrai et compacte les sommets
function compactLevel(L, keep) {
  const remap = new Int32Array(L.nv).fill(-1); let nv = 0, nt = 0;
  for (let t = 0; t < L.nt; t++) if (keep[t]) { nt++; for (let k = 0; k < 3; k++) { const v = L.idx[3 * t + k]; if (remap[v] < 0) remap[v] = nv++; } }
  const pos = new Float32Array(nv * 3), col = new Uint8Array(nv * 4), mask = new Float32Array(nv), idx = new Uint32Array(nt * 3), groups = new Uint32Array(nt);
  for (let v = 0; v < L.nv; v++) { const r = remap[v]; if (r < 0) continue; pos[3 * r] = L.pos[3 * v]; pos[3 * r + 1] = L.pos[3 * v + 1]; pos[3 * r + 2] = L.pos[3 * v + 2]; col.set(L.col.subarray(4 * v, 4 * v + 4), 4 * r); mask[r] = L.mask[v]; }
  let q = 0;
  for (let t = 0; t < L.nt; t++) if (keep[t]) { for (let k = 0; k < 3; k++) idx[3 * q + k] = remap[L.idx[3 * t + k]]; groups[q] = L.groups[t]; q++; }
  return makeLevel(pos, idx, nv, { col, groups, mask });
}

// ---------------------------------------------------------------- DynaMesh (remesh voxel + surface nets)
function remeshVoxel(L, res, opts = {}) {
  const { pos, idx, nv, nt } = L;
  const project = opts.project !== false;
  let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (let i = 0; i < nv * 3; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    if (x < mnx) mnx = x; if (x > mxx) mxx = x; if (y < mny) mny = y; if (y > mxy) mxy = y; if (z < mnz) mnz = z; if (z > mxz) mxz = z;
  }
  const maxDim = Math.max(mxx - mnx, mxy - mny, mxz - mnz) || 1;
  const h = maxDim / res, pad = 3;
  const ox = mnx - pad * h, oy = mny - pad * h, oz = mnz - pad * h;
  const NX = Math.ceil((mxx - mnx) / h) + 2 * pad + 1, NY = Math.ceil((mxy - mny) / h) + 2 * pad + 1, NZ = Math.ceil((mxz - mnz) / h) + 2 * pad + 1;
  const N = NX * NY * NZ;
  if (N > 80e6) throw new Error('Résolution trop élevée pour ce modèle (' + Math.round(N / 1e6) + ' M voxels).');
  const big = 4 * h;
  const dist = new Float32Array(N).fill(big * big);
  const tmp = { x: 0, y: 0, z: 0 };
  const SXY = NX * NY;
  const band = 1.6 * h;
  for (let t = 0; t < nt; t++) {
    if (L.hidden && L.hidden[t]) continue;
    const a = idx[3 * t] * 3, b = idx[3 * t + 1] * 3, c = idx[3 * t + 2] * 3;
    const tx0 = Math.min(pos[a], pos[b], pos[c]) - band, tx1 = Math.max(pos[a], pos[b], pos[c]) + band;
    const ty0 = Math.min(pos[a + 1], pos[b + 1], pos[c + 1]) - band, ty1 = Math.max(pos[a + 1], pos[b + 1], pos[c + 1]) + band;
    const tz0 = Math.min(pos[a + 2], pos[b + 2], pos[c + 2]) - band, tz1 = Math.max(pos[a + 2], pos[b + 2], pos[c + 2]) + band;
    const i0 = Math.max(0, Math.ceil((tx0 - ox) / h)), i1 = Math.min(NX - 1, Math.floor((tx1 - ox) / h));
    const j0 = Math.max(0, Math.ceil((ty0 - oy) / h)), j1 = Math.min(NY - 1, Math.floor((ty1 - oy) / h));
    const k0 = Math.max(0, Math.ceil((tz0 - oz) / h)), k1 = Math.min(NZ - 1, Math.floor((tz1 - oz) / h));
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const px = ox + i * h, py = oy + j * h, pz = oz + k * h;
      closestOnTri(px, py, pz, pos, a, b, c, tmp);
      const dx = tmp.x - px, dy = tmp.y - py, dz = tmp.z - pz, d2 = dx * dx + dy * dy + dz * dz;
      const g = i + j * NX + k * SXY;
      if (d2 < dist[g]) dist[g] = d2;
    }
  }
  for (let g = 0; g < N; g++) dist[g] = Math.sqrt(dist[g]);
  // remplissage depuis l'extérieur (6-connexité), bloqué près de la surface
  const thr = 0.5 * h * 1.02;
  const outside = new Uint8Array(N);
  const queue = new Int32Array(N); let qh = 0, qt = 0;
  const pushIf = (g) => { if (!outside[g] && dist[g] > thr) { outside[g] = 1; queue[qt++] = g; } };
  for (let k = 0; k < NZ; k++) for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    if (i === 0 || j === 0 || k === 0 || i === NX - 1 || j === NY - 1 || k === NZ - 1) pushIf(i + j * NX + k * SXY);
  }
  while (qh < qt) {
    const g = queue[qh++]; const i = g % NX, j = ((g / NX) | 0) % NY, k = (g / SXY) | 0;
    if (i > 0) pushIf(g - 1); if (i < NX - 1) pushIf(g + 1);
    if (j > 0) pushIf(g - NX); if (j < NY - 1) pushIf(g + NX);
    if (k > 0) pushIf(g - SXY); if (k < NZ - 1) pushIf(g + SXY);
  }
  // champ signé : voxels non atteints = intérieur
  let inside = 0;
  const sdf = dist; // réutilise le buffer
  for (let g = 0; g < N; g++) { if (!outside[g]) { sdf[g] = -dist[g]; inside++; } }
  let shell = false;
  if (inside === 0) { shell = true; for (let g = 0; g < N; g++) sdf[g] = dist[g] - 0.75 * h; }
  const net = surfaceNets(sdf, NX, NY, NZ, ox, oy, oz, h);
  const npos = net.pos, nidx = net.idx, nOut = net.nv;
  const out = makeLevel(npos, nidx, nOut);
  // projection sur la surface d'origine + transfert couleurs / groupes
  const bvh = new BVH(pos, idx);
  const cp = { tri: -1 };
  const triG = new Uint32Array(nOut);
  const maxProj = 1.5 * h;
  for (let v = 0; v < nOut; v++) {
    const o = 3 * v;
    bvh.closest(npos[o], npos[o + 1], npos[o + 2], cp);
    if (cp.tri < 0) continue;
    triG[v] = L.groups[cp.tri];
    const a = idx[3 * cp.tri], b = idx[3 * cp.tri + 1], c = idx[3 * cp.tri + 2];
    for (let q = 0; q < 4; q++) out.col[4 * v + q] = Math.round(L.col[4 * a + q] * cp.u + L.col[4 * b + q] * cp.v + L.col[4 * c + q] * cp.w);
    if (project && !shell && cp.d2 < maxProj * maxProj) { npos[o] = cp.x; npos[o + 1] = cp.y; npos[o + 2] = cp.z; }
  }
  for (let t = 0; t < out.nt; t++) {
    const a = triG[nidx[3 * t]], b = triG[nidx[3 * t + 1]], c = triG[nidx[3 * t + 2]];
    out.groups[t] = (b === c) ? b : a;
  }
  out.info = { voxels: N, shell };
  return out;
}
// Surface nets : extrait l'isosurface 0 d'une grille signée (négatif = intérieur), normales vers l'extérieur
function surfaceNets(sdf, NX, NY, NZ, ox, oy, oz, h) {
  const N = NX * NY * NZ, SXY = NX * NY;
  const cellV = new Int32Array(N).fill(-1);
  const P = new GrowF32(1 << 16);
  const corner = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const cv = new Float32Array(8);
  let nOut = 0;
  for (let k = 0; k < NZ - 1; k++) for (let j = 0; j < NY - 1; j++) for (let i = 0; i < NX - 1; i++) {
    const g = i + j * NX + k * SXY;
    let mask = 0;
    for (let c = 0; c < 8; c++) { const cc = corner[c]; cv[c] = sdf[g + cc[0] + cc[1] * NX + cc[2] * SXY]; if (cv[c] < 0) mask |= 1 << c; }
    if (mask === 0 || mask === 255) continue;
    let sx = 0, sy = 0, sz = 0, cnt = 0;
    for (const [a, b] of edges) {
      const va = cv[a], vb = cv[b];
      if ((va < 0) === (vb < 0)) continue;
      const tt = va / (va - vb); const ca = corner[a], cb = corner[b];
      sx += ca[0] + (cb[0] - ca[0]) * tt; sy += ca[1] + (cb[1] - ca[1]) * tt; sz += ca[2] + (cb[2] - ca[2]) * tt; cnt++;
    }
    P.push3(ox + (i + sx / cnt) * h, oy + (j + sy / cnt) * h, oz + (k + sz / cnt) * h);
    cellV[g] = nOut++;
  }
  const I = new GrowU32(nOut * 6 + 16);
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) { const t = b; b = d; d = t; }
    // diagonale la plus courte
    const p = P.a; const d1 = dist2(p, a, c), d2 = dist2(p, b, d);
    if (d1 <= d2) { I.push(a); I.push(b); I.push(c); I.push(a); I.push(c); I.push(d); }
    else { I.push(a); I.push(b); I.push(d); I.push(b); I.push(c); I.push(d); }
  };
  for (let k = 1; k < NZ - 1; k++) for (let j = 1; j < NY - 1; j++) for (let i = 1; i < NX - 1; i++) {
    const g = i + j * NX + k * SXY; const s0 = sdf[g] < 0;
    // arête x : (i,j,k)-(i+1,j,k) ; cellules (i, j-1..j, k-1..k)
    if (i < NX - 1 && (sdf[g + 1] < 0) !== s0) {
      const c00 = cellV[g - NX - SXY], c10 = cellV[g - SXY], c11 = cellV[g], c01 = cellV[g - NX];
      quad(c00, c10, c11, c01, !s0);
    }
    if (j < NY - 1 && (sdf[g + NX] < 0) !== s0) {
      const c00 = cellV[g - SXY - 1], c10 = cellV[g - 1], c11 = cellV[g], c01 = cellV[g - SXY];
      quad(c00, c10, c11, c01, !s0);
    }
    if (k < NZ - 1 && (sdf[g + SXY] < 0) !== s0) {
      const c00 = cellV[g - 1 - NX], c10 = cellV[g - NX], c11 = cellV[g], c01 = cellV[g - 1];
      quad(c00, c10, c11, c01, !s0);
    }
  }
  return { pos: P.copy(), idx: I.copy(), nv: nOut };
}
function dist2(p, a, b) { const x = p[3 * a] - p[3 * b], y = p[3 * a + 1] - p[3 * b + 1], z = p[3 * a + 2] - p[3 * b + 2]; return x * x + y * y + z * z; }

// ---------------------------------------------------------------- OBJ
function parseOBJ(text) {
  const P = new GrowF32(1 << 16), C = new GrowF32(1 << 10), I = new GrowU32(1 << 16), G = new GrowU32(1 << 14);
  let hasCol = false, group = 0; const gnames = new Map();
  let s = 0; const n = text.length;
  while (s < n) {
    let e = text.indexOf('\n', s); if (e < 0) e = n;
    const line = text.slice(s, e).trim(); s = e + 1;
    if (!line) continue;
    const c0 = line.charCodeAt(0), c1 = line.charCodeAt(1);
    if (c0 === 118 && c1 === 32) { // "v "
      const p = line.split(/\s+/);
      P.push3(+p[1], +p[2], +p[3]);
      if (p.length >= 7) { hasCol = true; C.push3(+p[4], +p[5], +p[6]); } else C.push3(-1, -1, -1);
    } else if (c0 === 102 && c1 === 32) { // "f "
      const p = line.split(/\s+/); const vs = [];
      const nvNow = P.n / 3;
      for (let i = 1; i < p.length; i++) { if (!p[i]) continue; let v = parseInt(p[i], 10); if (v < 0) v = nvNow + v; else v -= 1; vs.push(v); }
      for (let i = 1; i + 1 < vs.length; i++) { I.push(vs[0]); I.push(vs[i]); I.push(vs[i + 1]); G.push(group); }
    } else if ((c0 === 103 || c0 === 111) && c1 === 32) { // g / o
      const name = line.slice(2).trim();
      if (!gnames.has(name)) gnames.set(name, gnames.size);
      group = gnames.get(name);
    }
  }
  let pos = P.copy(), idx = I.copy(), groups = G.copy();
  const nvAll = pos.length / 3;
  // validation et compactage
  const used = new Int32Array(nvAll).fill(-1); let nv = 0;
  const keep = [];
  for (let t = 0; t < idx.length / 3; t++) {
    const a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2];
    if (a >= nvAll || b >= nvAll || c >= nvAll || a === b || b === c || a === c) continue;
    keep.push(t);
  }
  const nidx = new Uint32Array(keep.length * 3), ng = new Uint32Array(keep.length);
  keep.forEach((t, q) => { for (let k = 0; k < 3; k++) { const v = idx[3 * t + k]; if (used[v] < 0) used[v] = nv++; nidx[3 * q + k] = used[v]; } ng[q] = groups[t]; });
  const npos = new Float32Array(nv * 3), col = new Uint8Array(nv * 4);
  const Ca = C.view();
  for (let v = 0; v < nvAll; v++) {
    const r = used[v]; if (r < 0) continue;
    npos[3 * r] = pos[3 * v]; npos[3 * r + 1] = pos[3 * v + 1]; npos[3 * r + 2] = pos[3 * v + 2];
    if (hasCol && Ca[3 * v] >= 0) { const sc = Ca[3 * v] > 1 || Ca[3 * v + 1] > 1 || Ca[3 * v + 2] > 1 ? 1 : 255; col[4 * r] = Ca[3 * v] * sc; col[4 * r + 1] = Ca[3 * v + 1] * sc; col[4 * r + 2] = Ca[3 * v + 2] * sc; col[4 * r + 3] = 255; }
  }
  return { pos: npos, idx: nidx, nv, groups: ng, col, hasCol };
}
function exportOBJ(levels, names, withColor) {
  const out = ['# Argile — export OBJ'];
  let base = 1;
  levels.forEach((L, li) => {
    out.push('o ' + (names[li] || 'SubTool' + li).replace(/\s+/g, '_'));
    const p = L.pos, c = L.col;
    for (let v = 0; v < L.nv; v++) {
      let s = 'v ' + fmt(p[3 * v]) + ' ' + fmt(p[3 * v + 1]) + ' ' + fmt(p[3 * v + 2]);
      if (withColor && c[4 * v + 3]) s += ' ' + (c[4 * v] / 255).toFixed(4) + ' ' + (c[4 * v + 1] / 255).toFixed(4) + ' ' + (c[4 * v + 2] / 255).toFixed(4);
      out.push(s);
    }
    let lastG = -1;
    for (let t = 0; t < L.nt; t++) {
      if (L.groups[t] !== lastG) { lastG = L.groups[t]; out.push('g ' + (names[li] || 'SubTool' + li).replace(/\s+/g, '_') + '_pg' + lastG); }
      out.push('f ' + (L.idx[3 * t] + base) + ' ' + (L.idx[3 * t + 1] + base) + ' ' + (L.idx[3 * t + 2] + base));
    }
    base += L.nv;
  });
  return out.join('\n') + '\n';
}
function fmt(x) { return (Math.round(x * 1e6) / 1e6).toString(); }

const Core = {
  GrowF32, GrowU32, buildEdges, computeNormals, BVH, Mesh, closestOnTri,
  makeLevel, makeSubtool, curLevel, getMesh, dropMesh, markDirty, markDirtyList, fullDirty, markAllDirty, DB,
  buildLoopOp, applyLoop, computeFirstNb, subtoolDivide, subtoolStepUp, subtoolStepDown, subtoolSetLevel, subtoolDelLower, subtoolDelHigher, subtoolTransform,
  icosphere, box, torus, fixOrientation, connectedComponents, mergeLevels, compactLevel, remeshVoxel, surfaceNets, parseOBJ, exportOBJ,
};
root.Core = Core;
if (typeof module !== 'undefined' && module.exports) module.exports = Core;
})(typeof window !== 'undefined' ? window : globalThis);
