/* Argile — application : interface, entrées, actions, annulation. */
(function () {
'use strict';
const { Core, Sculpt, Render, IO, GP, Curves, Samples, Surface, SDF } = window;
const { V, Q, Camera, Renderer } = Render;
const $ = (id) => document.getElementById(id);
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const isAndroid = /Android/i.test(navigator.userAgent);
const MAX_FACES = isAndroid ? 5e6 : 12e6;

// ------------------------------------------------------------ état
const S = {
  subtools: [], active: 0,
  brush: { type: 'standard', size: 70, intensity: 25, focal: 0, zadd: true, lazy: false, penSize: false, alpha: 'none', color: [214, 74, 52] },
  sym: [true, false, false],
  display: { wire: false, groups: false, paint: true, material: 0 },
  dyna: { res: 128, project: true },
  mode: 'draw',
  space: 'sculpt',
  gp: Object.assign(GP.makeState(), { cursor: [0, 0, 0] }),
  gpTool: 'draw',
  gpOpt: { thickness: 6, color: [29, 29, 31], place: 'surface', smooth: 2, stab: 0.35, eraser: 24, eraseWhole: false, front: false, pressure: true },
  tab: { fingerNav: true, curve: 1, minP: 0.05, eraserEnd: 'smooth', barrel: 'orbit', quick: false },
  hold: { smooth: false, zsub: false, mask: false, erase: false },
  latch: { smooth: false, zsub: false, mask: false, erase: false },
  curves: [], cvSel: { id: null, a: -1 }, cvTool: 'shape', cvOpt: { ghost: true, keep: false }, cvDef: null, cvPen: null,
};
const holdUsed = {};
const undoStack = [], redoStack = [];
const cam = new Camera();
const alphas = Sculpt.makeAlphas(128);
let renderer = null;
let needsRender = true;
let sceneRadius = 1;
const req = () => { needsRender = true; };

const view = $('view'), canvas = $('gpu'), overlay = $('overlay'), octx = overlay.getContext('2d');
const active = () => S.subtools[S.active];
const aLevel = () => Core.curLevel(active());
function aMesh() { const L = aLevel(); const fresh = !L.mesh; const m = Core.getMesh(L); if (!fresh && L.nrmDirty) m.refreshAll(); L.nrmDirty = false; return m; }

// ------------------------------------------------------------ messages
let toastTimer = 0;
function toast(msg, err) {
  let t = view.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); view.appendChild(t); }
  t.textContent = msg; t.classList.toggle('err', !!err);
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), err ? 7000 : 3200);
}
let busyCount = 0;
function run(label, fn) {
  // laisse le navigateur peindre l'indicateur avant un calcul long
  return new Promise((resolve) => {
    let b = view.querySelector('.busy');
    if (!b) { b = document.createElement('div'); b.className = 'busy'; b.innerHTML = '<span></span>'; view.appendChild(b); }
    b.firstChild.textContent = label; busyCount++;
    setTimeout(async () => {
      try { await fn(); } catch (e) { console.error(e); toast(e.message || String(e), true); }
      if (--busyCount === 0) b.remove();
      req(); refreshUI(); resolve();
    }, 30);
  });
}

// ------------------------------------------------------------ annulation
function pushUndo(e) { undoStack.push(e); if (undoStack.length > 80) undoStack.shift(); redoStack.length = 0; scheduleAutosave(); refreshUndoUI(); }
function snapState(st) { return { levels: st.levels.slice(), cur: st.cur }; }
function snapScene() { return { subtools: S.subtools.slice(), active: S.active }; }
function restoreState(st, s) {
  for (const L of st.levels) if (!s.levels.includes(L)) releaseLevel(L);
  st.levels = s.levels.slice(); st.cur = s.cur;
  for (const L of st.levels) { if (L !== Core.curLevel(st)) Core.dropMesh(L); }
  Core.markAllDirty(Core.curLevel(st));
}
function snapArr(L, key) { const a = L[key]; return a ? a.slice() : null; }
function restoreArr(L, key, a) {
  if (key === 'hidden') Sculpt.setHidden(L, a ? a.slice() : null);
  else { L[key].set(a); if (key === 'groups') { L.dirty = L.dirty || {}; L.dirty.groups = true; } else Core.markDirty(L, key === 'mask' ? 'mask' : 'col', 0, L.nv - 1); }
}
function withArr(label, key, fn) {
  const L = aLevel(); const before = snapArr(L, key);
  const r = fn(L);
  pushUndo({ type: 'arr', label, level: L, key, before, after: snapArr(L, key) });
  req(); return r;
}
function ownerOf(L) { for (const st of S.subtools) if (st.levels.includes(L)) return st; return null; }
function applyEntry(e, fwd) {
  switch (e.type) {
    case 'verts': {
      const st = ownerOf(e.level); if (!st) return;
      const k = st.levels.indexOf(e.level);
      if (st.cur !== k) { Core.subtoolSetLevel(st, k); releaseUnused(); }
      Sculpt.applyVerts(e, fwd, (L) => (L === Core.curLevel(st) && st === active() ? aMesh() : null));
      if (st !== active()) e.level.nrmDirty = true;
      break;
    }
    case 'arr': {
      const st = ownerOf(e.level); if (!st) return;
      const k = st.levels.indexOf(e.level);
      if (st.cur !== k) { Core.subtoolSetLevel(st, k); releaseUnused(); }
      restoreArr(e.level, e.key, fwd ? e.after : e.before);
      break;
    }
    case 'state': restoreState(e.st, fwd ? e.after : e.before); if (S.subtools.indexOf(e.st) >= 0) S.active = S.subtools.indexOf(e.st); break;
    case 'scene': {
      const s = fwd ? e.after : e.before;
      for (const st of S.subtools) if (!s.subtools.includes(st)) for (const L of st.levels) releaseLevel(L);
      S.subtools = s.subtools.slice(); S.active = Math.min(s.active, S.subtools.length - 1);
      for (const st of S.subtools) Core.markAllDirty(Core.curLevel(st));
      break;
    }
    case 'gp': GP.restore(S.gp, fwd ? e.after : e.before); refreshGPLayers(); break;
    case 'zs': zsRestore(fwd ? e.after : e.before); break;
    case 'curves': { const sn = fwd ? e.after : e.before; S.cvPen = null; S.curves = Curves.clone(sn.curves); S.cvSel = { ...sn.sel }; Curves.syncIds(S.curves); dropGhost(); cvChanged(); break; }
    case 'multi': (fwd ? e.list : e.list.slice().reverse()).forEach((x) => applyEntry(x, fwd)); break;
    case 'xform': {
      const t = fwd ? e.fwd : e.inv;
      Core.subtoolTransform(e.st, t.m, t.t[0], t.t[1], t.t[2], t.s);
      break;
    }
  }
}
function undo() { const e = undoStack.pop(); if (!e) return; applyEntry(e, false); redoStack.push(e); after('Annulé : ' + (e.label || 'trait')); }
function redo() { const e = redoStack.pop(); if (!e) return; applyEntry(e, true); undoStack.push(e); after('Rétabli : ' + (e.label || 'trait')); }
function after(msg) { updateBounds(); req(); refreshUI(); scheduleAutosave(); if (msg) hint(msg); }

// ------------------------------------------------------------ GPU
function releaseLevel(L) { if (renderer && L.gpu) renderer.releaseLevel(L); }
function releaseUnused() {
  for (const st of S.subtools) st.levels.forEach((L, k) => { if (k !== st.cur) { releaseLevel(L); Core.dropMesh(L); } });
}
function prepLevel(L, isActive) {
  if (isActive) { const fresh = !L.mesh; const m = Core.getMesh(L); if (!fresh && L.nrmDirty) m.refreshAll(); L.nrmDirty = false; return; }
  if (!L.nrm || L.nrm.length !== L.nv * 3 || L.nrmDirty) { L.nrm = Core.computeNormals(L.pos, L.idx, L.nv, L.nrm && L.nrm.length === L.nv * 3 ? L.nrm : null); L.nrmDirty = false; Core.markDirty(L, 'pos', 0, L.nv - 1); }
}
function updateBounds() {
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const st of S.subtools) {
    if (!st.visible) continue; const P = Core.curLevel(st).pos;
    for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { const v = P[i + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
  }
  if (mn[0] === Infinity) { mn = [-1, -1, -1]; mx = [1, 1, 1]; }
  S.bounds = [mn, mx];
  sceneRadius = Math.max(1e-3, V.len(V.sub(mx, mn)) / 2) + V.len(V.scale(V.add(mn, mx), 0.5));
}
function stBounds(st) {
  const P = Core.curLevel(st).pos; const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { const v = P[i + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
  return [mn, mx];
}
function frameAll() { updateBounds(); cam.frame(S.bounds[0], S.bounds[1]); req(); }

function resize() {
  const r = view.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  cam.w = r.width; cam.h = r.height;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; overlay.width = w; overlay.height = h; }
  if (renderer) renderer.resize(w, h);
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
let gpVersion = -1;
function frame() {
  requestAnimationFrame(frame);
  if (!needsRender || !renderer) return;
  needsRender = false;
  resize();
  const items = [];
  try {
    if (S.space === 'lib') for (const L of LIB.preview) { prepLevel(L, false); items.push({ level: L, active: true, groups: S.display.groups, wire: S.display.wire, paint: false }); }
    else if (S.space === 'zs') { const L = ZS.skin && ZS.skinLevel ? ZS.skinLevel : ZS.level; if (L) { prepLevel(L, false); items.push({ level: L, active: true, groups: L === ZS.skinLevel && S.display.groups, wire: S.display.wire, paint: L === ZS.level }); } }
    else S.subtools.forEach((st, i) => {
      if (!st.visible) return;
      const L = Core.curLevel(st); prepLevel(L, i === S.active);
      items.push({ level: L, active: i === S.active, groups: S.display.groups, wire: S.display.wire, paint: S.display.paint });
    });
    if (ghost && S.space === 'curves') { prepLevel(ghost.level, false); items.push({ level: ghost.level, active: false, groups: false, wire: S.display.wire, paint: false }); }
    if (S.gp.version !== gpVersion) { gpVersion = S.gp.version; renderer.syncGP('main', GP.buildBatch(GP.visibleStrokes(S.gp))); }
    if (gpLiveDirty) {
      gpLiveDirty = false;
      const d = drag && drag.kind === 'gpDraw' && drag.raw.length >= 4 ? drag : null;
      renderer.syncGP('live', GP.buildBatch(d ? [{ color: d.color, pts: new Float32Array(d.raw) }] : []));
    }
    renderer.draw(cam, items, S.display.material, sceneRadius, { slots: ['main', 'live'], front: S.gpOpt.front });
  } catch (e) { console.error(e); toast(e.message, true); }
  drawOverlay();
}

// ------------------------------------------------------------ overlay (curseur, axes)
const pointer = { x: -1, y: -1, inside: false, hit: null, shift: false, ctrl: false, alt: false };
function brushTypeNow() { return pointer.shift ? 'smooth' : pointer.ctrl ? 'mask' : S.brush.type; }
function drawOverlay() {
  const w = cam.w, h = cam.h; octx.clearRect(0, 0, w, h);
  // axes
  const { r, u } = cam.basis(); const ox = 42, oy = h - 46, len = 24;
  const axes = [[[1, 0, 0], '#e06a5a', 'X'], [[0, 1, 0], '#8fc46a', 'Y'], [[0, 0, 1], '#6a9be0', 'Z']];
  axes.sort((a, b) => V.dot(a[0], cam.basis().b) - V.dot(b[0], cam.basis().b));
  octx.lineWidth = 2; octx.font = '600 10px "IBM Plex Mono", monospace'; octx.textAlign = 'center'; octx.textBaseline = 'middle';
  for (const [a, c, l] of axes) {
    const x = ox + V.dot(a, r) * len, y = oy - V.dot(a, u) * len;
    octx.strokeStyle = c; octx.beginPath(); octx.moveTo(ox, oy); octx.lineTo(x, y); octx.stroke();
    octx.fillStyle = c; octx.fillText(l, ox + V.dot(a, r) * (len + 9), oy - V.dot(a, u) * (len + 9));
  }
  if (S.space === 'gp') { drawGPOverlay(); return; }
  if (S.space === 'curves') { drawCurvesOverlay(); return; }
  if (S.space === 'lib' || S.space === 'zs') return;
  if (!pointer.inside || S.mode !== 'draw') return;
  const type = brushTypeNow();
  const sub = (S.brush.zadd ? 1 : -1) * (pointer.alt ? -1 : 1) < 0;
  const col = type === 'smooth' ? 'rgba(150,200,255,.9)' : type === 'mask' ? 'rgba(160,190,225,.95)' : sub ? 'rgba(235,130,115,.95)' : 'rgba(240,180,95,.95)';
  octx.strokeStyle = col; octx.lineWidth = 1.5;
  octx.beginPath(); octx.arc(pointer.x, pointer.y, S.brush.size, 0, Math.PI * 2); octx.stroke();
  octx.globalAlpha = 0.6; octx.beginPath(); octx.arc(pointer.x, pointer.y, Math.max(2, S.brush.size * (0.5 - S.brush.focal * 0.3)), 0, Math.PI * 2); octx.stroke(); octx.globalAlpha = 1;
  if (!pointer.hit) { octx.setLineDash([4, 4]); octx.beginPath(); octx.arc(pointer.x, pointer.y, 5, 0, Math.PI * 2); octx.stroke(); octx.setLineDash([]); }
  if (drag && drag.kind === 'stroke' && S.brush.lazy && drag.lazy) {
    octx.strokeStyle = 'rgba(255,255,255,.4)'; octx.beginPath(); octx.moveTo(pointer.x, pointer.y); octx.lineTo(drag.lazy[0], drag.lazy[1]); octx.stroke();
  }
}

function drawGPOverlay() {
  drawPlaneGuides();
  gpCursorOverlay();
}
function drawPlaneGuides() {
  const C = S.gp.cursor, c = cam.project(C);
  // grille du plan de dessin
  const pl = S.gpOpt.place;
  if (pl === 'xy' || pl === 'xz' || pl === 'yz') {
    const ax = pl === 'xy' ? [[1, 0, 0], [0, 1, 0]] : pl === 'xz' ? [[1, 0, 0], [0, 0, 1]] : [[0, 1, 0], [0, 0, 1]];
    const R = sceneRadius * 1.2, N = 12;
    octx.strokeStyle = 'rgba(235,229,220,.16)'; octx.lineWidth = 1; octx.beginPath();
    for (let i = -N; i <= N; i++) for (let k = 0; k < 2; k++) {
      const u = ax[k], v = ax[1 - k], off = i / N * R;
      const a = cam.project(V.add(C, V.add(V.scale(u, off), V.scale(v, -R)))), b = cam.project(V.add(C, V.add(V.scale(u, off), V.scale(v, R))));
      if (a && b) { octx.moveTo(a[0], a[1]); octx.lineTo(b[0], b[1]); }
    }
    octx.stroke();
  }
  if (c) { // curseur 3D
    octx.lineWidth = 2; octx.strokeStyle = '#e06a5a'; octx.setLineDash([4, 3]); octx.beginPath(); octx.arc(c[0], c[1], 9, 0, Math.PI * 2); octx.stroke(); octx.setLineDash([]);
    octx.strokeStyle = 'rgba(255,255,255,.85)'; octx.lineWidth = 1; octx.beginPath();
    octx.moveTo(c[0] - 15, c[1]); octx.lineTo(c[0] - 5, c[1]); octx.moveTo(c[0] + 5, c[1]); octx.lineTo(c[0] + 15, c[1]);
    octx.moveTo(c[0], c[1] - 15); octx.lineTo(c[0], c[1] - 5); octx.moveTo(c[0], c[1] + 5); octx.lineTo(c[0], c[1] + 15); octx.stroke();
  }
}
function gpCursorOverlay() {
  if (!pointer.inside) return;
  const tool = S.hold.erase || (pointer.eraser) ? 'erase' : S.gpTool;
  octx.lineWidth = 1.5;
  if (tool === 'erase') { octx.strokeStyle = 'rgba(235,130,115,.95)'; octx.beginPath(); octx.arc(pointer.x, pointer.y, S.gpOpt.eraser, 0, Math.PI * 2); octx.stroke(); }
  else if (tool === 'cursor') { octx.strokeStyle = 'rgba(255,255,255,.8)'; octx.beginPath(); octx.moveTo(pointer.x - 10, pointer.y); octx.lineTo(pointer.x + 10, pointer.y); octx.moveTo(pointer.x, pointer.y - 10); octx.lineTo(pointer.x, pointer.y + 10); octx.stroke(); }
  else {
    const c2 = S.gpOpt.color; octx.strokeStyle = 'rgba(240,180,95,.95)';
    octx.beginPath(); octx.arc(pointer.x, pointer.y, Math.max(3, S.gpOpt.thickness / 2), 0, Math.PI * 2); octx.stroke();
    octx.fillStyle = 'rgb(' + c2.join(',') + ')'; octx.beginPath(); octx.arc(pointer.x, pointer.y, 2, 0, Math.PI * 2); octx.fill();
  }
}

// ------------------------------------------------------------ picking
function localXY(e) { const r = view.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
function pickSubtool(st, x, y) {
  const L = Core.curLevel(st);
  const m = st === active() ? aMesh() : Core.getMesh(L);
  const ray = cam.ray(x, y);
  const h = m.bvh.raycast(ray.o[0], ray.o[1], ray.o[2], ray.d[0], ray.d[1], ray.d[2], L.hidden);
  if (!h) return null;
  return { t: h.t, tri: h.tri, p: V.add(ray.o, V.scale(ray.d, h.t)), ray };
}
function pickActive(x, y) { const st = active(); if (!st || !st.visible) return null; return pickSubtool(st, x, y); }
function pickAny(x, y) {
  let best = null;
  S.subtools.forEach((st, i) => {
    if (!st.visible) return;
    const L = Core.curLevel(st);
    if (i !== S.active && !L.mesh && L.nt > 3e6) return; // évite de construire un BVH énorme pour un simple clic
    const h = pickSubtool(st, x, y); if (h && (!best || h.t < best.t)) best = { ...h, index: i };
  });
  return best;
}
function mirrors() {
  const out = [[1, 1, 1]];
  for (let a = 0; a < 3; a++) if (S.sym[a]) { const n = out.length; for (let i = 0; i < n; i++) { const m = out[i].slice(); m[a] = -1; out.push(m); } }
  return out;
}

// ------------------------------------------------------------ traits
let drag = null;
function pressureOf(e) {
  if (e.pointerType !== 'pen') return 1;
  const raw = Math.min(1, Math.max(0, e.pressure || 0));
  return Math.max(0.02, S.tab.minP + (1 - S.tab.minP) * Math.pow(raw, S.tab.curve));
}
let lastRaw = 0, meterT = 0;
function showPressure(e) {
  lastRaw = e.buttons ? (e.pressure || 0) : 0;
  const t = now(); if (t - meterT < 40) return; meterT = t;
  const pal = $('tabPal'); if (!pal || !pal.open) return;
  const p = e.buttons ? pressureOf(e) : 0;
  $('pressBar').style.width = (p * 100).toFixed(0) + '%';
  $('pressNum').textContent = e.buttons ? lastRaw.toFixed(3) + ' → ' + p.toFixed(2) + ((e.buttons & 32) ? ' · gomme' : (e.buttons & 2) ? ' · bouton' : '') : 'survol';
  drawCurve(lastRaw);
}
function brushParams(type, sign, P, pressure) {
  const { r, u, b } = cam.basis();
  const px = cam.pixelSize(P);
  const sizeK = S.brush.penSize ? pressure : 1;
  return {
    type, sign, strength: (S.brush.intensity / 100) * (S.brush.penSize ? 1 : pressure), radius: S.brush.size * px * sizeK, focal: S.brush.focal,
    alpha: type === 'mask' || type === 'smooth' ? null : alphas[S.brush.alpha], right: r, up: u, viewDir: V.scale(b, -1), color: S.brush.color,
  };
}
function dabAt(P, pressure) {
  const d = drag; const base = brushParams(d.type, d.sign, P, pressure);
  mirrors().forEach((m, mi) => {
    const Pm = [P[0] * m[0], P[1] * m[1], P[2] * m[2]];
    if (mi > 0 && V.len(V.sub(Pm, P)) < base.radius * 0.2) return;
    const p = { ...base, right: [base.right[0] * m[0], base.right[1] * m[1], base.right[2] * m[2]], up: [base.up[0] * m[0], base.up[1] * m[1], base.up[2] * m[2]] };
    Sculpt.dab(d.S, Pm[0], Pm[1], Pm[2], p);
  });
}
function startStroke(hit, x, y, e, forced) {
  const ctrl = e.ctrlKey || e.metaKey, H = S.hold;
  let type = (e.shiftKey || H.smooth) ? 'smooth' : (ctrl || H.mask) ? 'mask' : S.brush.type;
  let flip = e.altKey || H.zsub;
  for (const k of ['smooth', 'zsub', 'mask']) if (H[k]) holdUsed[k] = true;
  if (forced === 'eraser') { const m = S.tab.eraserEnd; if (m === 'smooth') type = 'smooth'; else if (m === 'mask') type = 'mask'; else flip = !flip; }
  else if (forced === 'smooth') type = 'smooth';
  let sign = (S.brush.zadd ? 1 : -1) * (flip ? -1 : 1);
  if (type === 'mask') sign = flip ? -1 : 1;
  const L = aLevel(), mesh = aMesh();
  drag = { kind: 'stroke', type, sign, S: new Sculpt.Stroke(L, mesh), last: [x, y], lazy: [x, y], acc: 0, start: [x, y], P0: hit.p };
  const pr = pressureOf(e);
  if (type === 'move') {
    const base = brushParams('move', 1, hit.p, pr);
    mirrors().forEach((m, mi) => {
      const Pm = [hit.p[0] * m[0], hit.p[1] * m[1], hit.p[2] * m[2]];
      if (mi > 0 && V.len(V.sub(Pm, hit.p)) < base.radius * 0.2) return;
      Sculpt.grabStart(drag.S, Pm[0], Pm[1], Pm[2], base, m);
    });
    drag.px = cam.pixelSize(hit.p);
  } else dabAt(hit.p, pr);
  req();
}
function strokeMove(x, y, e) {
  const d = drag; const pr = pressureOf(e);
  if (d.type === 'move') {
    const { r, u } = cam.basis(); const dx = (x - d.start[0]) * d.px, dy = (y - d.start[1]) * d.px;
    const w = V.add(V.scale(r, dx), V.scale(u, -dy));
    Sculpt.grabMove(d.S, w[0], w[1], w[2]); req(); return;
  }
  let tx = x, ty = y;
  if (S.brush.lazy) {
    const lr = Math.max(12, S.brush.size * 0.6); const dx = x - d.lazy[0], dy = y - d.lazy[1], dl = Math.hypot(dx, dy);
    if (dl <= lr) return;
    d.lazy = [d.lazy[0] + dx * (dl - lr) / dl, d.lazy[1] + dy * (dl - lr) / dl]; tx = d.lazy[0]; ty = d.lazy[1];
  }
  const spacing = Math.max(1.5, S.brush.size * 0.14);
  let fx = d.last[0], fy = d.last[1];
  let dx = tx - fx, dy = ty - fy, dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return;
  dx /= dist; dy /= dist;
  // d.acc = distance parcourue depuis le dernier dab
  let s = spacing - d.acc;
  while (s <= dist) {
    const h = pickActive(fx + dx * s, fy + dy * s); if (h) dabAt(h.p, pr);
    s += spacing;
  }
  d.acc = dist - (s - spacing);
  d.last = [tx, ty];
  req();
}
function endStroke() {
  const e = drag.S.finish();
  if (e) { e.label = { mask: 'masque', paint: 'polypaint' }[drag.type] || drag.type; pushUndo(e); }
  drag = null; updateBoundsLazy(); req();
}
let boundsTimer = 0;
function updateBoundsLazy() { clearTimeout(boundsTimer); boundsTimer = setTimeout(updateBounds, 400); }

// ------------------------------------------------------------ transformation de SubTool (W/E/R)
function mat3Mul(a, b) { const o = new Array(9); for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) o[c * 3 + r] = a[r] * b[c * 3] + a[3 + r] * b[c * 3 + 1] + a[6 + r] * b[c * 3 + 2]; return o; }
function mat3Vec(m, v) { return [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]]; }
function applyXform(st, m, t, s) {
  Core.subtoolTransform(st, m, t[0], t[1], t[2], s);
  const X = drag.x; X.m = mat3Mul(m, X.m); X.t = V.add(mat3Vec(m, X.t), t); X.s *= s;
}
function xformMove(x, y) {
  const d = drag, st = active(), c = d.center;
  const dx = x - d.last[0], dy = y - d.last[1]; d.last = [x, y];
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  if (S.mode === 'move') {
    const { r, u } = cam.basis(); const px = cam.pixelSize(c);
    const t = V.add(V.scale(r, dx * px), V.scale(u, -dy * px));
    applyXform(st, I, t, 1); d.center = V.add(c, t);
  } else if (S.mode === 'scale') {
    const s = Math.exp(-dy * 0.006);
    const m = [s, 0, 0, 0, s, 0, 0, 0, s];
    applyXform(st, m, V.sub(c, V.scale(c, s)), s);
  } else if (S.mode === 'rotate') {
    const { r, u } = cam.basis();
    const q = Q.norm(Q.mul(Q.axis(u, dx * 0.01), Q.axis(r, dy * 0.01)));
    const m = Q.toMat3(q);
    applyXform(st, m, V.sub(c, mat3Vec(m, c)), 1);
  }
  req();
}
function endXform() {
  const X = drag.x, st = active();
  const s = X.s, mt = [X.m[0], X.m[3], X.m[6], X.m[1], X.m[4], X.m[7], X.m[2], X.m[5], X.m[8]].map((v) => v / (s * s));
  const ti = V.scale(mat3Vec(mt, X.t), -1);
  pushUndo({ type: 'xform', label: 'transformation', st, fwd: { m: X.m, t: X.t, s }, inv: { m: mt, t: ti, s: 1 / s } });
  drag = null; updateBounds(); req();
}

// ------------------------------------------------------------ souris / stylet / tactile
const touches = new Map(); let gesture = null; let lastPen = 0; let penContact = false; let penHover = false;
const now = () => performance.now();
// le stylet est « proche » s'il touche, s'il survole l'écran (EMR) ou s'il vient d'être utilisé
const penNear = () => penContact || (penHover && now() - lastPen < 1000) || now() - lastPen < 400;
const isEraser = (e) => e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32) !== 0);

view.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  if (!renderer || busyCount) return;
  if (e.pointerType === 'pen') { lastPen = now(); penContact = true; if (gesture) cancelGesture(); }
  if (e.pointerType === 'touch') {
    if (penNear()) return; // paume posée pendant que le stylet est proche
    if (S.tab.fingerNav || touches.size) { touchDown(e); return; }
  }
  canvas.setPointerCapture(e.pointerId);
  const [x, y] = localXY(e);
  pointer.x = x; pointer.y = y; pointer.inside = true;
  if (e.pointerType === 'pen' && e.button === 2) { // bouton latéral
    const a = S.tab.barrel;
    if (a === 'pan') { drag = { kind: 'pan', last: [x, y] }; return; }
    if (a === 'orbit') { drag = { kind: 'orbit', last: [x, y] }; return; }
    downPrimary(e, x, y, 'smooth'); return;
  }
  if (e.button === 1 || (e.button === 2 && e.shiftKey)) { drag = { kind: 'pan', last: [x, y] }; return; }
  if (e.button === 2) { drag = { kind: 'orbit', last: [x, y], moved: false }; return; }
  if (e.button !== 0 && !isEraser(e)) return;
  downPrimary(e, x, y, isEraser(e) ? 'eraser' : null);
});
function downPrimary(e, x, y, forced) {
  if (S.space === 'gp') { gpDown(e, x, y, forced); return; }
  if (S.space === 'curves') { cvDown(e, x, y); return; }
  if (S.space === 'lib') { drag = { kind: 'bg', start: [x, y], last: [x, y], moved: false }; return; }
  if (S.space === 'zs') { zsDown(e, x, y); return; }
  const ctrl = e.ctrlKey || e.metaKey;
  if (S.mode !== 'draw' && active()) {
    const [mn, mx] = stBounds(active());
    drag = { kind: 'xform', last: [x, y], center: V.scale(V.add(mn, mx), 0.5), x: { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0], s: 1 } };
    return;
  }
  if (e.altKey && !ctrl) {
    const any = pickAny(x, y);
    if (any && any.index !== S.active) { selectSubtool(any.index); drag = { kind: 'none' }; return; }
  }
  const hit = pickActive(x, y);
  if (!hit) { drag = { kind: 'bg', start: [x, y], last: [x, y], moved: false, ctrl, shift: e.shiftKey, alt: e.altKey }; return; }
  if (ctrl && e.shiftKey) { drag = { kind: 'groupClick', hit, alt: e.altKey }; return; }
  startStroke(hit, x, y, e, forced);
}
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'pen') { lastPen = now(); penHover = true; showPressure(e); }
  if (e.pointerType === 'touch' && touches.has(e.pointerId)) { touchMove(e); return; }
  const [x, y] = localXY(e);
  pointer.eraser = isEraser(e) || (e.pointerType === 'pen' && (e.buttons & 32) !== 0);
  pointer.x = x; pointer.y = y; pointer.inside = true; pointer.shift = e.shiftKey; pointer.ctrl = e.ctrlKey || e.metaKey; pointer.alt = e.altKey;
  if (!drag) { if (renderer && S.space === 'sculpt' && S.mode === 'draw') pointer.hit = pickActive(x, y); req(); return; }
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  const list = evs.length ? evs : [e];
  switch (drag.kind) {
    case 'stroke': for (const ce of list) { const [cx, cy] = localXY(ce); strokeMove(cx, cy, ce); } pointer.hit = true; break;
    case 'gpDraw': for (const ce of list) { const [cx, cy] = localXY(ce); gpMove(cx, cy, ce); } break;
    case 'gpErase': gpEraseMove(x, y); break;
    case 'gpCursor': gpSetCursor(x, y); break;
    case 'cvDraw': for (const ce of list) { const [cx, cy] = localXY(ce); cvDrawMove(cx, cy); } break;
    case 'cvPenDrag': cvPenDrag(x, y); break;
    case 'cvMove': cvMove(x, y); break;
    case 'zsMove': case 'zsScale': zsDrag(x, y); break;
    case 'xform': xformMove(x, y); break;
    case 'pan': cam.pan(x - drag.last[0], y - drag.last[1]); drag.last = [x, y]; req(); break;
    case 'orbit': case 'bg': {
      if (drag.kind === 'bg' && !drag.moved && Math.hypot(x - drag.start[0], y - drag.start[1]) < 4) break;
      drag.moved = true;
      if (drag.kind === 'bg' && drag.alt && !drag.ctrl) cam.pan(x - drag.last[0], y - drag.last[1]);
      else { cam.orbit(x - drag.last[0], y - drag.last[1]); if (e.shiftKey) cam.snap(); }
      drag.last = [x, y]; req(); break;
    }
  }
});
function endDrag(e) {
  if (e.pointerType === 'pen') penContact = false;
  if (e.pointerType === 'touch' && touches.has(e.pointerId)) { touchUp(e); return; }
  if (!drag) return;
  const d = drag;
  if (d.kind === 'stroke') endStroke();
  else if (d.kind === 'xform') endXform();
  else if (d.kind === 'gpDraw') gpEnd();
  else if (d.kind === 'gpErase') gpEraseEnd();
  else if (d.kind === 'cvDraw') cvDrawEnd();
  else if (d.kind === 'cvPenDrag') { drag = null; cvTouch(); }
  else if (d.kind === 'cvMove') cvMoveEnd();
  else if (d.kind === 'zsMove' || d.kind === 'zsScale') zsEnd();
  else {
    drag = null;
    if (d.kind === 'bg' && !d.moved) {
      if (d.ctrl && d.shift) { if (aLevel().hidden) withArr('tout afficher', 'hidden', (L) => Sculpt.showAll(L)); }
      else if (d.ctrl && d.alt) withArr('effacer le masque', 'mask', (L) => Sculpt.maskClear(L));
      else if (d.ctrl) withArr('inverser le masque', 'mask', (L) => Sculpt.maskInvert(L));
    }
    if (d.kind === 'groupClick') {
      const L = aLevel(), g = L.groups[d.hit.tri];
      if (d.alt) withArr('cacher le groupe', 'hidden', (L) => Sculpt.hideGroup(L, g));
      else withArr('isoler le groupe', 'hidden', (L) => Sculpt.isolateGroup(L, g));
    }
  }
  try { canvas.releasePointerCapture(e.pointerId); } catch (_) { /* déjà relâché */ }
  refreshStats(); req();
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('pointerleave', (e) => { if (e.pointerType === 'pen') { penContact = false; penHover = false; } if (!drag) { pointer.inside = false; req(); } });
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.shiftKey && !e.ctrlKey) {
    const f = Math.exp(-(e.deltaY || e.deltaX) * 0.002);
    if (S.space === 'gp') setGPThick(S.gpOpt.thickness * f); else setSize(S.brush.size * f);
    return;
  }
  const k = e.ctrlKey ? 0.01 : 0.0015;
  cam.zoom(Math.exp(e.deltaY * k)); req();
}, { passive: false });

// gestes tactiles : 1 doigt tourne, 2 doigts zooment et déplacent, taps 2/3 doigts = annuler/rétablir
function touchStats() {
  const a = [...touches.values()];
  if (a.length < 2) return { n: a.length, c: a[0] ? [a[0].x, a[0].y] : [0, 0], d: 0 };
  return { n: a.length, c: [(a[0].x + a[1].x) / 2, (a[0].y + a[1].y) / 2], d: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) };
}
function touchDown(e) {
  try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* rien */ }
  const [x, y] = localXY(e);
  touches.set(e.pointerId, { x, y });
  if (!gesture) gesture = { t0: now(), maxN: 0, moved: false, travel: 0 };
  gesture.maxN = Math.max(gesture.maxN, touches.size);
}
function touchMove(e) {
  const t = touches.get(e.pointerId); if (!t || !gesture) return;
  const [x, y] = localXY(e);
  const before = touchStats(); t.x = x; t.y = y; const after = touchStats();
  if (after.n !== before.n) return;
  const dx = after.c[0] - before.c[0], dy = after.c[1] - before.c[1];
  gesture.travel += Math.hypot(dx, dy) + Math.abs(after.d - before.d);
  if (gesture.travel < 8) return;
  gesture.moved = true;
  if (after.n === 1) cam.orbit(dx, dy);
  else { if (before.d > 0 && after.d > 0) cam.zoom(before.d / after.d); cam.pan(dx, dy); }
  req();
}
function touchUp(e) {
  touches.delete(e.pointerId);
  try { canvas.releasePointerCapture(e.pointerId); } catch (_) { /* rien */ }
  if (touches.size || !gesture) return;
  if (!gesture.moved && now() - gesture.t0 < 350) { if (gesture.maxN === 2) undo(); else if (gesture.maxN >= 3) redo(); }
  gesture = null;
}
function cancelGesture() { touches.clear(); gesture = null; }

// ------------------------------------------------------------ Dessin 3D (Grease Pencil)
const gpLayer = () => S.gp.layers[S.gp.active];
function triNormal(L, t) {
  const P = L.pos, a = L.idx[3 * t] * 3, b = L.idx[3 * t + 1] * 3, c = L.idx[3 * t + 2] * 3;
  return V.norm(V.cross([P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]]));
}
function gpPlaneNormal() { const p = S.gpOpt.place; return p === 'xy' ? [0, 0, 1] : p === 'xz' ? [0, 1, 0] : p === 'yz' ? [1, 0, 0] : cam.basis().b; }
function gpPlace(x, y) {
  const ray = cam.ray(x, y), C = S.gp.cursor;
  if (S.gpOpt.place === 'surface') {
    const h = pickAny(x, y);
    if (h) { let n = triNormal(Core.curLevel(S.subtools[h.index]), h.tri); if (V.dot(n, ray.d) > 0) n = V.scale(n, -1); return { p: h.p, n }; }
  }
  const n = S.gpOpt.place === 'surface' ? cam.basis().b : gpPlaneNormal();
  const dn = V.dot(ray.d, n); if (Math.abs(dn) < 1e-5) return null;
  const t = V.dot(V.sub(C, ray.o), n) / dn; if (t <= 0) return null;
  return { p: V.add(ray.o, V.scale(ray.d, t)), n: null };
}
function gpPoint(x, y, pressure) {
  const pl = gpPlace(x, y); if (!pl) return null;
  const r = Math.max(1e-6, S.gpOpt.thickness * 0.5 * cam.pixelSize(pl.p) * (S.gpOpt.pressure ? pressure : 1));
  const p = pl.n ? V.add(pl.p, V.scale(pl.n, r * 0.6)) : pl.p;
  return [p[0], p[1], p[2], r];
}
function gpSetCursor(x, y) {
  const h = pickAny(x, y);
  if (h) S.gp.cursor = h.p;
  else { const ray = cam.ray(x, y), n = cam.basis().b, dn = V.dot(ray.d, n); if (Math.abs(dn) > 1e-5) { const t = V.dot(V.sub(S.gp.cursor, ray.o), n) / dn; if (t > 0) S.gp.cursor = V.add(ray.o, V.scale(ray.d, t)); } }
  req();
}
let gpLiveDirty = false;
function gpDown(e, x, y, forced) {
  let tool = S.gpTool;
  if (forced === 'eraser' || S.hold.erase) tool = 'erase';
  if (S.hold.erase) holdUsed.erase = true;
  if (tool === 'cursor') { drag = { kind: 'gpCursor' }; gpSetCursor(x, y); return; }
  const L = gpLayer();
  if (!L.visible || L.locked) { toast('Le calque « ' + L.name + ' » est ' + (L.locked ? 'verrouillé' : 'masqué') + '.', true); drag = { kind: 'none' }; return; }
  if (tool === 'erase') { drag = { kind: 'gpErase', before: GP.snapshot(S.gp), changed: false, last: [x, y] }; gpEraseAt(x, y); return; }
  const pt = gpPoint(x, y, pressureOf(e));
  drag = { kind: 'gpDraw', tool, raw: [], smooth: [x, y], last: [x, y], start: pt, end: null, color: S.gpOpt.color.slice() };
  if (tool === 'line') { if (!pt) { drag = { kind: 'none' }; return; } drag.raw = pt.concat(pt); }
  else if (pt) drag.raw.push(...pt);
  gpLiveDirty = true; req();
}
function gpMove(x, y, e) {
  const d = drag;
  if (d.tool === 'line') { const pl = gpPoint(x, y, 1); if (!pl) return; pl[3] = d.start[3]; d.end = pl; d.raw = d.start.concat(pl); gpLiveDirty = true; req(); return; }
  const k = S.gpOpt.stab;
  d.smooth = [d.smooth[0] + (x - d.smooth[0]) * (1 - k), d.smooth[1] + (y - d.smooth[1]) * (1 - k)];
  const [sx, sy] = d.smooth;
  if (Math.hypot(sx - d.last[0], sy - d.last[1]) < 1.5) return;
  d.last = [sx, sy];
  const pt = gpPoint(sx, sy, pressureOf(e));
  if (pt) { d.raw.push(...pt); gpLiveDirty = true; req(); }
}
function gpEnd() {
  const d = drag; drag = null; gpLiveDirty = true;
  let s = null;
  if (d.tool === 'line') {
    if (d.end) { const a = d.start, b = d.end, r = a[3], len = V.len(V.sub(b, a)); s = GP.lineStroke(a, b, r, d.color, Math.min(400, Math.max(2, Math.ceil(len / (r * 0.75))))); }
  } else if (d.raw.length >= 4) {
    const raw = d.raw.length === 4 ? d.raw.concat(d.raw[0] + d.raw[3] * 0.01, d.raw[1], d.raw[2], d.raw[3]) : d.raw;
    s = GP.finalize(new Float32Array(raw), d.color, S.gpOpt.smooth, sceneRadius * 1e-6);
  }
  if (s) { const before = GP.snapshot(S.gp); gpLayer().strokes.push(s); S.gp.version++; pushUndo({ type: 'gp', label: 'trait', before, after: GP.snapshot(S.gp) }); refreshGPLayers(); }
  req();
}
function gpEraseAt(x, y) {
  const L = gpLayer(); const sub = { layers: [L], version: 0 };
  if (GP.erase(sub, (a, b, c) => cam.project([a, b, c]), x, y, S.gpOpt.eraser, S.gpOpt.eraseWhole)) { drag.changed = true; S.gp.version++; req(); }
}
function gpEraseMove(x, y) {
  const d = drag, step = Math.max(2, S.gpOpt.eraser / 3);
  const dx = x - d.last[0], dy = y - d.last[1], dist = Math.hypot(dx, dy);
  if (dist < step) return;
  for (let s = step; s <= dist; s += step) gpEraseAt(d.last[0] + dx * s / dist, d.last[1] + dy * s / dist);
  d.last = [x, y];
}
function gpEraseEnd() { const d = drag; drag = null; if (d.changed) { pushUndo({ type: 'gp', label: 'gomme', before: d.before, after: GP.snapshot(S.gp) }); refreshGPLayers(); } }
function gpEdit(label, fn) { const before = GP.snapshot(S.gp); fn(); S.gp.version++; pushUndo({ type: 'gp', label, before, after: GP.snapshot(S.gp) }); refreshGPLayers(); req(); }
function gpConvert() {
  const strokes = GP.visibleStrokes(S.gp);
  if (!strokes.length) { toast('Aucun trait visible à convertir.'); return; }
  run('Conversion des traits…', () => {
    const m = GP.strokesToMesh(strokes, { sides: 8 });
    const L = Core.makeLevel(m.pos, m.idx, m.nv, { groups: m.groups, col: m.col });
    appendSubtool(Core.makeSubtool('Dessin 3D', L), 'convertir les traits');
    toast(strokes.length + ' trait(s) convertis en SubTool. Lancez DynaMesh pour les souder en volume.');
  });
}

// ------------------------------------------------------------ clavier
window.addEventListener('keydown', (e) => {
  if (e.target.matches && e.target.matches('input[type=text], input:not([type]), textarea')) return;
  pointer.shift = e.shiftKey; pointer.ctrl = e.ctrlKey || e.metaKey; pointer.alt = e.altKey; req();
  const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
  const go = (fn) => { e.preventDefault(); fn(); };
  if (mod && k === 'z') return go(() => (e.shiftKey ? redo() : undo()));
  if (mod && k === 'enter' && S.space === 'curves') return go(() => cvBake(false));
  if (mod && k === 'y') return go(redo);
  if (mod && k === 's') return go(saveProject);
  if (mod && k === 'o') return go(() => $('fileInput').click());
  if (mod && k === 'd') return go(divide);
  if (mod && k === 'i') return go(() => withArr('inverser le masque', 'mask', (L) => Sculpt.maskInvert(L)));
  if (mod && e.shiftKey && k === 'a') return go(() => withArr('effacer le masque', 'mask', (L) => Sculpt.maskClear(L)));
  if (e.ctrlKey && !e.metaKey && k === 'w') return go(groupMaskOrVisible);
  if (e.ctrlKey && !e.metaKey && k === 'r') return go(dynamesh);
  if (mod || e.altKey) return;
  if (e.shiftKey && k === 'f') return go(() => toggleDisplay('wire'));
  if (e.shiftKey && k === 'g') return go(() => toggleDisplay('groups'));
  if (e.shiftKey && k === 'd') return go(() => stepLevel(-1));
  if (e.shiftKey) return;
  if (k === 'p') return go(() => setSpace(S.space === 'gp' ? 'sculpt' : 'gp'));
  if (k === 'c') return go(() => setSpace(S.space === 'curves' ? 'sculpt' : 'curves'));
  if (k === 'm') return go(() => setSpace(S.space === 'lib' ? 'sculpt' : 'lib'));
  if (k === 'z') return go(() => setSpace(S.space === 'zs' ? 'sculpt' : 'zs'));
  if (S.space === 'zs') {
    const t = { 1: 'add', 2: 'move', 3: 'scale', 4: 'del' }[e.key];
    if (t) return go(() => setZsTool(t));
    if (k === 'a') return go(() => setZsSkin(!ZS.skin));
    if (k === 'f') return go(frameZS);
    if ((k === 'delete' || k === 'backspace') && ZS.sel >= 0 && ZS.nodes[ZS.sel].parent >= 0) return go(() => { const before = zsSnap(), m = ZS.sym ? zsMirror(ZS.sel) : -1; zsRemove(m >= 0 && m !== ZS.sel ? [ZS.sel, m] : [ZS.sel]); pushUndo({ type: 'zs', label: 'supprimer une sphère', before, after: zsSnap() }); zsChanged(); });
    return;
  }
  if (S.space === 'lib') { if (k === 'f') return go(frameLib); return; }
  if (S.space === 'curves') {
    const t = { 1: 'shape', 2: 'path', 3: 'pen', 4: 'edit', 5: 'cursor' }[e.key];
    if (t) return go(() => setCvTool(t));
    if (k === 'enter') return go(() => cvPenFinish(false));
    if (k === 'escape') return go(() => { if (S.cvPen) cvPenFinish(false); else { S.cvSel = { id: null, a: -1 }; cvChanged(); } });
    if (k === 'delete' || k === 'backspace') return go(cvDeleteSelection);
    if (k === 'f') return go(frameAll);
    return;
  }
  if (S.space === 'gp') {
    const t = { 1: 'draw', 2: 'line', 3: 'erase', 4: 'cursor' }[e.key];
    if (t) return go(() => setGPTool(t));
    if (k === '[') return go(() => setGPThick(S.gpOpt.thickness / 1.15));
    if (k === ']') return go(() => setGPThick(S.gpOpt.thickness * 1.15));
    if (k === 'f') return go(frameAll);
    return;
  }
  const b = Sculpt.BRUSHES.find((x) => x.key === e.key);
  if (b) return go(() => setBrush(b.id));
  switch (k) {
    case 'q': return go(() => setMode('draw'));
    case 'w': return go(() => setMode('move'));
    case 'e': return go(() => setMode('scale'));
    case 'r': return go(() => setMode('rotate'));
    case 'f': return go(frameAll);
    case 'd': return go(() => stepLevel(1));
    case 'x': return go(() => toggleSym(0));
    case '[': return go(() => setSize(S.brush.size / 1.15));
    case ']': return go(() => setSize(S.brush.size * 1.15));
  }
});
window.addEventListener('keyup', (e) => { pointer.shift = e.shiftKey; pointer.ctrl = e.ctrlKey || e.metaKey; pointer.alt = e.altKey; req(); });
window.addEventListener('blur', () => { pointer.shift = pointer.ctrl = pointer.alt = false; });

// ------------------------------------------------------------ actions
function newSubtool(kind) {
  let g, levels = 0;
  if (kind === 'cube') g = Core.box(48);
  else if (kind === 'torus') g = Core.torus(96, 40);
  else { g = Core.icosphere(3); levels = 3; }
  const st = Core.makeSubtool({ sphere: 'Sphère', cube: 'Cube', torus: 'Tore' }[kind] || 'Sphère', Core.makeLevel(g.pos, g.idx, g.nv));
  for (let i = 0; i < levels; i++) Core.subtoolDivide(st);
  return st;
}
function appendSubtool(st, label) {
  const before = snapScene();
  S.subtools.push(st); S.active = S.subtools.length - 1;
  pushUndo({ type: 'scene', label, before, after: snapScene() });
  updateBounds(); refreshUI(); req();
}
function selectSubtool(i) { if (i === S.active) return; releaseUnused(); S.active = i; hint('SubTool actif : ' + active().name); refreshUI(); req(); }
function newScene() {
  run('Nouvelle scène…', () => {
    for (const st of S.subtools) for (const L of st.levels) releaseLevel(L);
    S.subtools = [newSubtool('sphere')]; S.active = 0; undoStack.length = 0; redoStack.length = 0;
    S.gp = Object.assign(GP.makeState(), { cursor: [0, 0, 0] }); refreshGPLayers();
    S.curves = []; S.cvSel = { id: null, a: -1 }; S.cvPen = null; S.cvDef = null; dropGhost(); refreshCurveUI();
    cam.q = [0, 0, 0, 1]; frameAll(); scheduleAutosave();
  });
}
function divide() {
  const st = active(); const top = st.levels[st.levels.length - 1];
  if (top.nt * 4 > MAX_FACES) { toast('Au-delà de ' + (MAX_FACES / 1e6) + ' M faces, le navigateur risque de manquer de mémoire.', true); return; }
  run('Subdivision…', () => {
    const before = snapState(st);
    Core.subtoolDivide(st); releaseUnused();
    pushUndo({ type: 'state', label: 'subdivision', st, before, after: snapState(st) });
    hint('Niveau ' + (st.cur + 1) + ' : ' + fmtN(Core.curLevel(st).nt) + ' faces');
  });
}
function stepLevel(dir) {
  const st = active(); const k = st.cur + dir;
  if (k < 0 || k >= st.levels.length) return;
  setLevel(k);
}
function setLevel(k) {
  const st = active(); if (k === st.cur) return;
  run('Niveau ' + (k + 1) + '…', () => { Core.subtoolSetLevel(st, k); releaseUnused(); updateBounds(); scheduleAutosave(); });
}
function delLower() { const st = active(); if (st.cur === 0) return; const before = snapState(st); for (let i = 0; i < st.cur; i++) releaseLevel(st.levels[i]); Core.subtoolDelLower(st); pushUndo({ type: 'state', label: 'Del Lower', st, before, after: snapState(st) }); refreshUI(); }
function delHigher() { const st = active(); if (st.cur === st.levels.length - 1) return; const before = snapState(st); Core.subtoolDelHigher(st); pushUndo({ type: 'state', label: 'Del Higher', st, before, after: snapState(st) }); refreshUI(); }
function replaceLevels(st, L, label) {
  const before = snapState(st);
  for (const old of st.levels) { releaseLevel(old); Core.dropMesh(old); }
  st.levels = [L]; st.cur = 0;
  pushUndo({ type: 'state', label, st, before, after: snapState(st) });
}
function dynamesh() {
  const st = active(); const L = aLevel();
  run('DynaMesh ' + S.dyna.res + '…', () => {
    const out = Core.remeshVoxel(L, S.dyna.res, { project: S.dyna.project });
    const multi = st.levels.length > 1;
    replaceLevels(st, out, 'DynaMesh');
    updateBounds();
    let msg = 'DynaMesh : ' + fmtN(out.nt) + ' faces';
    if (out.info.shell) msg += ' (maillage ouvert : coque épaisse générée)';
    if (multi) msg += ' · niveaux de subdivision remplacés';
    toast(msg, out.info.shell);
  });
}
function deleteHidden() {
  const st = active(), L = aLevel();
  if (!L.hidden) { toast('Aucune face cachée. ⇧⌘+clic sur un groupe pour isoler une partie.'); return; }
  if (st.levels.length > 1) { toast('Supprimez d’abord les niveaux de subdivision (Del Lower / Del Higher).', true); return; }
  const keep = new Uint8Array(L.nt); for (let t = 0; t < L.nt; t++) keep[t] = L.hidden[t] ? 0 : 1;
  const out = Core.compactLevel(L, keep);
  replaceLevels(st, out, 'supprimer les faces cachées'); updateBounds(); req(); refreshUI();
}
function mergeDown() {
  if (S.active >= S.subtools.length - 1) { toast('Aucun SubTool en dessous à fusionner.'); return; }
  run('Fusion…', () => {
    const before = snapScene();
    const a = active(), b = S.subtools[S.active + 1];
    const L = Core.mergeLevels([Core.curLevel(a), Core.curLevel(b)]);
    const st = Core.makeSubtool(a.name, L);
    S.subtools.splice(S.active, 2, st);
    pushUndo({ type: 'scene', label: 'fusion', before, after: snapScene() });
    hint('Fusionné. Lancez DynaMesh pour souder les deux formes.');
  });
}
function splitGroups() {
  const L = aLevel(); const st = active();
  const groups = [...new Set(L.groups)];
  if (groups.length < 2) { toast('Ce SubTool n’a qu’un polygroupe.'); return; }
  if (groups.length > 64) { toast(groups.length + ' polygroupes : trop pour les séparer en SubTools.', true); return; }
  run('Séparation…', () => {
    const before = snapScene(); const parts = [];
    for (const g of groups) {
      const keep = new Uint8Array(L.nt); for (let t = 0; t < L.nt; t++) keep[t] = L.groups[t] === g ? 1 : 0;
      parts.push(Core.makeSubtool(st.name + ' ' + (parts.length + 1), Core.compactLevel(L, keep)));
    }
    S.subtools.splice(S.active, 1, ...parts);
    pushUndo({ type: 'scene', label: 'séparation', before, after: snapScene() });
  });
}
function duplicate() {
  const L = aLevel();
  const c = Core.makeLevel(L.pos.slice(), L.idx.slice(), L.nv, { col: L.col.slice(), mask: L.mask.slice(), groups: L.groups.slice(), hidden: L.hidden ? L.hidden.slice() : null });
  appendSubtool(Core.makeSubtool(active().name + ' copie', c), 'dupliquer');
}
function deleteSubtool() {
  if (S.subtools.length < 2) { toast('Il faut garder au moins un SubTool.'); return; }
  const before = snapScene(); const st = active();
  S.subtools.splice(S.active, 1); S.active = Math.min(S.active, S.subtools.length - 1);
  pushUndo({ type: 'scene', label: 'supprimer ' + st.name, before, after: snapScene() });
  updateBounds(); refreshUI(); req();
}
function moveSubtool(dir) {
  const i = S.active, j = i + dir; if (j < 0 || j >= S.subtools.length) return;
  const before = snapScene();
  const a = S.subtools; [a[i], a[j]] = [a[j], a[i]]; S.active = j;
  pushUndo({ type: 'scene', label: 'ordre', before, after: snapScene() }); refreshUI();
}
function groupMaskOrVisible() {
  const L = aLevel(); let masked = false; for (let i = 0; i < L.nv; i++) if (L.mask[i] > 0.5) { masked = true; break; }
  withArr('nouveau polygroupe', 'groups', (L) => (masked ? Sculpt.groupFromMask(L) : Sculpt.groupVisible(L)));
  if (!S.display.groups) toggleDisplay('groups');
}

// ------------------------------------------------------------ fichiers
const fmtN = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + ' M' : n >= 1e4 ? Math.round(n / 1e3) + ' k' : String(n);
const downloadsP = window.claude && window.claude.use ? window.claude.use('downloads').catch(() => null) : Promise.resolve(null);
async function offerFile(filename, blob) {
  const dl = await Promise.race([downloadsP, new Promise((r) => setTimeout(() => r(undefined), 1500))]);
  if (dl) {
    try { await dl.save({ filename, data: blob }); toast('Fichier enregistré : ' + filename); }
    catch (e) { if (e && e.code === 'declined') toast('Enregistrement annulé.'); else toast('Enregistrement impossible ici (' + ((e && e.code) || 'erreur') + ').', true); }
    return;
  }
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
const safeName = (s) => s.replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '') || 'argile';
function saveProject() {
  run('Enregistrement…', async () => {
    const bytes = IO.serializeScene({ subtools: S.subtools, active: S.active, camera: cam.toJSON(), gp: S.gp, curves: S.curves });
    await offerFile(safeName(S.subtools[0].name) + '-argile.zip', IO.zipStore([{ name: 'scene.argile', data: bytes }, { name: 'LISEZMOI.txt', data: new TextEncoder().encode('Projet Argile Sculpt. Ouvrez ce .zip depuis Fichier > Ouvrir.\n') }]));
  });
}
function exportObj(all) {
  run('Export OBJ…', async () => {
    const list = all ? S.subtools.filter((s) => s.visible) : [active()];
    const files = list.map((st) => ({ name: safeName(st.name) + '.obj', data: new TextEncoder().encode(Core.exportOBJ([Core.curLevel(st)], [st.name], true)) }));
    await offerFile((all ? 'argile-scene' : safeName(active().name)) + '-obj.zip', IO.zipStore(files));
  });
}
async function openFiles(fileList) {
  const files = [...fileList]; if (!files.length) return;
  await run('Lecture…', async () => {
    let added = 0;
    for (const f of files) {
      const name = f.name.toLowerCase();
      if (name.endsWith('.ztl') || name.endsWith('.zpr')) { toast('Les fichiers ZBrush (.ztl/.zpr) ne sont pas lisibles : exportez en OBJ depuis ZBrush.', true); continue; }
      if (name.endsWith('.zip')) {
        const entries = await IO.unzip(await f.arrayBuffer());
        const proj = entries.find((x) => x.name.endsWith('.argile'));
        if (proj) { loadProjectBytes(proj.data); toast('Projet ouvert : ' + f.name); return; }
        for (const x of entries) if (x.name.toLowerCase().endsWith('.obj')) { addObj(new TextDecoder().decode(x.data), x.name); added++; }
      } else if (name.endsWith('.obj')) { addObj(await f.text(), f.name); added++; }
      else toast('Format non reconnu : ' + f.name + ' (OBJ ou ZIP attendus).', true);
    }
    if (added) { frameAll(); toast(added + ' maillage(s) importé(s).'); }
  });
}
function addObj(text, fname) {
  const r = Core.parseOBJ(text);
  if (!r.idx.length) throw new Error(fname + ' ne contient aucune face.');
  const L = Core.makeLevel(r.pos, r.idx, r.nv, { groups: r.groups, col: r.hasCol ? r.col : undefined });
  appendSubtool(Core.makeSubtool(fname.replace(/\.obj$/i, '').split('/').pop(), L), 'importer ' + fname);
}
function loadProjectBytes(bytes) {
  const sc = IO.deserializeScene(bytes);
  for (const st of S.subtools) for (const L of st.levels) releaseLevel(L);
  S.subtools = sc.subtools; S.active = Math.min(sc.active, sc.subtools.length - 1);
  S.gp = sc.gp ? Object.assign(sc.gp, { cursor: sc.gp.cursor || [0, 0, 0] }) : Object.assign(GP.makeState(), { cursor: [0, 0, 0] }); refreshGPLayers();
  S.curves = sc.curves || []; S.cvSel = { id: null, a: -1 }; S.cvPen = null; dropGhost(); refreshCurveUI();
  undoStack.length = 0; redoStack.length = 0;
  if (sc.camera) cam.fromJSON(sc.camera); else frameAll();
  updateBounds(); refreshUI(); req();
}
$('fileInput').addEventListener('change', (e) => { openFiles(e.target.files); e.target.value = ''; });
let dropEl = null;
view.addEventListener('dragover', (e) => { e.preventDefault(); if (!dropEl) { dropEl = document.createElement('div'); dropEl.className = 'drop'; dropEl.textContent = 'Déposez un OBJ ou un projet .zip'; view.appendChild(dropEl); } });
view.addEventListener('dragleave', (e) => { if (e.target === view || e.target === canvas) { dropEl && dropEl.remove(); dropEl = null; } });
view.addEventListener('drop', (e) => { e.preventDefault(); dropEl && dropEl.remove(); dropEl = null; openFiles(e.dataTransfer.files); });

// sauvegarde automatique locale (IndexedDB de ce navigateur)
let autosaveTimer = 0;
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    if (drag || busyCount) return scheduleAutosave();
    try { IO.autosavePut(IO.serializeScene({ subtools: S.subtools, active: S.active, camera: cam.toJSON(), gp: S.gp, curves: S.curves })).catch(() => {}); } catch (_) { /* stockage indisponible */ }
  }, 2500);
}

// ------------------------------------------------------------ interface
function hint(msg) { $('hint').textContent = msg; }
function brushHint() {
  const b = Sculpt.BRUSHES.find((x) => x.id === S.brush.type);
  hint(b.label + ' — ' + b.hint);
}
const CODES = { standard: 'St', clay: 'Cl', claybuildup: 'CB', move: 'Mv', inflate: 'In', pinch: 'Pi', flatten: 'Fl', dam: 'DS', smooth: 'Sm', mask: 'Mk', paint: 'Pp' };
function buildRail() {
  const wrap = $('brushes');
  for (const b of Sculpt.BRUSHES) {
    if (b.id === 'mask') continue;
    const el = document.createElement('button'); el.className = 'brush'; el.dataset.brush = b.id;
    el.title = b.label + ' — ' + b.hint + (b.key.length === 1 ? ' (' + b.key + ')' : '');
    el.innerHTML = '<span class="code">' + CODES[b.id] + '</span><span class="key">' + (b.key.length === 1 ? b.key : '⇧') + '</span>';
    el.addEventListener('click', () => setBrush(b.id));
    wrap.appendChild(el);
  }
  const aw = $('alphas');
  const names = { none: 'Rond', noise: 'Bruit', pores: 'Pores', square: 'Carré', stripes: 'Stries' };
  for (const k of Object.keys(alphas)) {
    const el = document.createElement('button'); el.className = 'alpha'; el.dataset.alpha = k; el.title = 'Alpha : ' + names[k];
    const c = document.createElement('canvas'); c.width = 36; c.height = 36; el.appendChild(c);
    const g = c.getContext('2d'); const img = g.createImageData(36, 36); const A = alphas[k];
    for (let y = 0; y < 36; y++) for (let x = 0; x < 36; x++) {
      let v;
      if (!A) { const r = Math.hypot(x / 35 * 2 - 1, y / 35 * 2 - 1); v = Sculpt.falloff(Math.min(1, r), 0); }
      else v = A.data[Math.floor(y / 35 * (A.size - 1)) * A.size + Math.floor(x / 35 * (A.size - 1))];
      const o = 4 * (y * 36 + x); img.data[o] = img.data[o + 1] = img.data[o + 2] = Math.round(v * 235 + 20); img.data[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    el.addEventListener('click', () => { S.brush.alpha = k; refreshUI(); });
    aw.appendChild(el);
  }
}
function setBrush(id) { S.brush.type = id; if (S.space !== 'sculpt') setSpace('sculpt'); if (S.mode !== 'draw') setMode('draw'); brushHint(); refreshUI(); }
function setMode(m) { if (S.space !== 'sculpt') setSpace('sculpt'); S.mode = m; $('modeLabel').textContent = m === 'draw' ? '' : { move: 'Déplacer le SubTool', scale: 'Échelle du SubTool', rotate: 'Pivoter le SubTool' }[m]; canvas.style.cursor = m === 'draw' ? 'none' : 'grab'; refreshUI(); req(); }
function setSize(v) { S.brush.size = Math.round(Math.max(4, Math.min(400, v))); $('size').value = S.brush.size; $('sizeOut').textContent = S.brush.size; req(); }
function toggleSym(a) { S.sym[a] = !S.sym[a]; refreshUI(); }
function toggleDisplay(k) { S.display[k] = !S.display[k]; refreshUI(); req(); }

function refreshUndoUI() { $('undoBtn').disabled = !undoStack.length; $('redoBtn').disabled = !redoStack.length; }
function refreshStats() {
  const st = active(); if (!st) return;
  const L = Core.curLevel(st); let tot = 0; for (const s of S.subtools) if (s.visible) tot += Core.curLevel(s).nt;
  $('stats').innerHTML = '<b>' + fmtN(L.nv) + '</b> pts · <b>' + fmtN(L.nt) + '</b> faces<br>scène ' + fmtN(tot) + ' faces';
}
function refreshUI() {
  document.querySelectorAll('.brush').forEach((el) => el.classList.toggle('on', el.dataset.brush === S.brush.type));
  document.querySelectorAll('.alpha').forEach((el) => el.classList.toggle('on', el.dataset.alpha === S.brush.alpha));
  document.querySelectorAll('[data-mode]').forEach((el) => el.classList.toggle('on', el.dataset.mode === S.mode));
  $('zadd').classList.toggle('on', S.brush.zadd); $('zsub').classList.toggle('on', !S.brush.zadd);
  $('lazyBtn').classList.toggle('on', S.brush.lazy); $('penSizeBtn').classList.toggle('on', S.brush.penSize);
  ['symX', 'symY', 'symZ'].forEach((id, i) => $(id).classList.toggle('on', S.sym[i]));
  $('wireBtn').classList.toggle('on', S.display.wire); $('groupsBtn').classList.toggle('on', S.display.groups);
  $('spaceSculpt').classList.toggle('on', S.space === 'sculpt'); $('spaceGP').classList.toggle('on', S.space === 'gp'); $('spaceCurves').classList.toggle('on', S.space === 'curves'); $('spaceLib').classList.toggle('on', S.space === 'lib'); $('spaceZS').classList.toggle('on', S.space === 'zs');
  document.querySelectorAll('[data-zstool]').forEach((el) => el.classList.toggle('on', el.dataset.zstool === ZS.tool));
  document.querySelectorAll('[data-cvtool]').forEach((el) => el.classList.toggle('on', el.dataset.cvtool === S.cvTool));
  document.querySelectorAll('[data-gptool]').forEach((el) => el.classList.toggle('on', el.dataset.gptool === S.gpTool));
  document.querySelectorAll('.sw').forEach((el) => el.classList.toggle('on', el.dataset.hex === rgbHex(S.gpOpt.color)));
  $('gpFrontBtn').classList.toggle('on', S.gpOpt.front);
  refreshUndoUI();
  const st = active(); if (!st) return;
  // SubTools
  const list = $('stlist'); list.innerHTML = '';
  S.subtools.forEach((s, i) => {
    const row = document.createElement('div'); row.className = 'st' + (i === S.active ? ' on' : '');
    const eye = document.createElement('button'); eye.className = 'eye' + (s.visible ? '' : ' off'); eye.textContent = s.visible ? '◉' : '○'; eye.title = s.visible ? 'Masquer' : 'Afficher';
    eye.addEventListener('click', (ev) => { ev.stopPropagation(); s.visible = !s.visible; updateBounds(); refreshUI(); req(); });
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = s.name;
    nm.addEventListener('dblclick', () => {
      const inp = document.createElement('input'); inp.className = 'nm'; inp.type = 'text'; inp.value = s.name; inp.id = 'rename-' + s.id;
      nm.replaceWith(inp); inp.focus(); inp.select();
      const done = () => { s.name = inp.value.trim() || s.name; refreshUI(); scheduleAutosave(); };
      inp.addEventListener('blur', done); inp.addEventListener('keydown', (k) => { if (k.key === 'Enter') inp.blur(); if (k.key === 'Escape') { inp.value = s.name; inp.blur(); } });
    });
    const cnt = document.createElement('span'); cnt.className = 'cnt'; cnt.textContent = fmtN(Core.curLevel(s).nt) + (s.levels.length > 1 ? ' · ' + (s.cur + 1) + '/' + s.levels.length : '');
    row.append(eye, nm, cnt);
    row.addEventListener('click', () => selectSubtool(i));
    list.appendChild(row);
  });
  // niveaux
  const lv = $('levels'); lv.innerHTML = '';
  st.levels.forEach((L, k) => {
    const b = document.createElement('button'); b.className = 'btn' + (k === st.cur ? ' on' : ''); b.textContent = k + 1; b.title = fmtN(L.nt) + ' faces';
    b.addEventListener('click', () => setLevel(k)); lv.appendChild(b);
  });
  $('levelNum').textContent = (st.cur + 1) + ' / ' + st.levels.length;
  $('lowerBtn').disabled = st.cur === 0; $('higherBtn').disabled = st.cur === st.levels.length - 1;
  $('delLowerBtn').disabled = st.cur === 0; $('delHigherBtn').disabled = st.cur === st.levels.length - 1;
  $('mergeBtn').disabled = S.active >= S.subtools.length - 1; $('delBtn').disabled = S.subtools.length < 2;
  refreshStats();
}

function bindUI() {
  const on = (id, fn) => $(id).addEventListener('click', fn);
  // menu Fichier
  const fl = $('fileList');
  on('fileBtn', (e) => { e.stopPropagation(); fl.hidden = !fl.hidden; $('fileBtn').setAttribute('aria-expanded', String(!fl.hidden)); });
  document.addEventListener('click', () => { fl.hidden = true; $('fileBtn').setAttribute('aria-expanded', 'false'); });
  on('mNew', newScene); on('mOpen', () => $('fileInput').click()); on('mSave', saveProject);
  on('mExportAll', () => exportObj(true)); on('mExportOne', () => exportObj(false));
  on('undoBtn', undo); on('redoBtn', redo);
  document.querySelectorAll('[data-mode]').forEach((el) => el.addEventListener('click', () => setMode(el.dataset.mode)));
  on('zadd', () => { S.brush.zadd = true; refreshUI(); }); on('zsub', () => { S.brush.zadd = false; refreshUI(); });
  $('size').addEventListener('input', (e) => setSize(+e.target.value));
  $('intensity').addEventListener('input', (e) => { S.brush.intensity = +e.target.value; $('intensityOut').textContent = e.target.value; });
  $('focal').addEventListener('input', (e) => { S.brush.focal = +e.target.value / 100; $('focalOut').textContent = e.target.value; req(); });
  on('lazyBtn', () => { S.brush.lazy = !S.brush.lazy; refreshUI(); });
  on('penSizeBtn', () => { S.brush.penSize = !S.brush.penSize; refreshUI(); });
  on('symX', () => toggleSym(0)); on('symY', () => toggleSym(1)); on('symZ', () => toggleSym(2));
  on('wireBtn', () => toggleDisplay('wire')); on('groupsBtn', () => toggleDisplay('groups'));
  $('material').addEventListener('change', (e) => { S.display.material = +e.target.value; req(); });
  $('color').addEventListener('input', (e) => { const h = e.target.value; S.brush.color = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); });
  on('sideToggle', () => $('side').classList.toggle('open'));
  // SubTools
  $('appendSel').addEventListener('change', (e) => { const k = e.target.value; e.target.value = ''; if (k) run('Ajout…', () => appendSubtool(newSubtool(k), 'ajouter ' + k)); });
  on('dupBtn', duplicate); on('delBtn', deleteSubtool); on('upBtn', () => moveSubtool(-1)); on('downBtn', () => moveSubtool(1));
  on('mergeBtn', mergeDown); on('splitBtn', splitGroups);
  // géométrie
  on('divideBtn', divide); on('lowerBtn', () => stepLevel(-1)); on('higherBtn', () => stepLevel(1));
  on('delLowerBtn', delLower); on('delHigherBtn', delHigher); on('delHiddenBtn', deleteHidden);
  // DynaMesh
  $('dynaRes').addEventListener('input', (e) => { S.dyna.res = +e.target.value; $('dynaResOut').textContent = e.target.value; });
  $('dynaProject').addEventListener('change', (e) => { S.dyna.project = e.target.checked; });
  on('dynaBtn', dynamesh);
  // masque
  on('maskInvBtn', () => withArr('inverser le masque', 'mask', (L) => Sculpt.maskInvert(L)));
  on('maskClearBtn', () => withArr('effacer le masque', 'mask', (L) => Sculpt.maskClear(L)));
  on('maskBlurBtn', () => withArr('adoucir le masque', 'mask', (L) => Sculpt.maskBlur(L, aMesh(), false)));
  on('maskSharpBtn', () => withArr('durcir le masque', 'mask', (L) => Sculpt.maskBlur(L, aMesh(), true)));
  // polygroupes
  on('grpMaskBtn', groupMaskOrVisible);
  on('grpAutoBtn', () => { withArr('groupes par pièces', 'groups', (L) => Sculpt.autoGroups(L)); if (!S.display.groups) toggleDisplay('groups'); });
  on('grpNormBtn', () => { withArr('groupes par normales', 'groups', (L) => Sculpt.groupsByNormal(L, aMesh(), 35)); if (!S.display.groups) toggleDisplay('groups'); });
  on('showAllBtn', () => withArr('tout afficher', 'hidden', (L) => Sculpt.showAll(L)));
  on('invVisBtn', () => withArr('inverser la visibilité', 'hidden', (L) => Sculpt.invertVisibility(L)));
  // polypaint
  $('paintShow').addEventListener('change', (e) => { S.display.paint = e.target.checked; req(); });
  on('fillBtn', () => withArr('remplir la couleur', 'col', (L) => Sculpt.fillColor(L, S.brush.color, true)));
  on('clearColBtn', () => withArr('effacer la couleur', 'col', (L) => Sculpt.clearColor(L)));
  new ResizeObserver(() => req()).observe(view);
}

// ------------------------------------------------------------ Courbes de Bézier → maillages
const CV_TOOLS = [
  { id: 'shape', code: 'Fo', key: '1', label: 'Forme', hint: 'Dessine un contour fermé à main levée ; il devient un solide à plat' },
  { id: 'path', code: 'Co', key: '2', label: 'Courbe', hint: 'Dessine un tracé ouvert à main levée ; il devient un cylindre extrudé' },
  { id: 'pen', code: 'Pl', key: '3', label: 'Plume', hint: 'Clic = point anguleux, glisser = point lisse, premier point = fermer, Entrée = terminer' },
  { id: 'edit', code: 'Éd', key: '4', label: 'Éditer', hint: 'Glisser points et poignées ; double-clic sur la courbe ajoute un point, sur un point le rend lisse ou anguleux' },
  { id: 'cursor', code: '3D', key: '5', label: 'Curseur 3D', hint: 'Place le curseur qui fixe la profondeur des plans' },
];
const cvSel = () => S.curves.find((c) => c.id === S.cvSel.id) || null;
let cvLinesCache = null, ghost = null, ghostTimer = 0, cvParamBefore = null, lastDown = { t: 0, x: 0, y: 0 };
const sR = () => Math.max(1e-3, sceneRadius);
function cvTouch() { cvLinesCache = null; req(); }
function cvChanged(now) { cvLinesCache = null; scheduleGhost(now); refreshCurveUI(); req(); }
function cvSnap() { return { curves: Curves.clone(S.curves), sel: { ...S.cvSel } }; }
function cvCommit(label, before) { pushUndo({ type: 'curves', label, before, after: cvSnap() }); }
function cvEdit(label, fn) { const before = cvSnap(); fn(); cvCommit(label, before); cvChanged(); }
function nextName(base) { let n = 1; const names = new Set(S.curves.map((c) => c.name)); while (names.has(base + ' ' + n)) n++; return base + ' ' + n; }
function cvDefaults() {
  if (!S.cvDef) { const k = sR(); S.cvDef = Object.assign({}, Curves.DEFAULTS.shape, Curves.DEFAULTS.sweep, { thickness: 0.12 * k, bevel: 0.015 * k, radius: 0.05 * k }); }
  return Object.assign({}, S.cvDef);
}
// Plan de travail : plans fixes passant par le curseur 3D, ou plan de vue ; normale tournée vers la caméra
function placePlane() {
  const p = S.gpOpt.place, o = S.gp.cursor.slice();
  let u, v;
  if (p === 'xy') { u = [1, 0, 0]; v = [0, 1, 0]; } else if (p === 'xz') { u = [1, 0, 0]; v = [0, 0, -1]; } else if (p === 'yz') { u = [0, 1, 0]; v = [0, 0, 1]; }
  else { const b = cam.basis(); u = b.r; v = b.u; }
  let n = V.cross(u, v);
  if (V.dot(n, cam.basis().b) < 0) { n = V.scale(n, -1); v = V.scale(v, -1); }
  return { o, u, v, n };
}
function rayPlane(x, y, o, n) {
  const r = cam.ray(x, y), dn = V.dot(r.d, n); if (Math.abs(dn) < 1e-6) return null;
  const t = V.dot(V.sub(o, r.o), n) / dn; return t > 0 ? V.add(r.o, V.scale(r.d, t)) : null;
}
function shapePlane(points) {
  if (S.gpOpt.place === 'surface') return Curves.fitPlane(points, cam.basis().b);
  const pl = placePlane(); let c = [0, 0, 0]; for (const p of points) c = V.add(c, p);
  pl.o = Curves.projectOnPlane(pl, V.scale(c, 1 / points.length)); return pl;
}
const cvUp = () => (S.gpOpt.place === 'surface' || S.gpOpt.place === 'view' ? cam.basis().b : placePlane().n);
function newShape(pts, plane, name) {
  const c = Curves.makeCurve('shape', pts, true, { plane, params: cvDefaults(), name: name || nextName('Forme') });
  c.params.anchor = S.gpOpt.place === 'surface' ? 'top' : 'center';
  Curves.flattenToPlane(c); return c;
}
const hitR = (e) => (e && (e.pointerType === 'pen' || e.pointerType === 'touch') ? 15 : 9);
const proj2 = (p) => cam.project(p);

function cvDown(e, x, y) {
  const dbl = now() - lastDown.t < 380 && Math.hypot(x - lastDown.x, y - lastDown.y) < 10;
  lastDown = { t: dbl ? 0 : now(), x, y };
  const tool = S.cvTool;
  if (tool === 'cursor') { drag = { kind: 'gpCursor' }; gpSetCursor(x, y); return; }
  if (tool === 'pen') { cvPenDown(e, x, y, dbl); return; }
  if (tool === 'edit') { cvEditDown(e, x, y, dbl); return; }
  const pl = gpPlace(x, y);
  drag = { kind: 'cvDraw', tool, raw: pl ? [pl.p] : [], screen: [[x, y]], smooth: [x, y], last: [x, y] };
  req();
}
function cvDrawMove(x, y) {
  const d = drag, k = S.gpOpt.stab;
  d.smooth = [d.smooth[0] + (x - d.smooth[0]) * (1 - k), d.smooth[1] + (y - d.smooth[1]) * (1 - k)];
  const [sx, sy] = d.smooth;
  if (Math.hypot(sx - d.last[0], sy - d.last[1]) < 2) return;
  d.last = [sx, sy]; d.screen.push([sx, sy]);
  const pl = gpPlace(sx, sy); if (pl) d.raw.push(pl.p);
  req();
}
function cvDrawEnd() {
  const d = drag; drag = null; req();
  if (d.raw.length < 4) { hint('Tracé trop court.'); return; }
  let c0 = [0, 0, 0]; for (const p of d.raw) c0 = V.add(c0, p); c0 = V.scale(c0, 1 / d.raw.length);
  const tol = 2.5 * cam.pixelSize(c0), closed = d.tool === 'shape';
  const pts = Curves.fitPath(d.raw, tol, closed);
  if (!pts || pts.length < 2) { hint('Tracé trop court.'); return; }
  const c = closed ? newShape(pts, shapePlane(d.raw)) : Curves.makeCurve('sweep', pts, false, { up: cvUp(), params: cvDefaults(), name: nextName('Courbe') });
  cvEdit(closed ? 'nouvelle forme' : 'nouvelle courbe', () => { S.curves.push(c); S.cvSel = { id: c.id, a: -1 }; });
  hint(c.name + ' : ' + c.pts.length + ' points de Bézier. Outil Éditer (4) pour l’ajuster, puis « Créer le SubTool ».');
}

// ---- plume
function cvPenDown(e, x, y, dbl) {
  let c = S.cvPen ? S.curves.find((q) => q.id === S.cvPen.id) : null;
  if (c && dbl && c.pts.length >= 2) { cvPenFinish(false); drag = { kind: 'none' }; return; }
  if (c && c.pts.length >= 3) {
    const f = proj2(c.pts[0].p);
    if (f && Math.hypot(f[0] - x, f[1] - y) < hitR(e) + 3) { cvPenFinish(true); drag = { kind: 'none' }; return; }
  }
  const pl = gpPlace(x, y);
  if (!pl) { toast('Aucun point d’appui ici : visez un objet ou changez le plan de dessin.', true); drag = { kind: 'none' }; return; }
  if (!c) {
    const before = cvSnap();
    c = Curves.makeCurve('sweep', [], false, { up: cvUp(), params: cvDefaults(), name: nextName('Courbe') });
    S.curves.push(c); S.cvPen = { id: c.id, before };
  }
  c.pts.push(Curves.anchor(pl.p, null, null, false));
  S.cvSel = { id: c.id, a: c.pts.length - 1 };
  drag = { kind: 'cvPenDrag', c, idx: c.pts.length - 1, start: [x, y], moved: false };
  cvTouch(); refreshCurveUI();
}
function cvPenDrag(x, y) {
  const d = drag, A = d.c.pts[d.idx];
  if (!d.moved && Math.hypot(x - d.start[0], y - d.start[1]) < 5) return;
  d.moved = true;
  const n = S.gpOpt.place === 'surface' || S.gpOpt.place === 'view' ? cam.basis().b : placePlane().n;
  const q = rayPlane(x, y, A.p, n); if (!q) return;
  A.o = q; A.i = V.sub(V.scale(A.p, 2), q); A.smooth = true;
  cvTouch();
}
function cvPenFinish(close) {
  const st = S.cvPen; if (!st) return;
  S.cvPen = null;
  const i = S.curves.findIndex((q) => q.id === st.id); if (i < 0) return;
  const c = S.curves[i];
  if (close && c.pts.length >= 3) {
    const pts = []; for (const A of c.pts) pts.push(A.p, A.i, A.o);
    const shape = newShape(c.pts, shapePlane(pts), c.name.replace('Courbe', 'Forme'));
    shape.id = c.id; S.curves[i] = shape;
    hint('Forme fermée : ' + shape.pts.length + ' points.');
  } else if (c.pts.length < 2) { S.curves.splice(i, 1); S.cvSel = { id: null, a: -1 }; cvChanged(); return; }
  else hint('Courbe terminée : ' + c.pts.length + ' points.');
  cvCommit(close ? 'forme à la plume' : 'courbe à la plume', st.before);
  cvChanged(true);
}

// ---- édition
function cvHit(x, y, e) {
  const R = hitR(e), sel = cvSel();
  if (sel && sel.visible) {
    const n = sel.pts.length;
    for (let i = 0; i < n; i++) for (const w of ['i', 'o']) {
      if (!sel.closed && ((i === 0 && w === 'i') || (i === n - 1 && w === 'o'))) continue;
      const A = sel.pts[i]; if (V.len(V.sub(A[w], A.p)) < 1e-9) continue;
      const q = proj2(A[w]); if (q && Math.hypot(q[0] - x, q[1] - y) < R) return { type: 'handle', c: sel, idx: i, which: w };
    }
  }
  const order = sel ? [sel, ...S.curves.filter((c) => c !== sel)] : S.curves;
  for (const c of order) {
    if (!c.visible) continue;
    for (let i = 0; i < c.pts.length; i++) { const q = proj2(c.pts[i].p); if (q && Math.hypot(q[0] - x, q[1] - y) < R) return { type: 'anchor', c, idx: i }; }
  }
  let best = null;
  for (const c of order) { if (!c.visible || c.pts.length < 2) continue; const r = Curves.nearest(c, proj2, x, y, 24); if (r.d < R && (!best || r.d < best.d)) best = { type: 'curve', c, k: r.k, t: r.t, d: r.d }; }
  return best;
}
function cvEditDown(e, x, y, dbl) {
  const h = cvHit(x, y, e);
  if (!h) { if (S.cvSel.id !== null) { S.cvSel = { id: null, a: -1 }; cvChanged(); } drag = { kind: 'bg', start: [x, y], last: [x, y], moved: false }; return; }
  const c = h.c;
  if (S.cvSel.id !== c.id) { S.cvSel = { id: c.id, a: -1 }; scheduleGhost(); }
  if (h.type === 'anchor' && (dbl || e.altKey)) { cvEdit('point lisse / angle', () => { S.cvSel.a = h.idx; Curves.setSmooth(c, h.idx, !c.pts[h.idx].smooth); }); drag = { kind: 'none' }; return; }
  if (h.type === 'curve' && dbl) { cvEdit('ajout d’un point', () => { S.cvSel.a = Curves.splitAt(c, h.k, h.t); }); drag = { kind: 'none' }; return; }
  if (h.type !== 'handle') S.cvSel.a = h.type === 'anchor' ? h.idx : -1;
  const ref = h.type === 'anchor' ? c.pts[h.idx].p : h.type === 'handle' ? c.pts[h.idx][h.which] : Curves.bez(Curves.segment(c, h.k), h.t);
  drag = { kind: 'cvMove', h, c, before: cvSnap(), moved: false, start: [x, y], grab: ref.slice() };
  refreshCurveUI(); req();
}
function cvTarget(c, ref, x, y) {
  if (c.kind === 'shape' && c.plane) return rayPlane(x, y, c.plane.o, c.plane.n);
  if (S.gpOpt.place === 'surface') { const h = pickAny(x, y); if (h) return h.p; }
  const n = S.gpOpt.place === 'view' || S.gpOpt.place === 'surface' ? cam.basis().b : placePlane().n;
  return rayPlane(x, y, ref, n);
}
function cvMove(x, y) {
  const d = drag, h = d.h, c = d.c;
  if (!d.moved && Math.hypot(x - d.start[0], y - d.start[1]) < 3) return;
  d.moved = true;
  if (h.type === 'curve') {
    const n = c.kind === 'shape' && c.plane ? c.plane.n : cam.basis().b;
    const q = rayPlane(x, y, d.grab, n); if (!q) return;
    Curves.translate(c, V.sub(q, d.grab)); d.grab = q;
  } else {
    const ref = h.type === 'anchor' ? c.pts[h.idx].p : c.pts[h.idx][h.which];
    const q = cvTarget(c, ref, x, y); if (!q) return;
    if (h.type === 'anchor') Curves.moveAnchor(c, h.idx, q); else Curves.moveHandle(c, h.idx, h.which, q);
  }
  dropGhost(); cvTouch();
}
function cvMoveEnd() {
  const d = drag; drag = null;
  if (d.moved) { cvCommit({ anchor: 'déplacer un point', handle: 'déplacer une poignée', curve: 'déplacer la courbe' }[d.h.type], d.before); }
  cvChanged(true);
}
function cvDeleteSelection() {
  const c = cvSel(); if (!c) return;
  if (S.cvSel.a >= 0) {
    if (!Curves.removeAnchor(c, S.cvSel.a)) { toast('Une ' + (c.closed ? 'forme garde au moins 3 points.' : 'courbe garde au moins 2 points.')); return; }
    const a = S.cvSel.a; cvEdit('supprimer le point', () => { S.cvSel.a = Math.min(a, c.pts.length - 1); });
    return;
  }
  cvEdit('supprimer ' + c.name, () => { S.curves = S.curves.filter((q) => q !== c); S.cvSel = { id: null, a: -1 }; });
}

// ---- aperçu 3D et création
function dropGhost() { if (ghost) { releaseLevel(ghost.level); ghost = null; req(); } }
function scheduleGhost(nowFlag) { clearTimeout(ghostTimer); ghostTimer = setTimeout(buildGhost, nowFlag ? 0 : 180); }
function buildGhost() {
  dropGhost();
  if (S.space !== 'curves' || !S.cvOpt.ghost || (drag && /^cv/.test(drag.kind))) return;
  const c = cvSel(); if (!c || c.pts.length < 2 || S.cvPen) return;
  try {
    const m = Curves.bake(c, S.curves, { res: Math.min(c.params.res, 96) });
    if (m && m.nv) ghost = { id: c.id, level: Core.makeLevel(m.pos, m.idx, m.nv) };
  } catch (err) { hint(err.message); }
  req();
}
function cvBake(all) {
  if (S.cvPen) cvPenFinish(false);
  const list = all ? S.curves.filter((c) => c.visible && c.pts.length >= 2) : [cvSel()].filter((c) => c && c.pts.length >= 2);
  if (!list.length) { toast(all ? 'Aucune courbe visible.' : 'Sélectionnez une courbe ou une forme dans la liste.'); return; }
  run('Création du maillage…', () => {
    const beforeScene = snapScene(), beforeCv = cvSnap();
    let made = 0, faces = 0;
    for (const c of list) {
      const m = Curves.bake(c, S.curves); if (!m || !m.nv) continue;
      const L = Core.makeLevel(m.pos, m.idx, m.nv);
      S.subtools.push(Core.makeSubtool(c.name, L)); made++; faces += L.nt;
    }
    if (!made) { toast('Impossible de créer un maillage avec cette courbe.', true); return; }
    S.active = S.subtools.length - 1;
    const list2 = [{ type: 'scene', before: beforeScene, after: snapScene() }];
    if (!S.cvOpt.keep) {
      const ids = new Set(list.map((c) => c.id)); S.curves = S.curves.filter((c) => !ids.has(c.id)); S.cvSel = { id: null, a: -1 };
      list2.push({ type: 'curves', before: beforeCv, after: cvSnap() });
    }
    pushUndo({ type: 'multi', label: made > 1 ? made + ' maillages' : 'maillage ' + list[0].name, list: list2 });
    dropGhost(); cvChanged(); updateBounds();
    toast(made + ' SubTool' + (made > 1 ? 's' : '') + ' créé' + (made > 1 ? 's' : '') + ' (' + fmtN(faces) + ' faces). Passez en Sculpt pour ' + (made > 1 ? 'les' : 'le') + ' travailler.');
  });
}
function gpToCurves() {
  const strokes = GP.visibleStrokes(S.gp);
  if (!strokes.length) { toast('Aucun trait visible à convertir.'); return; }
  let n = 0;
  cvEdit('traits → courbes', () => {
    for (const s of strokes) {
      const cnt = GP.count(s), pts = []; let r = 0;
      for (let i = 0; i < cnt; i++) { pts.push([s.pts[4 * i], s.pts[4 * i + 1], s.pts[4 * i + 2]]); r += s.pts[4 * i + 3]; }
      r /= cnt;
      const fit = Curves.fitPath(pts, Math.max(r * 0.35, sR() * 1e-4), false); if (!fit) continue;
      const c = Curves.makeCurve('sweep', fit, false, { up: cam.basis().b, params: Object.assign(cvDefaults(), { radius: r }), name: nextName('Trait') });
      S.curves.push(c); S.cvSel = { id: c.id, a: -1 }; n++;
    }
  });
  setSpace('curves'); setCvTool('edit');
  toast(n + ' trait(s) convertis en courbes éditables.');
}

// ---- dessin dans le viewport
function drawPolyline(pts, closed) {
  let started = false; octx.beginPath();
  for (const p of pts) { const q = proj2(p); if (!q) { started = false; continue; } if (!started) { octx.moveTo(q[0], q[1]); started = true; } else octx.lineTo(q[0], q[1]); }
  if (closed && started) octx.closePath();
}
function drawCurvesOverlay() {
  drawPlaneGuides();
  const sel = cvSel();
  for (const c of S.curves) {
    if (!c.visible || !c.pts.length) continue;
    const isSel = c === sel, col = c.kind === 'shape' ? '227,164,79' : '127,178,229';
    const pts = Curves.polyline(c, 20);
    if (c.kind === 'shape' && pts.length > 2 && !(isSel && ghost)) { drawPolyline(pts, true); octx.fillStyle = 'rgba(' + col + ',' + (isSel ? 0.14 : 0.07) + ')'; octx.fill(); }
    drawPolyline(pts, c.closed);
    octx.strokeStyle = 'rgba(' + col + ',' + (isSel ? 1 : 0.6) + ')'; octx.lineWidth = isSel ? 2.5 : 1.5; octx.stroke();
  }
  if (sel && sel.visible) {
    if (!ghost || (drag && /^cv/.test(drag.kind))) {
      if (!cvLinesCache) { try { cvLinesCache = Curves.previewLines(sel, S.curves); } catch (_) { cvLinesCache = []; } }
      octx.strokeStyle = 'rgba(235,229,220,.28)'; octx.lineWidth = 1;
      for (const l of cvLinesCache) { drawPolyline(l, false); octx.stroke(); }
    }
    const n = sel.pts.length;
    sel.pts.forEach((A, i) => {
      const p = proj2(A.p); if (!p) return;
      for (const w of ['i', 'o']) {
        if (!sel.closed && ((i === 0 && w === 'i') || (i === n - 1 && w === 'o'))) continue;
        if (V.len(V.sub(A[w], A.p)) < 1e-9) continue;
        const q = proj2(A[w]); if (!q) continue;
        octx.strokeStyle = 'rgba(235,229,220,.55)'; octx.lineWidth = 1; octx.beginPath(); octx.moveTo(p[0], p[1]); octx.lineTo(q[0], q[1]); octx.stroke();
        octx.fillStyle = '#ebe5dc'; octx.beginPath(); octx.arc(q[0], q[1], 4, 0, Math.PI * 2); octx.fill();
      }
      const on = i === S.cvSel.a;
      octx.fillStyle = on ? '#e3a44f' : '#201f1d'; octx.strokeStyle = on ? '#fff' : '#e3a44f'; octx.lineWidth = 1.5;
      octx.beginPath();
      if (A.smooth) octx.arc(p[0], p[1], 5.5, 0, Math.PI * 2); else octx.rect(p[0] - 5, p[1] - 5, 10, 10);
      octx.fill(); octx.stroke();
    });
  }
  // tracé en cours / plume
  if (drag && drag.kind === 'cvDraw' && drag.screen.length > 1) {
    octx.strokeStyle = 'rgba(240,180,95,.95)'; octx.lineWidth = 2; octx.setLineDash([5, 4]); octx.beginPath();
    drag.screen.forEach(([x, y], i) => (i ? octx.lineTo(x, y) : octx.moveTo(x, y)));
    if (drag.tool === 'shape') octx.closePath();
    octx.stroke(); octx.setLineDash([]);
  }
  if (S.cvPen && pointer.inside && !(drag && drag.kind === 'cvPenDrag')) {
    const c = S.curves.find((q) => q.id === S.cvPen.id);
    if (c && c.pts.length) {
      const a = proj2(c.pts[c.pts.length - 1].p), f = proj2(c.pts[0].p);
      if (a) { octx.strokeStyle = 'rgba(235,229,220,.6)'; octx.setLineDash([4, 4]); octx.beginPath(); octx.moveTo(a[0], a[1]); octx.lineTo(pointer.x, pointer.y); octx.stroke(); octx.setLineDash([]); }
      if (f && c.pts.length >= 3 && Math.hypot(f[0] - pointer.x, f[1] - pointer.y) < 18) { octx.strokeStyle = '#e3a44f'; octx.lineWidth = 2; octx.beginPath(); octx.arc(f[0], f[1], 10, 0, Math.PI * 2); octx.stroke(); }
    }
  }
  if (!pointer.inside || S.cvTool === 'edit') return;
  octx.strokeStyle = 'rgba(255,255,255,.85)'; octx.lineWidth = 1; octx.beginPath();
  octx.moveTo(pointer.x - 9, pointer.y); octx.lineTo(pointer.x + 9, pointer.y); octx.moveTo(pointer.x, pointer.y - 9); octx.lineTo(pointer.x, pointer.y + 9); octx.stroke();
}

// ---- interface
function buildCvRail() {
  const wrap = $('cvTools');
  for (const t of CV_TOOLS) {
    const el = document.createElement('button'); el.className = 'brush'; el.dataset.cvtool = t.id;
    el.title = t.label + ' — ' + t.hint + ' (' + t.key + ')';
    el.innerHTML = '<span class="code">' + t.code + '</span><span class="key">' + t.key + '</span>';
    el.addEventListener('click', () => setCvTool(t.id));
    wrap.appendChild(el);
  }
  const ps = $('cvProfile');
  for (const p of Curves.PROFILES) { const o = document.createElement('option'); o.value = p.id; o.textContent = p.label; ps.appendChild(o); }
}
function setCvTool(t) {
  if (S.cvPen && t !== 'pen') cvPenFinish(false);
  S.cvTool = t; if (S.space !== 'curves') setSpace('curves');
  const d = CV_TOOLS.find((x) => x.id === t); hint(d.label + ' — ' + d.hint);
  canvas.style.cursor = t === 'edit' ? 'default' : 'none';
  refreshUI(); req();
}
const wMin = () => sR() * 0.002, wMax = () => sR() * 1.5;
const toW = (v) => wMin() * Math.pow(wMax() / wMin(), v / 1000);
const fromW = (x) => Math.max(0, Math.min(1000, Math.round(1000 * Math.log(Math.max(x, wMin()) / wMin()) / Math.log(wMax() / wMin()))));
const fmtW = (x) => (x === 0 ? '0' : x < 0.01 ? x.toFixed(4) : x < 0.1 ? x.toFixed(3) : x.toFixed(2));
const CV_SLIDERS = [
  ['cvThick', 'thickness', toW, fromW, fmtW],
  ['cvBevel', 'bevel', (v) => (v <= 0 ? 0 : toW(v)), (x) => (x <= 0 ? 0 : fromW(x)), fmtW],
  ['cvInflate', 'inflate', (v) => v / 100, (x) => Math.round(x * 100), (x) => Math.round(x * 100) + ' %'],
  ['cvRes', 'res', (v) => v, (x) => x, (x) => String(x)],
  ['cvRadius', 'radius', toW, fromW, fmtW],
  ['cvSides', 'sides', (v) => v, (x) => x, (x) => String(x)],
  ['cvAspect', 'aspect', (v) => Math.pow(2, v / 50), (x) => Math.round(50 * Math.log2(x)), (x) => '×' + x.toFixed(2)],
  ['cvTaperS', 'taperStart', (v) => v / 100, (x) => Math.round(x * 100), (x) => Math.round(x * 100) + ' %'],
  ['cvTaperE', 'taperEnd', (v) => v / 100, (x) => Math.round(x * 100), (x) => Math.round(x * 100) + ' %'],
  ['cvTwist', 'twist', (v) => v, (x) => x, (x) => x + '°'],
  ['cvRotate', 'rotate', (v) => v, (x) => x, (x) => x + '°'],
  ['cvDensity', 'density', (v) => Math.pow(2, v / 100), (x) => Math.round(100 * Math.log2(x)), (x) => '×' + x.toFixed(2)],
];
function setCvParam(key, val, commit) {
  const c = cvSel(); cvDefaults(); S.cvDef[key] = val;
  if (c) {
    if (!cvParamBefore) cvParamBefore = cvSnap();
    c.params[key] = val; cvLinesCache = null; scheduleGhost();
    if (commit) { cvCommit('réglage de ' + c.name, cvParamBefore); cvParamBefore = null; }
  }
  drawProfilePreview(); req();
}
function bindCurvesUI() {
  const on = (id, fn) => $(id).addEventListener('click', fn);
  on('spaceCurves', () => setSpace('curves'));
  on('gpToCurves', gpToCurves);
  for (const [id, key, to, , fmt] of CV_SLIDERS) {
    const el = $(id), out = $(id + 'Out');
    el.addEventListener('input', () => { const v = to(+el.value); out.textContent = fmt(v); setCvParam(key, v, false); });
    el.addEventListener('change', () => setCvParam(key, to(+el.value), true));
  }
  $('cvAnchor').addEventListener('change', (e) => setCvParam('anchor', e.target.value, true));
  $('cvCaps').addEventListener('change', (e) => setCvParam('caps', e.target.checked, true));
  $('cvProfile').addEventListener('change', (e) => {
    setCvParam('profile', e.target.value, false);
    if (e.target.value === 'shape') { const sh = S.curves.find((c) => c.kind === 'shape'); if (sh && !S.curves.some((c) => c.id === (cvSel() || S.cvDef).profileRef)) setCvParam('profileRef', sh.id, false); }
    setCvParam('profile', e.target.value, true); refreshCurveUI();
  });
  $('cvProfileRef').addEventListener('change', (e) => setCvParam('profileRef', +e.target.value, true));
  $('cvKind').addEventListener('change', (e) => {
    const c = cvSel(); if (!c) return;
    const kind = e.target.value;
    cvEdit(kind === 'shape' ? 'convertir en forme' : 'convertir en courbe', () => {
      if (kind === 'shape') {
        const pts = []; for (const A of c.pts) pts.push(A.p, A.i, A.o);
        c.plane = c.plane || Curves.fitPlane(pts, c.up || cam.basis().b); c.kind = 'shape'; c.closed = true; Curves.flattenToPlane(c);
      } else { c.kind = 'sweep'; if (c.plane) c.up = c.plane.n.slice(); }
    });
  });
  on('cvClose', () => { const c = cvSel(); if (c) cvEdit(c.closed ? 'ouvrir la courbe' : 'fermer la courbe', () => Curves.setClosed(c, !c.closed)); });
  on('cvDup', () => {
    const c = cvSel(); if (!c) return;
    cvEdit('dupliquer ' + c.name, () => {
      const d = Curves.clone(c); d.id = Curves.makeCurve('sweep', [], false).id; d.name = nextName(c.kind === 'shape' ? 'Forme' : 'Courbe');
      Curves.translate(d, V.scale(cam.basis().r, sR() * 0.15)); S.curves.push(d); S.cvSel = { id: d.id, a: -1 };
    });
  });
  on('cvDel', () => { const c = cvSel(); if (c) { S.cvSel.a = -1; cvDeleteSelection(); } });
  on('cvSmooth', () => { const c = cvSel(); if (c && S.cvSel.a >= 0) cvEdit('point lisse / angle', () => Curves.setSmooth(c, S.cvSel.a, !c.pts[S.cvSel.a].smooth)); else toast('Sélectionnez d’abord un point avec l’outil Éditer.'); });
  on('cvDelPt', () => { if (S.cvSel.a >= 0) cvDeleteSelection(); else toast('Sélectionnez d’abord un point avec l’outil Éditer.'); });
  $('cvGhost').addEventListener('change', (e) => { S.cvOpt.ghost = e.target.checked; if (e.target.checked) scheduleGhost(true); else dropGhost(); });
  $('cvKeep').addEventListener('change', (e) => { S.cvOpt.keep = e.target.checked; });
  on('cvBake', () => cvBake(false)); on('cvBakeAll', () => cvBake(true));
}
function drawProfilePreview() {
  const cv = $('cvProfileCv'); if (!cv || !cv.offsetParent) return;
  const g = cv.getContext('2d'), w = cv.width, h = cv.height; g.clearRect(0, 0, w, h);
  const p = cvSel() ? cvSel().params : cvDefaults();
  const ref = p.profile === 'shape' ? S.curves.find((c) => c.id === p.profileRef && c.kind === 'shape') : null;
  const poly = Curves.profilePoly(p.profile, p.sides, ref);
  const ax = p.aspect || 1, s = Math.min((w - 16) / (2 * Math.max(ax, 1)), (h - 12) / 2) * (ax >= 1 ? 1 : 1);
  g.beginPath(); poly.forEach(([x, y], i) => { const X = w / 2 + x * s * ax, Y = h / 2 - y * s; if (i) g.lineTo(X, Y); else g.moveTo(X, Y); }); g.closePath();
  g.fillStyle = 'rgba(127,178,229,.25)'; g.fill(); g.strokeStyle = '#7fb2e5'; g.lineWidth = 1.5; g.stroke();
  g.fillStyle = '#ebe5dc'; for (const [x, y] of poly) { g.beginPath(); g.arc(w / 2 + x * s * ax, h / 2 - y * s, 1.6, 0, Math.PI * 2); g.fill(); }
}
function refreshCurveUI() {
  const list = $('cvList'); if (!list) return;
  list.innerHTML = '';
  if (!S.curves.length) { const p = document.createElement('p'); p.className = 'note'; p.textContent = 'Aucune courbe. Outils Forme (1), Courbe (2) ou Plume (3) pour commencer.'; list.appendChild(p); }
  for (const c of S.curves) {
    const row = document.createElement('div'); row.className = 'cv' + (c.id === S.cvSel.id ? ' on' : '');
    const eye = document.createElement('button'); eye.className = 'eye' + (c.visible ? '' : ' off'); eye.textContent = c.visible ? '◉' : '○'; eye.title = c.visible ? 'Masquer' : 'Afficher';
    eye.addEventListener('click', (ev) => { ev.stopPropagation(); cvEdit(c.visible ? 'masquer la courbe' : 'afficher la courbe', () => { c.visible = !c.visible; }); });
    const kind = document.createElement('span'); kind.className = 'kind'; kind.textContent = c.kind === 'shape' ? 'SOL' : 'CYL'; kind.title = c.kind === 'shape' ? 'Forme → solide à plat' : 'Courbe → cylindre extrudé';
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = c.name;
    nm.addEventListener('dblclick', () => {
      const inp = document.createElement('input'); inp.className = 'nm'; inp.type = 'text'; inp.value = c.name; inp.id = 'cvname-' + c.id;
      nm.replaceWith(inp); inp.focus(); inp.select();
      const done = () => { const v = inp.value.trim(); if (v && v !== c.name) cvEdit('renommer', () => { c.name = v; }); else refreshCurveUI(); };
      inp.addEventListener('blur', done); inp.addEventListener('keydown', (k) => { if (k.key === 'Enter') inp.blur(); if (k.key === 'Escape') { inp.value = c.name; inp.blur(); } });
    });
    const cnt = document.createElement('span'); cnt.className = 'cnt'; cnt.textContent = c.pts.length + ' pts';
    row.append(eye, kind, nm, cnt);
    row.addEventListener('click', () => { if (S.cvSel.id !== c.id) { S.cvSel = { id: c.id, a: -1 }; cvChanged(true); } });
    list.appendChild(row);
  }
  const c = cvSel(), p = c ? c.params : cvDefaults();
  $('cvKind').disabled = !c; $('cvKind').value = c ? c.kind : 'shape';
  for (const id of ['cvClose', 'cvDup', 'cvDel', 'cvBake']) $(id).disabled = !c;
  $('cvSmooth').disabled = $('cvDelPt').disabled = !c || S.cvSel.a < 0;
  $('cvClose').textContent = c && c.closed ? 'Ouvrir' : 'Fermer';
  $('cvShapePal').hidden = !!c && c.kind !== 'shape';
  $('cvSweepPal').hidden = !!c && c.kind !== 'sweep';
  for (const [id, key, , from, fmt] of CV_SLIDERS) { $(id).value = from(p[key]); $(id + 'Out').textContent = fmt(p[key]); }
  $('cvAnchor').value = p.anchor; $('cvCaps').checked = p.caps !== false; $('cvProfile').value = p.profile;
  const shapes = S.curves.filter((q) => q.kind === 'shape' && q !== c);
  const rs = $('cvProfileRef'); rs.innerHTML = '';
  for (const q of shapes) { const o = document.createElement('option'); o.value = q.id; o.textContent = q.name; rs.appendChild(o); }
  if (!shapes.length) { const o = document.createElement('option'); o.value = 0; o.textContent = 'Dessinez d’abord une forme'; rs.appendChild(o); }
  rs.value = String(p.profileRef || (shapes[0] ? shapes[0].id : 0));
  $('cvRefRow').hidden = p.profile !== 'shape';
  drawProfilePreview();
}

// ------------------------------------------------------------ Modèles paramétriques
const LIB = { cat: 'bijoux', id: 'chevaliere', values: {}, preview: [], timer: 0, savedCam: null, framed: false, seq: 0 };
const libSample = () => Samples.CATALOG.find((s) => s.id === LIB.id);
const libValues = () => (LIB.values[LIB.id] || (LIB.values[LIB.id] = Samples.defaults(LIB.id)));
const textCache = new Map();
// Champ signé 2D d'un texte (gras à empattements), rendu sur un canvas puis transformé par distance euclidienne
function textSDF(text, w, h, mirror) {
  const key = text + '|' + w.toFixed(3) + '|' + h.toFixed(3) + '|' + mirror;
  if (textCache.has(key)) return textCache.get(key);
  const R = 220, Rx = Math.max(16, Math.round(R * Math.min(1, w / h))), Rz = Math.max(16, Math.round(R * Math.min(1, h / w)));
  const cv = document.createElement('canvas'); cv.width = Rx; cv.height = Rz;
  const g = cv.getContext('2d', { willReadFrequently: true });
  const font = (px) => '700 ' + px + 'px Georgia, "Times New Roman", serif';
  g.font = font(100); const mw = Math.max(1, g.measureText(text).width);
  const fs = Math.min(Rz * 0.82, (Rx * 0.92 * 100) / mw);
  g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = font(fs);
  if (mirror) { g.translate(Rx, 0); g.scale(-1, 1); }
  g.fillText(text, Rx / 2, Rz / 2 + fs * 0.06);
  const img = g.getImageData(0, 0, Rx, Rz).data, inside = new Uint8Array(Rx * Rz), out = new Uint8Array(Rx * Rz);
  let any = 0;
  for (let i = 0; i < inside.length; i++) { inside[i] = img[4 * i + 3] > 127 ? 1 : 0; out[i] = 1 - inside[i]; any += inside[i]; }
  if (!any) { textCache.set(key, null); return null; }
  const dIn = Curves.edt2d(out, Rx, Rz), dOut = Curves.edt2d(inside, Rx, Rz), cell = w / Rx;
  const F = new Float32Array(Rx * Rz);
  for (let i = 0; i < F.length; i++) F[i] = (inside[i] ? -(dIn[i] - 0.5) : dOut[i] - 0.5) * cell;
  const fn = (x, z) => {
    let u = x / cell + Rx / 2 - 0.5, v = z / cell + Rz / 2 - 0.5;
    let extra = 0;
    if (u < 0 || v < 0 || u > Rx - 1 || v > Rz - 1) { const cu = Math.max(0, Math.min(Rx - 1, u)), cvv = Math.max(0, Math.min(Rz - 1, v)); extra = Math.hypot(u - cu, v - cvv) * cell; u = cu; v = cvv; }
    const i0 = Math.min(Rx - 2, Math.floor(u)), j0 = Math.min(Rz - 2, Math.floor(v)), fu = u - i0, fv = v - j0;
    const a = F[j0 * Rx + i0], b = F[j0 * Rx + i0 + 1], c = F[(j0 + 1) * Rx + i0], d = F[(j0 + 1) * Rx + i0 + 1];
    return (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + d * fu) * fv + extra;
  };
  if (textCache.size > 24) textCache.clear();
  textCache.set(key, fn); return fn;
}
function libLevel(pt) { return Core.makeLevel(pt.mesh.pos, pt.mesh.idx, pt.mesh.nv, { groups: pt.mesh.groups, qflags: pt.mesh.qflags }); }
function dropLibPreview() { for (const L of LIB.preview) releaseLevel(L); LIB.preview = []; req(); }
function scheduleLibPreview(delay = 220) {
  clearTimeout(LIB.timer);
  $('libStatus').classList.remove('err'); $('libStatus').textContent = 'Calcul de l’aperçu…';
  LIB.timer = setTimeout(buildLibPreview, delay);
}
function buildLibPreview() {
  if (S.space !== 'lib') return;
  const seq = ++LIB.seq, t0 = performance.now();
  let parts;
  try { parts = Samples.build(LIB.id, libValues(), { preview: true, previewRes: isAndroid ? 56 : 72, textSDF }); }
  catch (e) { console.error(e); $('libStatus').classList.add('err'); $('libStatus').textContent = e.message; return; }
  if (seq !== LIB.seq || S.space !== 'lib') return;
  dropLibPreview();
  LIB.preview = parts.map((pt) => { const L = libLevel(pt); L.name = pt.name; return L; });
  const faces = LIB.preview.reduce((n, L) => n + L.nt, 0);
  $('libStatus').textContent = 'Aperçu : ' + parts.length + ' pièce' + (parts.length > 1 ? 's' : '') + ' (' + parts.map((p) => p.name).join(', ') + ') · ' + fmtN(faces) + ' faces · ' + Math.round(performance.now() - t0) + ' ms';
  if (!LIB.framed) {
    const front = LIB.id === 'collier' || LIB.id === 'boucle';
    cam.q = front ? Q.norm(Q.axis([0, 1, 0], -0.25)) : Q.norm(Q.mul(Q.axis([0, 1, 0], -0.62), Q.axis([1, 0, 0], -0.38)));
    frameLib(); LIB.framed = true;
  }
  req();
}
function frameLib() {
  if (!LIB.preview.length) return;
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const L of LIB.preview) for (let i = 0; i < L.pos.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], L.pos[i + k]); mx[k] = Math.max(mx[k], L.pos[i + k]); }
  cam.frame(mn, mx); sceneRadius = Math.max(1e-3, V.len(V.sub(mx, mn)) / 2) + V.len(V.scale(V.add(mn, mx), 0.5)); req();
}
function selectSample(id) {
  if (LIB.id === id && LIB.preview.length) return;
  LIB.id = id; LIB.framed = false; buildLibForm(); refreshLibList(); scheduleLibPreview(0);
}
function fmtParam(q, v) {
  if (q.fmt) return q.fmt(v);
  const dec = q.step >= 1 ? 0 : q.step >= 0.1 ? 1 : q.step >= 0.01 ? 2 : 3;
  return Number(v).toFixed(dec).replace('.', ',') + (q.unit ? (q.unit === '°' ? '°' : ' ' + q.unit) : '');
}
function buildLibForm() {
  const s = libSample(), v = libValues(), form = $('libForm');
  $('libTitle').innerHTML = ''; $('libTitle').append(s.name, Object.assign(document.createElement('span'), { className: 'unit-chip', textContent: s.unit }));
  $('libDesc').textContent = s.desc;
  form.innerHTML = '';
  for (const q of s.params) {
    const id = 'lib-' + s.id + '-' + q.key;
    let row;
    if (q.type === 'range') {
      row = document.createElement('div'); row.className = 'slider';
      const lab = Object.assign(document.createElement('label'), { htmlFor: id, textContent: q.label });
      const inp = Object.assign(document.createElement('input'), { type: 'range', id, min: q.min, max: q.max, step: q.step, value: v[q.key] });
      const out = Object.assign(document.createElement('output'), { textContent: fmtParam(q, v[q.key]) });
      inp.addEventListener('input', () => { v[q.key] = +inp.value; out.textContent = fmtParam(q, v[q.key]); scheduleLibPreview(q.live ? 60 : 220); });
      row.style.gridTemplateColumns = '104px 1fr 76px';
      row.append(lab, inp, out);
    } else if (q.type === 'select') {
      row = document.createElement('div'); row.className = 'field';
      const lab = Object.assign(document.createElement('label'), { htmlFor: id, textContent: q.label });
      const sel = Object.assign(document.createElement('select'), { id, className: 'btn' });
      for (const [val, txt] of q.options) sel.append(Object.assign(document.createElement('option'), { value: val, textContent: txt }));
      sel.value = v[q.key];
      sel.addEventListener('change', () => { v[q.key] = sel.value; refreshLibVisibility(); scheduleLibPreview(60); });
      row.append(lab, sel);
    } else if (q.type === 'check') {
      row = document.createElement('label'); row.className = 'check';
      const inp = Object.assign(document.createElement('input'), { type: 'checkbox', id, checked: !!v[q.key] });
      inp.addEventListener('change', () => { v[q.key] = inp.checked; refreshLibVisibility(); scheduleLibPreview(60); });
      row.append(inp, ' ' + q.label);
    } else {
      row = document.createElement('div'); row.className = 'field';
      const lab = Object.assign(document.createElement('label'), { htmlFor: id, textContent: q.label });
      const inp = Object.assign(document.createElement('input'), { type: 'text', id, value: v[q.key], maxLength: q.max || 8, spellcheck: false, autocomplete: 'off' });
      inp.addEventListener('input', () => { v[q.key] = inp.value; scheduleLibPreview(350); });
      row.append(lab, inp);
    }
    row.dataset.key = q.key;
    form.appendChild(row);
  }
  refreshLibVisibility();
}
function refreshLibVisibility() {
  const s = libSample(), v = libValues();
  $('libZsRow').hidden = !(typeof s.zs === 'function' ? s.zs(v) : s.zs && v.mode !== 'volume');
  for (const q of s.params) { const row = $('libForm').querySelector('[data-key="' + q.key + '"]'); if (row) row.hidden = q.show ? !q.show(v) : false; }
}
function refreshLibList() {
  const cat = Samples.CATEGORIES.find((c) => c.id === LIB.cat);
  $('libCatTitle').textContent = cat.label;
  const list = $('libList'); list.innerHTML = '';
  for (const s of Samples.CATALOG.filter((x) => x.cat === LIB.cat)) {
    const b = document.createElement('button'); b.className = 'libitem' + (s.id === LIB.id ? ' on' : '');
    b.append(Object.assign(document.createElement('b'), { textContent: s.name }), Object.assign(document.createElement('span'), { textContent: s.desc }));
    b.addEventListener('click', () => selectSample(s.id));
    list.appendChild(b);
  }
  document.querySelectorAll('[data-libcat]').forEach((el) => el.classList.toggle('on', el.dataset.libcat === LIB.cat));
}
function setLibCat(cat) {
  LIB.cat = cat; refreshLibList();
  if (libSample().cat !== cat) selectSample(Samples.CATALOG.find((x) => x.cat === cat).id);
}
function libCreate(replace) {
  const s = libSample();
  run('Création : ' + s.name + '…', () => {
    const parts = Samples.build(LIB.id, libValues(), { preview: false, textSDF });
    if (!parts.length) throw new Error('Ce réglage ne produit aucune pièce.');
    const before = snapScene();
    const sts = parts.map((pt) => Core.makeSubtool(pt.name, libLevel(pt)));
    if (replace) { for (const st of S.subtools) for (const L of st.levels) releaseLevel(L); S.subtools = sts; S.active = 0; S.cvDef = null; }
    else { S.subtools.push(...sts); S.active = S.subtools.length - sts.length; }
    pushUndo({ type: 'scene', label: s.name, before, after: snapScene() });
    LIB.created = true;
    const faces = sts.reduce((n, st) => n + Core.curLevel(st).nt, 0);
    setSpace('sculpt'); frameAll();
    toast(s.name + ' créé' + (s.name.endsWith('e') && !s.name.endsWith('re') ? 'e' : '') + ' : ' + sts.length + ' SubTool' + (sts.length > 1 ? 's' : '') + ', ' + fmtN(faces) + ' faces. Ctrl+Z pour revenir.');
  });
}
function buildLibUI() {
  const wrap = $('libCats');
  for (const c of Samples.CATEGORIES) {
    const el = document.createElement('button'); el.className = 'brush'; el.dataset.libcat = c.id; el.title = c.label + ' (' + c.unit + ')';
    el.innerHTML = '<span class="code">' + c.code + '</span><span class="key">' + c.unit + '</span>';
    el.addEventListener('click', () => setLibCat(c.id));
    wrap.appendChild(el);
  }
  $('spaceLib').addEventListener('click', () => setSpace('lib'));
  $('libReset').addEventListener('click', () => { LIB.values[LIB.id] = Samples.defaults(LIB.id); buildLibForm(); scheduleLibPreview(0); });
  $('libFrame').addEventListener('click', frameLib);
  $('libNew').addEventListener('click', () => libCreate(true));
  $('libAdd').addEventListener('click', () => libCreate(false));
  refreshLibList(); buildLibForm();
}

// ------------------------------------------------------------ ZSpheres
const ZS_TOOLS = [
  { id: 'add', code: 'Aj', key: '1', label: 'Ajouter', hint: 'Glisser depuis une sphère crée un enfant ; cliquer sur un lien insère une sphère' },
  { id: 'move', code: 'Dp', key: '2', label: 'Déplacer', hint: 'Glisser une sphère pour la déplacer' },
  { id: 'scale', code: 'Éc', key: '3', label: 'Échelle', hint: 'Glisser verticalement sur une sphère pour changer son rayon' },
  { id: 'del', code: 'Su', key: '4', label: 'Supprimer', hint: 'Toucher une sphère pour la retirer (ses enfants sont rattachés au parent)' },
];
const ZS = { nodes: [], sel: -1, tool: 'add', sym: true, skin: false, subdiv: 3, density: 1, level: null, skinLevel: null, timer: 0, savedCam: null, framed: false };
let sphereTpl = null;
const zsSnap = () => ({ nodes: ZS.nodes.map((n) => ({ ...n, p: n.p.slice() })), sel: ZS.sel });
function zsRestore(s) { ZS.nodes = s.nodes.map((n) => ({ ...n, p: n.p.slice() })); ZS.sel = s.sel; zsChanged(true); }
function zsLoadTemplate(t) {
  let nodes;
  if (t === 'sphere') nodes = [{ p: [0, 0, 0], r: 1, parent: -1, part: 0 }];
  else if (t === 'humanoide') nodes = Samples.skeleton('humanoide', LIB.values.humanoide || {});
  else nodes = Samples.skeleton('animal', Object.assign({}, LIB.values.animal || {}, { espece: t, mode: 'zspheres' }));
  ZS.nodes = nodes.map((n) => ({ p: n.p.slice(), r: n.r, parent: n.parent, part: n.part || 0 })); ZS.sel = -1; ZS.framed = false;
  zsChanged(true);
}
function zsMirror(i) {
  const n = ZS.nodes[i]; if (!n) return -1;
  const tol = Math.max(1e-4, n.r * 0.05);
  if (Math.abs(n.p[0]) < tol) return i;
  let best = -1, bd = Infinity;
  ZS.nodes.forEach((m, j) => { if (j === i || Math.sign(m.p[0]) === Math.sign(n.p[0])) return; const d = Math.hypot(m.p[0] + n.p[0], m.p[1] - n.p[1], m.p[2] - n.p[2]); if (d < bd) { bd = d; best = j; } });
  return bd < Math.max(n.r * 0.5, 1e-3) ? best : -1;
}
function zsRemove(ids) {
  const del = new Set(ids), map = new Map(); const out = [];
  // les enfants d'un nœud supprimé sont rattachés à son parent
  const parentOf = (i) => { let p = ZS.nodes[i].parent; while (p >= 0 && del.has(p)) p = ZS.nodes[p].parent; return p; };
  ZS.nodes.forEach((n, i) => { if (!del.has(i)) { map.set(i, out.length); out.push({ ...n, p: n.p.slice() }); } });
  out.forEach((n, k) => { const orig = [...map.entries()].find(([, v]) => v === k)[0]; const p = parentOf(orig); n.parent = p >= 0 ? map.get(p) : -1; });
  if (!out.some((n) => n.parent < 0) && out.length) out[0].parent = -1;
  ZS.nodes = out; ZS.sel = -1;
}
function buildSphereLevel() {
  if (!sphereTpl) sphereTpl = Core.icosphere(2);
  const T = sphereTpl, links = [];
  ZS.nodes.forEach((n, i) => { if (n.parent >= 0) { const p = ZS.nodes[n.parent]; links.push(SDF.cylinderMesh(p.p, n.p, Math.min(n.r, p.r) * 0.16, 10)); } });
  const nvS = ZS.nodes.length * T.nv, ntS = ZS.nodes.length * T.idx.length / 3;
  let nv = nvS, nt = ntS; for (const l of links) { nv += l.nv; nt += l.idx.length / 3; }
  const pos = new Float32Array(nv * 3), idx = new Uint32Array(nt * 3), col = new Uint8Array(nv * 4);
  let ov = 0, oi = 0;
  ZS.nodes.forEach((n, i) => {
    const c = i === ZS.sel ? [240, 196, 90] : n.parent < 0 ? [190, 120, 200] : [196, 74, 52];
    for (let v = 0; v < T.nv; v++) { pos.set([n.p[0] + T.pos[3 * v] * n.r, n.p[1] + T.pos[3 * v + 1] * n.r, n.p[2] + T.pos[3 * v + 2] * n.r], 3 * (ov + v)); col.set([...c, 255], 4 * (ov + v)); }
    for (let k = 0; k < T.idx.length; k++) idx[oi + k] = T.idx[k] + ov;
    ov += T.nv; oi += T.idx.length;
  });
  for (const l of links) {
    pos.set(l.pos.subarray(0, l.nv * 3), 3 * ov); for (let v = 0; v < l.nv; v++) col.set([150, 145, 138, 255], 4 * (ov + v));
    for (let k = 0; k < l.idx.length; k++) idx[oi + k] = l.idx[k] + ov;
    ov += l.nv; oi += l.idx.length;
  }
  return Core.makeLevel(pos, idx, nv, { col });
}
function zsChanged(full) {
  if (ZS.level) releaseLevel(ZS.level);
  ZS.level = ZS.nodes.length ? buildSphereLevel() : null;
  $('zsStatus').textContent = ZS.nodes.length + ' sphère' + (ZS.nodes.length > 1 ? 's' : '') + (ZS.sel >= 0 ? ' · sélection n° ' + ZS.sel : '');
  refreshZsRadius();
  if (ZS.skin) { clearTimeout(ZS.timer); ZS.timer = setTimeout(buildSkinPreview, full ? 0 : 120); }
  if (!ZS.framed && ZS.nodes.length && S.space === 'zs') { cam.q = Q.norm(Q.mul(Q.axis([0, 1, 0], -0.45), Q.axis([1, 0, 0], -0.15))); frameZS(); ZS.framed = true; }
  req();
}
function buildSkinPreview() {
  if (ZS.skinLevel) { releaseLevel(ZS.skinLevel); ZS.skinLevel = null; }
  if (!ZS.skin || !ZS.nodes.length) return req();
  try {
    const m = Surface.skinZSpheres(ZS.nodes, Math.min(ZS.subdiv, 2), { density: ZS.density });
    ZS.skinLevel = Core.makeLevel(m.pos, m.idx, m.nv, { groups: m.groups, qflags: m.qflags });
    $('zsStatus').classList.remove('err');
  } catch (e) { $('zsStatus').classList.add('err'); $('zsStatus').textContent = e.message; }
  req();
}
function frameZS() {
  if (!ZS.nodes.length) return;
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const n of ZS.nodes) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], n.p[k] - n.r); mx[k] = Math.max(mx[k], n.p[k] + n.r); }
  cam.frame(mn, mx); sceneRadius = Math.max(1e-3, V.len(V.sub(mx, mn)) / 2) + V.len(V.scale(V.add(mn, mx), 0.5)); req();
}
function zsPick(x, y) {
  const r = cam.ray(x, y); let best = null;
  ZS.nodes.forEach((n, i) => {
    const oc = V.sub(r.o, n.p), b = V.dot(oc, r.d), c = V.dot(oc, oc) - n.r * n.r, h = b * b - c;
    if (h < 0) return; const t = -b - Math.sqrt(h);
    if (t > 0 && (!best || t < best.t)) best = { i, t, p: V.add(r.o, V.scale(r.d, t)) };
  });
  return best;
}
function zsPickLink(x, y) {
  const r = cam.ray(x, y); let best = null;
  ZS.nodes.forEach((n, i) => {
    if (n.parent < 0) return; const a = ZS.nodes[n.parent].p, b = n.p, u = V.sub(b, a), L = V.len(u); if (L < 1e-9) return;
    const ud = V.scale(u, 1 / L), w = V.sub(r.o, a), bb = V.dot(r.d, ud), d = V.dot(r.d, w), e = V.dot(ud, w), den = 1 - bb * bb;
    if (den < 1e-9) return;
    const sc = Math.max(0, Math.min(L, (e - bb * d) / den)), tc = (bb * sc - d);
    const P = V.add(a, V.scale(ud, sc)), Q = V.add(r.o, V.scale(r.d, tc));
    const dist = V.len(V.sub(P, Q)), lim = Math.min(n.r, ZS.nodes[n.parent].r) * 0.6;
    if (tc > 0 && dist < lim && sc > 0.15 * L && sc < 0.85 * L && (!best || tc < best.t)) best = { child: i, f: sc / L, p: P, t: tc };
  });
  return best;
}
function viewPlanePoint(x, y, through) { const n = cam.basis().b, r = cam.ray(x, y), dn = V.dot(r.d, n); if (Math.abs(dn) < 1e-6) return null; const t = V.dot(V.sub(through, r.o), n) / dn; return t > 0 ? V.add(r.o, V.scale(r.d, t)) : null; }
function zsDown(e, x, y) {
  if (ZS.skin) { drag = { kind: 'bg', start: [x, y], last: [x, y], moved: false }; hint('Aperçu de la peau : A pour revenir aux sphères et les éditer.'); return; }
  const tool = e.altKey ? 'del' : ZS.tool, hit = zsPick(x, y), before = zsSnap();
  if (!hit) {
    const lk = tool === 'add' ? zsPickLink(x, y) : null;
    if (lk) {
      const ins = (child, f) => { const c = ZS.nodes[child], par = c.parent, P = ZS.nodes[par]; ZS.nodes.push({ p: V.add(P.p, V.scale(V.sub(c.p, P.p), f)), r: P.r + (c.r - P.r) * f, parent: par, part: c.part }); c.parent = ZS.nodes.length - 1; return ZS.nodes.length - 1; };
      const m = ZS.sym ? zsMirror(lk.child) : -1;
      ZS.sel = ins(lk.child, lk.f); if (m >= 0 && m !== lk.child) ins(m, lk.f);
      pushUndo({ type: 'zs', label: 'insérer une sphère', before, after: zsSnap() }); zsChanged(); drag = { kind: 'none' }; return;
    }
    drag = { kind: 'bg', start: [x, y], last: [x, y], moved: false }; return;
  }
  const i = hit.i; ZS.sel = i;
  if (tool === 'del') {
    if (ZS.nodes[i].parent < 0) { toast('La sphère racine ne peut pas être supprimée.'); drag = { kind: 'none' }; return; }
    const m = ZS.sym ? zsMirror(i) : -1; zsRemove(m >= 0 && m !== i ? [i, m] : [i]);
    pushUndo({ type: 'zs', label: 'supprimer une sphère', before, after: zsSnap() }); zsChanged(); drag = { kind: 'none' }; return;
  }
  if (tool === 'add') {
    const n = ZS.nodes[i], m = ZS.sym ? zsMirror(i) : -1;
    ZS.nodes.push({ p: hit.p.slice(), r: n.r * 0.75, parent: i, part: n.part }); const c = ZS.nodes.length - 1;
    let cm = -1;
    if (ZS.sym && Math.abs(hit.p[0]) > n.r * 0.05) { const mp = m >= 0 ? m : i; ZS.nodes.push({ p: [-hit.p[0], hit.p[1], hit.p[2]], r: n.r * 0.75, parent: mp, part: n.part }); cm = ZS.nodes.length - 1; }
    ZS.sel = c; drag = { kind: 'zsMove', i: c, m: cm, plane: hit.p.slice(), before, label: 'ajouter une sphère', moved: true };
    zsChanged(); return;
  }
  const m = ZS.sym ? zsMirror(i) : -1;
  drag = { kind: tool === 'scale' ? 'zsScale' : 'zsMove', i, m: m === i ? -1 : m, onAxis: m === i, plane: ZS.nodes[i].p.slice(), r0: ZS.nodes[i].r, y0: y, before, label: tool === 'scale' ? 'rayon d’une sphère' : 'déplacer une sphère', moved: false };
  zsChanged();
}
function zsDrag(x, y) {
  const d = drag, n = ZS.nodes[d.i]; if (!n) return;
  if (d.kind === 'zsScale') {
    const r = Math.max(1e-4, d.r0 * Math.exp(-(y - d.y0) * 0.008));
    n.r = r; if (d.m >= 0) ZS.nodes[d.m].r = r;
  } else {
    const q = viewPlanePoint(x, y, d.plane); if (!q) return;
    if (d.onAxis) q[0] = 0;
    n.p = q; if (d.m >= 0) ZS.nodes[d.m].p = [-q[0], q[1], q[2]];
  }
  d.moved = true; zsChanged();
}
function zsEnd() {
  const d = drag; drag = null;
  if (d.moved) pushUndo({ type: 'zs', label: d.label, before: d.before, after: zsSnap() });
}
function zsCreate(replace) {
  if (!ZS.nodes.length) { toast('Chargez d’abord un départ.'); return; }
  run('Peau adaptative…', () => {
    const m = Surface.skinZSpheres(ZS.nodes, ZS.subdiv, { density: ZS.density });
    const before = snapScene();
    const st = Core.makeSubtool('ZSpheres', Core.makeLevel(m.pos, m.idx, m.nv, { groups: m.groups, qflags: m.qflags }));
    if (replace) { for (const s0 of S.subtools) for (const L of s0.levels) releaseLevel(L); S.subtools = [st]; S.active = 0; S.cvDef = null; }
    else { S.subtools.push(st); S.active = S.subtools.length - 1; }
    pushUndo({ type: 'scene', label: 'peau de ZSpheres', before, after: snapScene() });
    ZS.created = true; setSpace('sculpt'); frameAll();
    toast('Peau créée : ' + fmtN(m.idx.length / 6) + ' quads, ' + new Set(m.groups).size + ' polygroupes. Ctrl+Z pour revenir.');
  });
}
function setZsTool(t) { ZS.tool = t; if (S.space !== 'zs') setSpace('zs'); const d = ZS_TOOLS.find((x) => x.id === t); hint(d.label + ' — ' + d.hint); refreshUI(); }
function setZsSkin(on) { ZS.skin = on; $('zsSkin').checked = on; if (on) buildSkinPreview(); else { if (ZS.skinLevel) releaseLevel(ZS.skinLevel); ZS.skinLevel = null; req(); } }
const zrMin = () => sR() * 0.005, zrMax = () => sR() * 1.2;
function refreshZsRadius() {
  const n = ZS.nodes[ZS.sel], el = $('zsRadius');
  el.disabled = !n; if (!n) { $('zsRadiusOut').textContent = '—'; return; }
  el.value = Math.round(1000 * Math.log(Math.max(n.r, zrMin()) / zrMin()) / Math.log(zrMax() / zrMin()));
  $('zsRadiusOut').textContent = n.r < 0.1 ? n.r.toFixed(3) : n.r.toFixed(2);
}
function buildZsUI() {
  const wrap = $('zsTools');
  for (const t of ZS_TOOLS) {
    const el = document.createElement('button'); el.className = 'brush'; el.dataset.zstool = t.id; el.title = t.label + ' — ' + t.hint + ' (' + t.key + ')';
    el.innerHTML = '<span class="code">' + t.code + '</span><span class="key">' + t.key + '</span>';
    el.addEventListener('click', () => setZsTool(t.id)); wrap.appendChild(el);
  }
  $('spaceZS').addEventListener('click', () => setSpace('zs'));
  $('zsLoad').addEventListener('click', () => { const before = zsSnap(); zsLoadTemplate($('zsTemplate').value); pushUndo({ type: 'zs', label: 'charger un départ', before, after: zsSnap() }); });
  $('zsSym').addEventListener('change', (e) => { ZS.sym = e.target.checked; });
  $('zsSkin').addEventListener('change', (e) => setZsSkin(e.target.checked));
  let rBefore = null;
  $('zsRadius').addEventListener('input', (e) => {
    const n = ZS.nodes[ZS.sel]; if (!n) return; if (!rBefore) rBefore = zsSnap();
    const r = zrMin() * Math.pow(zrMax() / zrMin(), +e.target.value / 1000), m = ZS.sym ? zsMirror(ZS.sel) : -1;
    n.r = r; if (m >= 0) ZS.nodes[m].r = r; zsChanged();
  });
  $('zsRadius').addEventListener('change', () => { if (rBefore) pushUndo({ type: 'zs', label: 'rayon d’une sphère', before: rBefore, after: zsSnap() }); rBefore = null; });
  $('zsSubdiv').addEventListener('input', (e) => { ZS.subdiv = +e.target.value; $('zsSubdivOut').textContent = e.target.value; if (ZS.skin) buildSkinPreview(); });
  $('zsDensity').addEventListener('input', (e) => { ZS.density = +e.target.value / 10; $('zsDensityOut').textContent = ZS.density.toFixed(1).replace('.', ','); if (ZS.skin) { clearTimeout(ZS.timer); ZS.timer = setTimeout(buildSkinPreview, 120); } });
  $('zsNew').addEventListener('click', () => zsCreate(true));
  $('zsAdd').addEventListener('click', () => zsCreate(false));
  $('libToZS').addEventListener('click', () => {
    const sk = Samples.skeleton(LIB.id, libValues()); if (!sk) return;
    ZS.nodes = sk.map((n) => ({ p: n.p.slice(), r: n.r, parent: n.parent, part: n.part || 0 })); ZS.sel = -1; ZS.framed = false;
    setSpace('zs'); setZsSkin(false); zsChanged(true);
  });
}

// ------------------------------------------------------------ interface : Dessin 3D et tablette
const GP_TOOLS = [
  { id: 'draw', code: 'Dr', key: '1', label: 'Dessin', hint: 'Trace un trait dans l’espace' },
  { id: 'line', code: 'Li', key: '2', label: 'Ligne', hint: 'Trait droit entre deux points' },
  { id: 'erase', code: 'Gm', key: '3', label: 'Gomme', hint: 'Efface les traits du calque actif' },
  { id: 'cursor', code: '3D', key: '4', label: 'Curseur 3D', hint: 'Place le curseur qui fixe la profondeur des plans' },
];
const GP_SWATCHES = ['#1d1d1f', '#f2efe9', '#d64a34', '#e3a44f', '#4f8fd6', '#5aa469', '#8e5bd0', '#e07bb0'];
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const rgbHex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
function buildGPRail() {
  const wrap = $('gpTools');
  for (const t of GP_TOOLS) {
    const el = document.createElement('button'); el.className = 'brush'; el.dataset.gptool = t.id;
    el.title = t.label + ' — ' + t.hint + ' (' + t.key + ')';
    el.innerHTML = '<span class="code">' + t.code + '</span><span class="key">' + t.key + '</span>';
    el.addEventListener('click', () => setGPTool(t.id));
    wrap.appendChild(el);
  }
  const sw = $('gpSwatches');
  for (const h of GP_SWATCHES) {
    const b = document.createElement('button'); b.className = 'sw'; b.style.background = h; b.dataset.hex = h; b.title = h;
    b.addEventListener('click', () => setGPColor(hexRgb(h)));
    sw.appendChild(b);
  }
}
function setSpace(sp) {
  if (S.space === 'curves' && sp !== 'curves') { if (S.cvPen) cvPenFinish(false); dropGhost(); }
  if (S.space === 'lib' && sp !== 'lib') { clearTimeout(LIB.timer); LIB.seq++; dropLibPreview(); if (!LIB.created && LIB.savedCam) cam.fromJSON(LIB.savedCam); updateBounds(); }
  if (S.space === 'zs' && sp !== 'zs') { clearTimeout(ZS.timer); if (!ZS.created && ZS.savedCam) cam.fromJSON(ZS.savedCam); updateBounds(); }
  if (sp === 'zs' && S.space !== 'zs') { ZS.savedCam = cam.toJSON(); ZS.created = false; if (!ZS.nodes.length) zsLoadTemplate('humanoide'); ZS.framed = false; const d = ZS_TOOLS.find((t) => t.id === ZS.tool); hint(d.label + ' — ' + d.hint); }
  if (sp === 'lib' && S.space !== 'lib') { LIB.savedCam = cam.toJSON(); LIB.created = false; LIB.framed = false; scheduleLibPreview(0); hint('Modèles — réglez les paramètres, puis « Nouvelle scène » ou « Ajouter à la scène ».'); }
  S.space = sp; document.body.dataset.space = sp;
  if (sp === 'gp') { $('gpPal').open = true; hint(GP_TOOLS.find((t) => t.id === S.gpTool).label + ' — ' + GP_TOOLS.find((t) => t.id === S.gpTool).hint); }
  else if (sp === 'curves') { const d = CV_TOOLS.find((t) => t.id === S.cvTool); hint(d.label + ' — ' + d.hint); refreshCurveUI(); scheduleGhost(true); }
  else if (sp !== 'lib' && sp !== 'zs') brushHint();
  if (sp === 'zs') setTimeout(() => { zsChanged(true); }, 0);
  canvas.style.cursor = sp === 'lib' || sp === 'zs' ? 'default' : sp === 'curves' ? (S.cvTool === 'edit' ? 'default' : 'none') : sp === 'gp' || S.mode === 'draw' ? 'none' : 'grab';
  refreshUI(); req();
}
function setGPTool(t) { S.gpTool = t; if (S.space !== 'gp') setSpace('gp'); const d = GP_TOOLS.find((x) => x.id === t); hint(d.label + ' — ' + d.hint); refreshUI(); req(); }
function setGPThick(v) { S.gpOpt.thickness = Math.max(1, Math.min(80, Math.round(v))); $('gpThick').value = S.gpOpt.thickness; $('gpThickOut').textContent = S.gpOpt.thickness; req(); }
function setGPColor(c) { S.gpOpt.color = c; $('gpColor').value = rgbHex(c); refreshUI(); }
function refreshGPLayers() {
  const list = $('gpLayers'); if (!list) return; list.innerHTML = '';
  S.gp.active = Math.min(S.gp.active, S.gp.layers.length - 1);
  // le calque du haut de la liste est le dernier dessiné (comme dans Blender)
  for (let i = S.gp.layers.length - 1; i >= 0; i--) {
    const L = S.gp.layers[i];
    const row = document.createElement('div'); row.className = 'lay' + (i === S.gp.active ? ' on' : '');
    const eye = document.createElement('button'); eye.className = 'eye' + (L.visible ? '' : ' off'); eye.textContent = L.visible ? '◉' : '○'; eye.title = L.visible ? 'Masquer le calque' : 'Afficher le calque';
    eye.addEventListener('click', (ev) => { ev.stopPropagation(); gpEdit(L.visible ? 'masquer le calque' : 'afficher le calque', () => { S.gp.layers[i].visible = !S.gp.layers[i].visible; }); });
    const lock = document.createElement('button'); lock.className = 'eye' + (L.locked ? '' : ' off'); lock.textContent = L.locked ? '⊠' : '□'; lock.title = L.locked ? 'Déverrouiller' : 'Verrouiller';
    lock.addEventListener('click', (ev) => { ev.stopPropagation(); gpEdit(L.locked ? 'déverrouiller' : 'verrouiller', () => { S.gp.layers[i].locked = !S.gp.layers[i].locked; }); });
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = L.name;
    nm.addEventListener('dblclick', () => {
      const inp = document.createElement('input'); inp.className = 'nm'; inp.type = 'text'; inp.value = L.name; inp.id = 'gplayer-' + L.id;
      nm.replaceWith(inp); inp.focus(); inp.select();
      const done = () => { const v = inp.value.trim(); if (v && v !== S.gp.layers[i].name) gpEdit('renommer le calque', () => { S.gp.layers[i].name = v; }); else refreshGPLayers(); };
      inp.addEventListener('blur', done); inp.addEventListener('keydown', (k) => { if (k.key === 'Enter') inp.blur(); if (k.key === 'Escape') { inp.value = L.name; inp.blur(); } });
    });
    const cnt = document.createElement('span'); cnt.className = 'cnt'; cnt.textContent = L.strokes.length;
    row.append(eye, lock, nm, cnt);
    row.addEventListener('click', () => { S.gp.active = i; refreshGPLayers(); });
    list.appendChild(row);
  }
}
function drawCurve(raw) {
  const c = $('curveCv'); if (!c) return; const g = c.getContext('2d'), w = c.width, h = c.height;
  g.clearRect(0, 0, w, h);
  g.strokeStyle = 'rgba(163,155,144,.35)'; g.lineWidth = 1; g.beginPath(); g.moveTo(0, h); g.lineTo(w, 0); g.stroke();
  g.strokeStyle = '#e3a44f'; g.lineWidth = 2; g.beginPath();
  for (let i = 0; i <= 48; i++) { const x = i / 48, y = S.tab.minP + (1 - S.tab.minP) * Math.pow(x, S.tab.curve); if (i) g.lineTo(x * w, h - y * h); else g.moveTo(0, h - y * h); }
  g.stroke();
  if (raw > 0) { const y = S.tab.minP + (1 - S.tab.minP) * Math.pow(raw, S.tab.curve); g.fillStyle = '#ebe5dc'; g.beginPath(); g.arc(raw * w, h - y * h, 4, 0, Math.PI * 2); g.fill(); }
}
function refreshHoldUI() { document.querySelectorAll('[data-hold]').forEach((b) => b.classList.toggle('on', !!S.hold[b.dataset.hold])); req(); }
function bindTabletUI() {
  const on = (id, fn) => $(id).addEventListener('click', fn);
  on('spaceSculpt', () => setSpace('sculpt')); on('spaceGP', () => setSpace('gp'));
  // Dessin 3D
  $('gpThick').addEventListener('input', (e) => setGPThick(+e.target.value));
  $('gpPlace').addEventListener('change', (e) => { S.gpOpt.place = e.target.value; req(); });
  on('gpFrontBtn', () => { S.gpOpt.front = !S.gpOpt.front; refreshUI(); req(); });
  $('gpColor').addEventListener('input', (e) => setGPColor(hexRgb(e.target.value)));
  $('gpPress').addEventListener('change', (e) => { S.gpOpt.pressure = e.target.checked; });
  $('gpStab').addEventListener('input', (e) => { S.gpOpt.stab = +e.target.value / 100; $('gpStabOut').textContent = e.target.value; });
  $('gpSmooth').addEventListener('input', (e) => { S.gpOpt.smooth = +e.target.value; $('gpSmoothOut').textContent = e.target.value; });
  $('gpEraser').addEventListener('input', (e) => { S.gpOpt.eraser = +e.target.value; $('gpEraserOut').textContent = e.target.value; req(); });
  $('gpWhole').addEventListener('change', (e) => { S.gpOpt.eraseWhole = e.target.checked; });
  on('gpAddLayer', () => gpEdit('nouveau calque', () => { S.gp.layers.push(GP.makeLayer('Calque ' + (S.gp.layers.length + 1))); S.gp.active = S.gp.layers.length - 1; }));
  on('gpDelLayer', () => { if (S.gp.layers.length < 2) { toast('Il faut garder au moins un calque.'); return; } gpEdit('supprimer le calque', () => { S.gp.layers.splice(S.gp.active, 1); S.gp.active = Math.max(0, S.gp.active - 1); }); });
  on('gpUpLayer', () => { const i = S.gp.active; if (i < S.gp.layers.length - 1) gpEdit('ordre des calques', () => { const a = S.gp.layers; [a[i], a[i + 1]] = [a[i + 1], a[i]]; S.gp.active = i + 1; }); });
  on('gpDownLayer', () => { const i = S.gp.active; if (i > 0) gpEdit('ordre des calques', () => { const a = S.gp.layers; [a[i], a[i - 1]] = [a[i - 1], a[i]]; S.gp.active = i - 1; }); });
  on('gpClearLayer', () => { if (gpLayer().strokes.length) gpEdit('vider le calque', () => { gpLayer().strokes = []; }); });
  on('gpCursorReset', () => { S.gp.cursor = [0, 0, 0]; req(); });
  on('gpConvert', gpConvert);
  // tablette
  $('tabFinger').addEventListener('change', (e) => { S.tab.fingerNav = e.target.checked; });
  $('tabQuick').addEventListener('change', (e) => { S.tab.quick = e.target.checked; applyTouchUI(); });
  $('tabCurve').addEventListener('input', (e) => { S.tab.curve = +e.target.value / 100; $('tabCurveOut').textContent = S.tab.curve.toFixed(2); drawCurve(0); saveTabletPrefs(); });
  $('tabMin').addEventListener('input', (e) => { S.tab.minP = +e.target.value / 100; $('tabMinOut').textContent = e.target.value + ' %'; drawCurve(0); saveTabletPrefs(); });
  $('tabEraser').addEventListener('change', (e) => { S.tab.eraserEnd = e.target.value; saveTabletPrefs(); });
  $('tabBarrel').addEventListener('change', (e) => { S.tab.barrel = e.target.value; saveTabletPrefs(); });
  $('tabPal').addEventListener('toggle', () => drawCurve(0));
  const fsOk = document.fullscreenEnabled && document.documentElement.requestFullscreen;
  if (!fsOk) $('fullBtn').hidden = true;
  on('fullBtn', async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); }
    catch (e) { toast('Plein écran refusé ici. Installez la version PWA pour un vrai plein écran.', true); }
  });
  // barre rapide : maintenir = actif tant que le doigt reste posé, toucher brièvement = verrouiller
  on('qUndo', undo); on('qRedo', redo);
  document.querySelectorAll('[data-hold]').forEach((b) => {
    const k = b.dataset.hold; let t0 = 0, wasLatched = false;
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); try { b.setPointerCapture(e.pointerId); } catch (_) { /* rien */ } t0 = now(); wasLatched = S.latch[k]; holdUsed[k] = false; S.hold[k] = true; refreshHoldUI(); });
    const up = (e, cancel) => {
      const tap = !cancel && now() - t0 < 300 && !holdUsed[k];
      if (tap) S.latch[k] = !wasLatched;
      S.hold[k] = S.latch[k]; refreshHoldUI();
    };
    b.addEventListener('pointerup', (e) => up(e, false));
    b.addEventListener('pointercancel', (e) => up(e, true));
    b.addEventListener('contextmenu', (e) => e.preventDefault());
  });
}
function applyTouchUI() {
  const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  document.body.classList.toggle('touchui', S.tab.quick || coarse || navigator.maxTouchPoints > 0);
  $('tabQuick').checked = document.body.classList.contains('touchui');
}
function saveTabletPrefs() { try { localStorage.setItem('argile.tab', JSON.stringify(S.tab)); } catch (_) { /* stockage indisponible */ } }
function loadTabletPrefs() {
  try { const t = JSON.parse(localStorage.getItem('argile.tab') || 'null'); if (t) Object.assign(S.tab, t); } catch (_) { /* rien */ }
  $('tabFinger').checked = S.tab.fingerNav; $('tabCurve').value = Math.round(S.tab.curve * 100); $('tabCurveOut').textContent = S.tab.curve.toFixed(2);
  $('tabMin').value = Math.round(S.tab.minP * 100); $('tabMinOut').textContent = Math.round(S.tab.minP * 100) + ' %';
  $('tabEraser').value = S.tab.eraserEnd; $('tabBarrel').value = S.tab.barrel;
}

// ------------------------------------------------------------ démarrage
async function boot() {
  buildRail(); bindUI(); buildGPRail(); bindTabletUI(); loadTabletPrefs(); applyTouchUI(); buildCvRail(); bindCurvesUI(); buildLibUI(); buildZsUI();
  document.body.dataset.space = S.space; refreshGPLayers(); setGPColor(S.gpOpt.color);
  if (!isMac) document.querySelectorAll('kbd').forEach((k) => { k.textContent = k.textContent.replace('⌘', 'Ctrl+'); });
  try {
    renderer = new Renderer();
    await renderer.init(canvas);
    renderer.onLost = (info) => toast('Le GPU a été réinitialisé (' + (info.message || info.reason) + '). Rechargez la page ; la sauvegarde automatique sera restaurée.', true);
  } catch (e) {
    renderer = null;
    const f = document.createElement('div'); f.className = 'fail';
    f.innerHTML = '<div><h2>WebGPU indisponible</h2><p></p><p>Argile a besoin de WebGPU : Safari 26, Chrome ou Edge récents sur macOS.</p></div>';
    f.querySelector('p').textContent = e.message;
    view.appendChild(f); console.error(e);
    return;
  }
  let restored = false;
  try {
    const saved = await IO.autosaveGet();
    if (saved && saved.bytes) { loadProjectBytes(saved.bytes); restored = true; toast('Dernière session restaurée. Fichier > Nouvelle scène pour repartir de zéro.'); }
  } catch (e) { console.warn('restauration impossible', e); }
  if (!restored) { S.subtools = [newSubtool('sphere')]; S.active = 0; cam.q = Q.norm(Q.mul(Q.axis([0, 1, 0], -0.35), Q.axis([1, 0, 0], -0.2))); frameAll(); }
  setSize(S.brush.size); brushHint(); refreshUI(); updateBounds(); req();
  requestAnimationFrame(frame);
  refreshCurveUI();
  window.argile = { S, cam, Core, Sculpt, GP, Curves, Samples, Surface, LIB, ZS, undoStack, textSDF }; // accès console pour le développement
}
boot();
})();
