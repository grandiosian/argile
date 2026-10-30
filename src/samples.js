/* Argile — bibliothèque de modèles paramétriques : bijoux (mm), figures (cm), bâtiments (m).
 * Chaque modèle décrit ses paramètres et construit une ou plusieurs pièces { name, mesh }. */
(function (root) {
'use strict';
const SDF = root.SDF || require('./sdf.js');
const Curves = root.Curves || require('./curves.js');
const Surface = root.Surface || require('./surface.js');
const { clamp, smooth01, smin, smax, node, roundRect2, ellipse2, shape2D, sphere, ellipsoid, box, boxMM, roundCone, capsule, cyl, torus,
  union, inter, sub, xform, rot, mirrorX, scale, meshSDF, ringMesh, cylinderMesh, xformMesh, frameM, rotateMesh, translateMesh, mergeMeshes, mirrorMeshX, meshBounds } = SDF;

const PI = Math.PI, DEG = PI / 180;
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const subv = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const part = (name, mesh) => ({ name, mesh });

// ------------------------------------------------------------ outils bijoux
// Anneau d'axe Z, plus épais et plus large vers le haut (+Y)
function ringBand(ri, tb, tt, wb, wt, rr, top = 0.4) {
  const R = ri + Math.max(tb, tt), W = Math.max(wb, wt) / 2;
  return node((x, y, z) => {
    const r = Math.hypot(x, y) || 1e-9;
    const w = smooth01(((y / r + 1) / 2 - top) / (1 - top));
    const th = tb + (tt - tb) * w, wd = wb + (wt - wb) * w;
    return roundRect2(r - ri - th / 2, z, th / 2, wd / 2, Math.min(rr, th / 2 - 1e-3, wd / 2 - 1e-3));
  }, [-R, -R, -W, R, R, W]);
}
// Plateau de chevalière : contour 2D (XZ) extrudé vers +Y, évasé, bombé, arêtes arrondies
function plateNode(kind, a, b, y0, yTop, o = {}) {
  const dome = o.dome || 0, taper = o.taper || 0, rr = o.rr || 0, inset = o.inset || 0;
  const sh = shape2D(kind, a, b), am = Math.min(a, b), H = Math.max(1e-6, yTop - y0);
  const R = dome > 0 ? (am * am + dome * dome) / (2 * dome) : 0, cy = yTop + dome - R;
  const top = (x, z) => (dome > 0 ? cy + Math.sqrt(Math.max(0, R * R - x * x - z * z)) : yTop);
  const nd = node((x, y, z) => {
    const s = 1 - taper * clamp((yTop - y) / H, 0, 1);
    const d2 = sh(x / s, z / s) * s + inset;
    const wx = d2 + rr, wy = y - (yTop + dome) + rr;
    let d = Math.min(Math.max(wx, wy), 0) + Math.hypot(Math.max(wx, 0), Math.max(wy, 0)) - rr;
    if (dome > 0) d = smax(d, Math.hypot(x, y - cy, z) - R, rr);
    return Math.max(d, y0 - y);
  }, [-a - rr, y0, -b - rr, a + rr, yTop + dome + rr, b + rr]);
  nd.top = top;
  return nd;
}
const fingerCut = (n, ri, k = 0.3) => node((x, y, z) => smax(n.f(x, y, z), ri - Math.hypot(x, y), k), n.bb);
// Monogramme gravé ou en relief sur une surface supérieure top(x, z)
function engrave(n, p, ctx, a, b, top) {
  const text = (p.texte || '').trim();
  if (!text || p.gravure === 'aucune' || !ctx.textSDF) return n;
  const t2 = ctx.textSDF(text, 2 * a * 0.74, 2 * b * 0.74, !!p.miroir);
  if (!t2) return n;
  const depth = p.profondeur;
  if (p.gravure === 'relief') {
    const rel = node((x, y, z) => { const ty = top(x, z); return Math.max(t2(x, z), y - (ty + depth), ty - 0.4 - y); }, [-a, n.bb[1], -b, a, n.bb[4] + depth, b]);
    return union([n, rel]);
  }
  const g = node((x, y, z) => Math.max(t2(x, z), top(x, z) - depth - y), [-a, n.bb[1], -b, a, n.bb[4] + 1, b]);
  return sub(n, g);
}
const ringSizeLabel = (v) => v + ' · Ø ' + (v / PI).toFixed(1) + ' mm';
const resOf = (ctx, r) => (ctx.preview ? Math.min(r, ctx.previewRes || 72) : r);

// Courbe fermée paramétrique → maillage plat (pendentifs), plan XY face à +Z
function outline(kind, n = 160) {
  const P = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * 2 * PI;
    switch (kind) {
      case 'coeur': P.push([16 * Math.sin(t) ** 3 / 17, (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) / 17, 0]); break;
      case 'goutte': P.push([0.62 * Math.sin(t) * Math.sin(t / 2), Math.cos(t), 0]); break;
      case 'losange': { const s = [[0, 1], [0.62, 0], [0, -1], [-0.62, 0]], k = Math.floor((i / n) * 4), f = (i / n) * 4 - k, a = s[k], b = s[(k + 1) % 4]; P.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, 0]); break; }
      case 'etoile': { const k = (i / n) * 10, j = Math.floor(k), f = k - j; const pt = (q) => { const r = q % 2 ? 0.45 : 1, a = PI / 2 + (q * PI) / 5; return [r * Math.cos(a), r * Math.sin(a)]; }; const a = pt(j), b = pt(j + 1); P.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, 0]); break; }
      default: P.push([Math.cos(t), Math.sin(t), 0]);
    }
  }
  return P;
}
// Point d'accroche : sommet du contour au voisinage de l'axe vertical (creux du cœur compris)
function hangY(m, width) {
  let y = -1e9; const w = width * 0.06;
  for (let i = 0; i < m.nv * 3; i += 3) if (Math.abs(m.pos[i]) < w && m.pos[i + 1] > y) y = m.pos[i + 1];
  return y > -1e9 ? y : meshBounds(m)[4];
}
function flatPiece(kind, height, thick, inflate, res) {
  const P = outline(kind).map((p) => [p[0] * height / 2, p[1] * height / 2, 0]);
  const fit = Curves.fitPath(P, height * 0.002, true, kind === 'losange' || kind === 'etoile' ? 40 : 70);
  const c = Curves.makeCurve('shape', fit, true, { plane: { o: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] }, params: { thickness: thick, bevel: inflate > 0 ? 0 : Math.min(thick * 0.3, 0.4), inflate, anchor: 'center', res } });
  const m = Curves.shapeSolid(c);
  return { pos: m.pos, idx: m.idx, nv: m.nv, groups: new Uint32Array(m.idx.length / 3) };
}
// Tube le long d'une polyligne (fil métallique)
function wire(points, r, closed = false, sides = 12, profile = 'circle', aspect = 1, tol) {
  const fit = Curves.fitPath(points, tol || r * 0.15, closed, 70);
  const c = Curves.makeCurve('sweep', fit, closed, { up: [0, 0, 1], params: { radius: r, sides, profile, aspect, caps: true, density: 1.4 } });
  const m = Curves.sweepMesh(c);
  return { pos: m.pos, idx: m.idx, nv: m.nv, groups: new Uint32Array(m.idx.length / 3) };
}
// Anneau rond posé dans un plan : 'xy' (face +Z) ou 'yz' (face +X)
function ringAt(center, R, r, plane, q) {
  const m = ringMesh(R, R, r, q ? 16 : 28, q ? 8 : 12);
  const M = plane === 'yz' ? frameM([0, 0, 1], [0, 1, 0], [-1, 0, 0]) : [1, 0, 0, 0, 1, 0, 0, 0, 1];
  return xformMesh(m, M, center);
}

// ------------------------------------------------------------ chevalière
const P_RING = [
  { key: 'taille', label: 'Taille (FR)', type: 'range', min: 44, max: 72, step: 1, def: 56, fmt: ringSizeLabel },
  { key: 'bandeW', label: 'Largeur dessous', type: 'range', min: 2, max: 7, step: 0.1, def: 3.2, unit: 'mm' },
  { key: 'bandeT', label: 'Épaisseur dessous', type: 'range', min: 1.2, max: 3, step: 0.1, def: 1.6, unit: 'mm' },
];
const P_PLATE = [
  { key: 'forme', label: 'Forme du plateau', type: 'select', def: 'ovale', options: [['ovale', 'Ovale'], ['rond', 'Ronde'], ['carre', 'Carrée'], ['coussin', 'Coussin'], ['octogone', 'Octogone']] },
  { key: 'plateauW', label: 'Largeur plateau', type: 'range', min: 8, max: 22, step: 0.5, def: 12, unit: 'mm' },
  { key: 'plateauL', label: 'Longueur plateau', type: 'range', min: 8, max: 24, step: 0.5, def: 14, unit: 'mm' },
];
const P_TEXT = [
  { key: 'texte', label: 'Monogramme', type: 'text', def: 'L', max: 4 },
  { key: 'gravure', label: 'Monogramme', type: 'select', def: 'grave', options: [['grave', 'Gravé'], ['relief', 'En relief'], ['aucune', 'Aucun']] },
  { key: 'profondeur', label: 'Profondeur', type: 'range', min: 0.2, max: 1.2, step: 0.05, def: 0.5, unit: 'mm' },
  { key: 'miroir', label: 'Inversé (cachet à cire)', type: 'check', def: false },
];
const P_RES = (def, min = 96, max = 320) => ({ key: 'res', label: 'Résolution', type: 'range', min, max, step: 8, def });

function signet(p, ctx) {
  const ri = p.taille / (2 * PI), a = p.plateauW / 2, b = p.plateauL / 2, yTop = ri + p.plateauH;
  const band = ringBand(ri, p.bandeT, Math.max(p.bandeT, p.plateauH * 0.75), p.bandeW, Math.max(p.bandeW, 2 * b * 0.85), Math.min(0.6, p.bandeT * 0.4), 0.42);
  const plate = plateNode(p.forme, a, b, ri * 0.3, yTop, { dome: p.bombe, taper: p.depouille, rr: 0.35 });
  let ring = fingerCut(union([band, plate], p.epaule), ri);
  ring = engrave(ring, p, ctx, a, b, plate.top);
  return [part('Chevalière', meshSDF(ring, { res: resOf(ctx, p.res) }))];
}

// ------------------------------------------------------------ chevalière surfacique (cage de quads + Catmull-Clark)
function plateProfile(kind, xn) {
  const u = Math.min(1, Math.abs(xn));
  switch (kind) {
    case 'carre': return Math.pow(1 - Math.pow(u, 8), 1 / 8);
    case 'coussin': return Math.pow(1 - Math.pow(u, 3), 1 / 3);
    case 'octogone': return Math.min(1, 1.4142 - u);
    default: return Math.sqrt(Math.max(0, 1 - u * u));
  }
}
// ---- esquisses de construction (courbes de Bézier 2D, en mm)
//  face  : demi-contour extérieur vu de face (plan XY), du haut (x = 0) au bas (x = 0) ; le reste est symétrique
//  cote  : demi-largeur extérieure vue de côté (plan ZY), coordonnées [z, y], du haut du plateau au bas de l'anneau
//  dessus: quart du contour du plateau vu de dessus (plan XZ), coordonnées [x, z], de (0, b) à (a, 0)
// Tant qu'une esquisse n'est pas modifiée, elle est recalculée depuis les réglages.
function signetBase(p) {
  const ri = p.taille / (2 * PI);
  let a = p.plateauW / 2, b = p.plateauL / 2;
  if (p.forme === 'rond') a = b = Math.min(a, b);
  const yTop = ri + p.plateauH, hb = p.bandeW / 2, tb = p.bandeT;
  const hinTop = Math.min(b * 0.8, Math.max(hb * 1.6, b * 0.62));
  const phiP = Math.atan(a / yTop), phiS = phiP + clamp(p.epaule / ri, 0.15, 0.95);
  return { ri, a, b, yTop, hb, tb, hinTop, phiP, phiS, yBot: -(ri + tb) };
}
const wPlate = (B, ap) => 1 - smooth01((ap - B.phiP) / (B.phiS - B.phiP));
const wShoulder = (B, ap) => smooth01(1 - (ap - B.phiP) / (PI - B.phiP) * 1.15);
function defaultSketches(p) {
  const B = signetBase(p), fit = (pts, tol, corner) => Curves.fitPath(pts.map((q) => [q[0], q[1], 0]), tol, false, corner);
  // face : rayon extérieur selon l'angle (plateau plan, épaules, anneau)
  const face = [];
  for (let i = 0; i <= 160; i++) {
    const phi = (i / 160) * PI, c = Math.cos(phi), wP = wPlate(B, phi), wS = wShoulder(B, phi);
    const tBand = B.tb + (p.plateauH * 0.55 - B.tb) * wS, uBand = B.ri + Math.max(B.tb, tBand);
    const R = wP * (c > 0.2 ? B.yTop / c : uBand) + (1 - wP) * uBand;
    face.push([Math.sin(phi) * R, c * R]);
  }
  // côté : largeur intérieure héritée de l'ancien modèle, prolongée jusqu'au plateau
  const side = [[B.b, B.yTop]];
  for (let i = 0; i <= 80; i++) {
    const phi = B.phiP + ((PI - B.phiP) * i) / 80, wP = wPlate(B, phi), wS = wShoulder(B, phi);
    side.push([B.hb + (B.hinTop - B.hb) * Math.max(wP, wS * 0.85), Math.cos(phi) * B.ri]);
  }
  side.push([B.hb, B.yBot]);
  // dessus : contour du plateau selon la forme
  const top = [];
  for (let i = 0; i <= 90; i++) { const u = Math.sin((i / 90) * PI / 2); top.push([u * B.a, B.b * plateProfile(p.forme, u)]); }
  return { face: fit(face, 0.08, 35), cote: fit(side, 0.08, 50), dessus: fit(top, 0.02, 30), base: B };
}
// Décale une esquisse enregistrée quand la taille de doigt a changé depuis son édition
function shiftSketch(pts, f) { return pts.map((A) => { const d = f(A.p); const mv = (q) => [q[0] + d[0], q[1] + d[1], 0]; return { ...A, p: mv(A.p), i: mv(A.i), o: mv(A.o) }; }); }
function signetSketches(p) {
  const D = defaultSketches(p), B = D.base, sk = p.sketch || {}, out = { base: B, custom: {} };
  for (const k of ['face', 'cote', 'dessus']) {
    const c = sk[k];
    if (!c || !c.pts || c.pts.length < 2) { out[k] = D[k]; continue; }
    out.custom[k] = true;
    const dR = c.ri != null ? B.ri - c.ri : 0;
    if (Math.abs(dR) < 1e-9 || k === 'dessus') out[k] = c.pts;
    else if (k === 'face') out[k] = shiftSketch(c.pts, (q) => { const l = Math.hypot(q[0], q[1]) || 1; return [(q[0] / l) * dR, (q[1] / l) * dR]; });
    else out[k] = shiftSketch(c.pts, (q) => [0, q[1] >= 0 ? dR : -dR]);
  }
  return out;
}
const sketchPoly = (pts) => Curves.polyline({ pts, closed: false }, 24);
// Intersections d'une demi-droite / d'une droite avec une polyligne 2D
function rayHits(poly, o, d) {
  const hits = [];
  for (let i = 0; i + 1 < poly.length; i++) {
    const P = poly[i], Q = poly[i + 1], ex = Q[0] - P[0], ey = Q[1] - P[1], den = d[0] * ey - d[1] * ex;
    if (Math.abs(den) < 1e-14) continue;
    const wx = P[0] - o[0], wy = P[1] - o[1], t = (wx * ey - wy * ex) / den, s = (wx * d[1] - wy * d[0]) / den;
    if (s >= -1e-9 && s <= 1 + 1e-9) hits.push(t);
  }
  return hits;
}
function sketchEval(sk) {
  const B = sk.base, F = sketchPoly(sk.face), C = sketchPoly(sk.cote), T = sketchPoly(sk.dessus).map((q) => [Math.abs(q[0]), Math.abs(q[1])]);
  const RF = (phi) => { const h = rayHits(F, [0, 0], [Math.sin(phi), Math.cos(phi)]).filter((t) => t > 0); return h.length ? Math.max(...h) : B.ri + B.tb; };
  let a = 0; for (const q of T) a = Math.max(a, q[0]);
  const hT = (x) => { x = Math.abs(x); if (x >= a) return 0; const h = rayHits(T, [x, 0], [0, 1]); return h.length ? Math.max(0, ...h) : 0; };
  let yMax = -Infinity, yMin = Infinity; for (const q of C) { yMax = Math.max(yMax, q[1]); yMin = Math.min(yMin, q[1]); }
  const atY = (y) => { const h = rayHits(C, [0, y], [1, 0]); return h.length ? Math.max(...h.map(Math.abs)) : null; };
  const W = (y) => { const yy = clamp(y, yMin + 1e-6, yMax - 1e-6), v = atY(yy); return v != null ? v : Math.abs(C[y > (yMax + yMin) / 2 ? 0 : C.length - 1][0]); };
  return { RF, hT, W, a: Math.max(a, 0.5), b: Math.max(hT(0), 0.5), yTop: RF(0) };
}
function signetCage(p) {
  const sk = signetSketches(p), B = sk.base, E = sketchEval(sk), ri = B.ri;
  const a = E.a, b = E.b, yTop = E.yTop, dome = p.bombe, dep = p.depouille, tb = B.tb;
  const phiP = Math.atan(a / yTop), phiS = phiP + clamp(p.epaule / ri, 0.15, 0.95), BB = { ...B, phiP, phiS };
  // angles des sections (0 = haut), denses sur le plateau et ses bords
  const ang = [];
  const nP = 12; for (let i = 0; i <= nP; i++) ang.push(-phiP + (2 * phiP * i) / nP);
  ang.push(-phiP + 0.03, phiP - 0.03);
  for (let i = 1; i <= 4; i++) { const t = phiP + ((phiS - phiP) * i) / 4; ang.push(t, -t); }
  const nB = 12; for (let i = 1; i < nB; i++) ang.push(phiS + ((2 * PI - 2 * phiS) * i) / nB);
  const A = ang.map((x) => ((x % (2 * PI)) + 2 * PI) % (2 * PI)).sort((x, y) => x - y);
  const uniq = A.filter((x, i) => i === 0 || x - A[i - 1] > 1e-4);
  const S = uniq.length;
  const domeH = (x, z) => dome * Math.max(0, 1 - (x / a) ** 2 - (z / b) ** 2);
  const eIn = Math.min(0.35, tb * 0.25), eTop = p.arete;
  const V = [], F = [], G = [];
  let loopLen = 0;
  // rayons de contrôle intérieurs : la limite (P[i-1] + 4P[i] + P[i+1]) / 6 doit tomber exactement sur ri
  const dA = uniq.map((x, i) => { const d = uniq[(i + 1) % S] - x; return d < 0 ? d + 2 * PI : d; });
  let Rc = uniq.map(() => ri);
  for (let it = 0; it < 80; it++) Rc = Rc.map((_, i) => (6 * ri - Rc[(i - 1 + S) % S] * Math.cos(dA[(i - 1 + S) % S]) - Rc[(i + 1) % S] * Math.cos(dA[i])) / 4);
  const sections = uniq.map((phi, si) => {
    const sp = phi > PI ? phi - 2 * PI : phi;               // angle signé depuis le haut
    const ap = Math.abs(sp), s = Math.sin(sp), c = Math.cos(sp);
    const wP = wPlate(BB, ap);                               // 1 sur le plateau → 0 sous les épaules
    const Rin = Rc[si];
    const hin = Math.max(0.3, E.W(c * ri));
    const xPl = yTop * Math.tan(Math.min(ap, phiP + 0.2)) * Math.sign(sp);
    // l'anneau est arrondi par la subdivision : on compense comme pour le rayon intérieur (hors plateau plan)
    const RF = Math.max(E.RF(ap) + (1 - wP) * (Rin - ri), Rin + 0.4);
    const uOut = (z) => RF + (c > 0.2 ? (wP * domeH(xPl, z)) / c : 0);
    const uTop = uOut(0);
    const houtP = Math.max(E.hT(xPl), hin * 0.65, 0.4);
    const hout = wP * houtP + (1 - wP) * Math.max(0.9 * E.W(c * uTop), 0.3);
    const wallH = Math.min(p.plateauH * 0.45, (uTop - Rin) * 0.45);
    const uW = wP * (uTop - wallH) + (1 - wP) * (Rin + uTop) / 2;
    const hw = wP * Math.max(hin, hout * (1 - dep)) + (1 - wP) * Math.max(hin, hout);
    // contour de la section dans le plan (u radial, z) : intérieur, flanc droit, dessus, flanc gauche
    const pts = [], kind = [];
    const push = (u, z, k) => { pts.push([u, z]); kind.push(k); };
    const seg = (u0, z0, u1, z1, n, h0, h1, k) => {
      const L = Math.hypot(u1 - u0, z1 - z0) || 1;
      const ts = [0]; if (h0 > 0) ts.push(Math.min(0.3, h0 / L));
      for (let i = 1; i <= n; i++) ts.push(i / (n + 1));
      if (h1 > 0) ts.push(1 - Math.min(0.3, h1 / L));
      ts.sort((x, y) => x - y).forEach((t) => push(u0 + (u1 - u0) * t, z0 + (z1 - z0) * t, k));
    };
    seg(Rin, -hin, Rin, hin, 3, eIn, eIn, 0);                 // intérieur
    seg(Rin, hin, uW, hw, 1, eIn, 0, 3);                       // flanc droit (bas)
    seg(uW, hw, uTop, hout, 0, 0, eTop, 3);                     // flanc droit (haut)
    seg(uTop, hout, uTop, -hout, 7, eTop, eTop, wP > 0.5 ? 1 : 2); // dessus
    seg(uTop, -hout, uW, -hw, 0, eTop, 0, 3);                   // flanc gauche (haut)
    seg(uW, -hw, Rin, -hin, 1, 0, eIn, 3);                      // flanc gauche (bas)
    loopLen = pts.length;
    const idx = pts.map(([u, z], k) => {
      const uu = kind[k] === 1 || kind[k] === 2 ? uOut(z) : u;
      V.push([s * uu, c * uu, z]); return V.length - 1;
    });
    return { idx, kind };
  });
  for (let i = 0; i < S; i++) {
    const A0 = sections[i].idx, B0 = sections[(i + 1) % S].idx;
    for (let k = 0; k < loopLen; k++) {
      const k2 = (k + 1) % loopLen;
      F.push([A0[k], A0[k2], B0[k2], B0[k]]);
      G.push(sections[i].kind[k] === sections[i].kind[k2] ? sections[i].kind[k] : 3);
    }
  }
  return { cage: Surface.orient({ V, F, G }), a, b, yTop, ri, sketches: sk };
}
function signetSurface(p, ctx) {
  const { cage, a, b, yTop } = signetCage(p);
  const lv = ctx.preview ? Math.min(2, p.subdiv) : p.subdiv;
  const m = Surface.toTriMesh(Surface.subdivide(cage, lv));
  const text = (p.texte || '').trim();
  if (text && p.gravure !== 'aucune' && ctx.textSDF) {
    const t2 = ctx.textSDF(text, 2 * a * 0.74, 2 * b * 0.74, !!p.miroir);
    if (t2) {
      const cell = (2 * a) / 12 / Math.pow(2, lv) * 1.2, sgn = p.gravure === 'relief' ? 1 : -1;
      for (let i = 0; i < m.nv * 3; i += 3) {
        const x = m.pos[i], y = m.pos[i + 1], z = m.pos[i + 2];
        if (y < yTop - 0.25 || Math.abs(x) > a || Math.abs(z) > b) continue;
        const cov = clamp(0.5 - t2(x, z) / (2 * cell), 0, 1);
        if (cov > 0) m.pos[i + 1] = y + sgn * p.profondeur * cov;
      }
    }
  }
  return [part('Chevalière', m)];
}

// ------------------------------------------------------------ chevalière à clapet
function signetLocket(p, ctx) {
  const ri = p.taille / (2 * PI), a = p.plateauW / 2, b = p.plateauL / 2, yTop = ri + p.plateauH;
  const lidT = p.couvercle, c = p.jeu, ySeat = yTop - lidT;
  const band = ringBand(ri, p.bandeT, Math.max(p.bandeT, p.plateauH * 0.7), p.bandeW, Math.max(p.bandeW, 2 * b * 0.85), Math.min(0.6, p.bandeT * 0.4), 0.42);
  const base = plateNode(p.forme, a, b, ri * 0.3, ySeat, { taper: p.depouille, rr: 0.25 });
  let body = fingerCut(union([band, base], p.epaule), ri);
  // compartiment
  const depth = Math.max(0.5, Math.min(p.cavite, ySeat - ri - 0.8));
  const sh = shape2D(p.forme, a, b);
  body = sub(body, node((x, y, z) => Math.max(sh(x, z) + p.paroi, ySeat - depth - y), [-a, ySeat - depth, -b, a, yTop + 2, b]), 0.2);
  // encoche pour l'ongle, côté opposé à la charnière
  body = sub(body, sphere(-a, ySeat, 0, 1.1));
  // charnière : axe parallèle au doigt, sur le bord +X
  const rk = lidT / 2 + 0.45, xa = a - rk * 0.25, yh = ySeat + lidT / 2, Lk = 2 * b * 0.72, rp = Math.max(0.35, rk * 0.45);
  const z1 = Lk / 6;
  const kBody = union([cyl('z', xa, yh, 0, rk, -Lk / 2, -z1 - c / 2, 0.15), cyl('z', xa, yh, 0, rk, z1 + c / 2, Lk / 2, 0.15)]);
  const kLid = cyl('z', xa, yh, 0, rk, -z1 + c / 2, z1 - c / 2, 0.15);
  body = union([body, kBody], 0.3);
  body = sub(body, cyl('z', xa, yh, 0, rk + c, -z1 - c / 2, z1 + c / 2));
  body = sub(body, cyl('z', xa, yh, 0, rp + c * 0.25, -Lk / 2 - 1, Lk / 2 + 1));
  // couvercle
  const lidP = plateNode(p.forme, a, b, ySeat + c * 0.5, yTop, { dome: p.bombe, rr: 0.3, inset: c });
  let lid = union([lidP, kLid], 0.3);
  lid = sub(lid, cyl('z', xa, yh, 0, rk + c, -Lk / 2 - 1, -z1 + c / 2 - c));
  lid = sub(lid, cyl('z', xa, yh, 0, rk + c, z1 - c / 2 + c, Lk / 2 + 1));
  lid = sub(lid, cyl('z', xa, yh, 0, rp + c, -Lk / 2 - 1, Lk / 2 + 1));
  lid = engrave(lid, p, ctx, a, b, lidP.top);
  const h = (2 * (ri + p.plateauH + 2)) / resOf(ctx, p.res);
  const ang = -clamp(p.ouverture, 0, 130) * DEG;
  const bodyM = meshSDF(body, { h });
  const lidM = rotateMesh(meshSDF(lid, { h }), 'z', [xa, yh, 0], ang);
  const pin = cylinderMesh([xa, yh, -Lk / 2], [xa, yh, Lk / 2], rp, ctx.preview ? 12 : 24);
  return [part('Anneau', bodyM), part('Clapet', lidM), part('Goupille', pin)];
}

// ------------------------------------------------------------ bracelet à clapet
function bangle(p, ctx) {
  const a = p.largeurInt / 2, b = p.hauteurInt / 2, th = p.epaisseur, bw = p.largeurJonc, c = p.jeu, g = Math.max(0.2, c * 1.5);
  const rr = Math.min(0.6, th * 0.3);
  const band = node((x, y, z) => {
    const u = ellipse2(x, y, a, b), vz = Math.abs(z) / (bw / 2);
    const thz = th * (1 - p.bombe * 0.55 * vz * vz);
    return smax(smax(-u, u - thz, rr), Math.abs(z) - bw / 2, rr);
  }, [-(a + th), -(b + th), -bw / 2, a + th, b + th, bw / 2]);
  let fixed = node((x, y, z) => Math.max(band.f(x, y, z), y + g / 2), band.bb);
  let moving = node((x, y, z) => Math.max(band.f(x, y, z), g / 2 - y), band.bb);
  const xh = -(a + th / 2), rk = Math.max(1.2, th * 0.72), rp = Math.max(0.5, rk * 0.42), z1 = bw / 6;
  const kF = union([cyl('z', xh, 0, 0, rk, -bw / 2, -z1 - c / 2, 0.2), cyl('z', xh, 0, 0, rk, z1 + c / 2, bw / 2, 0.2)]);
  const kM = cyl('z', xh, 0, 0, rk, -z1 + c / 2, z1 - c / 2, 0.2);
  fixed = sub(union([fixed, kF], 0.4), cyl('z', xh, 0, 0, rk + c, -z1 - c / 2, z1 + c / 2));
  moving = union([moving, kM], 0.4);
  moving = sub(moving, cyl('z', xh, 0, 0, rk + c, -bw, -z1 + c / 2 - c));
  moving = sub(moving, cyl('z', xh, 0, 0, rk + c, z1 - c / 2 + c, bw));
  fixed = sub(fixed, cyl('z', xh, 0, 0, rp + c * 0.25, -bw, bw));
  moving = sub(moving, cyl('z', xh, 0, 0, rp + c, -bw, bw));
  if (p.fermoir) {
    const xc = a + th / 2, tt = th * 0.42, tw = bw * 0.5, tl = Math.max(4, th * 2.2);
    moving = union([moving, boxMM(xc - tt / 2, -tl, -tw / 2, xc + tt / 2, g, tw / 2, 0.1)]);
    fixed = sub(fixed, boxMM(xc - tt / 2 - c, -tl - c, -tw / 2 - c, xc + tt / 2 + c, 1, tw / 2 + c));
    fixed = sub(fixed, cyl('z', a + th, -tl * 0.45, 0, 0.9, -bw, bw));
  }
  const h = (2 * (a + th + 2)) / resOf(ctx, p.res);
  const fM = meshSDF(fixed, { h });
  const mM = rotateMesh(meshSDF(moving, { h }), 'z', [xh, 0, 0], clamp(p.ouverture, 0, 120) * DEG);
  return [part('Demi-jonc fixe', fM), part('Demi-jonc mobile', mM), part('Goupille', cylinderMesh([xh, 0, -bw / 2], [xh, 0, bw / 2], rp, ctx.preview ? 12 : 24))];
}

// ------------------------------------------------------------ collier
function necklacePath(L, drop) {
  const n = 1200, P = [];
  for (let i = 0; i < n; i++) { const t = (i / n) * 2 * PI; P.push([Math.sin(t), Math.cos(t) - drop * ((1 - Math.cos(t)) / 2) ** 3, 0]); }
  const per = Curves.polyLength(P, true), s = L / per;
  return P.map((p) => [p[0] * s, p[1] * s, 0]);
}
function linkFrame(pts, cum, L, s) {
  const n = pts.length; let j = 0;
  while (j < n - 1 && cum[j + 1] < s) j++;
  const a = pts[j], b = pts[(j + 1) % n], seg = cum[j + 1] - cum[j], f = seg > 0 ? (s - cum[j]) / seg : 0;
  return { p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, 0], t: norm(subv(b, a)) };
}
function necklace(p, ctx) {
  const q = !!ctx.preview, L = p.longueur, rw = p.fil / 2;
  const aspect = { forcat: 1.45, ronde: 1.0, allongee: 2.2 }[p.maille] || 1.45;
  const len = p.maillon, wid = Math.max(len / aspect, 6.2 * rw);
  const A = (len - 2 * rw) / 2, Bm = (wid - 2 * rw) / 2;
  const pitch = Math.max(rw * 2.2, len - 4 * rw * 0.95);
  let N = Math.round(L / pitch); if (N % 2) N++;
  const pts = necklacePath(L, p.chute); pts.push(pts[0]);
  const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const Ltot = cum[cum.length - 1];
  const base = ringMesh(A, Bm, rw, q ? 14 : 22, q ? 6 : 10);
  const links = [];
  for (let i = 0; i < N; i++) {
    const { p: P, t } = linkFrame(pts, cum, Ltot, (i / N) * Ltot);
    const np = [-t[1], t[0], 0], bz = [0, 0, 1];
    const M = i % 2 ? frameM(t, bz, mul(np, -1)) : frameM(t, np, bz);
    links.push(xformMesh(base, M, P));
  }
  const parts = [part('Chaîne', mergeMeshes(links, 'alternate'))];
  if (p.fermoir) {
    const top = linkFrame(pts, cum, Ltot, 0).p;
    parts.push(part('Fermoir', mergeMeshes([ringAt(add(top, [0, wid * 0.2, 0]), wid * 0.75, rw * 1.6, 'yz', q), ringAt(add(top, [len * 0.9, 0, 0]), wid * 0.45, rw * 1.2, 'xy', q)])));
  }
  if (p.pendentif !== 'aucun') {
    const Pc = linkFrame(pts, cum, Ltot, Ltot / 2).p;
    const Rb = Math.max(wid * 0.6, 1.4), rb = rw * 1.15, Rl = Math.max(wid * 0.45, 1.1), rl = rw;
    const bail = ringAt(add(Pc, [0, -Rb, 0]), Rb, rb, 'yz', q);
    const B1 = Pc[1] - 2 * Rb;
    const loopC = [Pc[0], B1 + rb + rl - Rl, 0];
    const loop = ringAt(loopC, Rl, rl, 'xy', q);
    const pend = flatPiece(p.pendentif, p.taillePend, p.epaisseurPend, p.bombePend, resOf(ctx, p.res));
    const dy = loopC[1] - Rl + rl * 0.6 - hangY(pend, p.taillePend);
    parts.push(part('Bélière', mergeMeshes([bail, loop])));
    parts.push(part('Pendentif', translateMesh(pend, [Pc[0], dy, 0])));
  }
  return parts;
}

// ------------------------------------------------------------ boucles d'oreille
function earring(p, ctx) {
  const q = !!ctx.preview, res = resOf(ctx, p.res);
  let parts = [];
  if (p.modele === 'creole') {
    const R = p.diametre / 2 - p.epaisseur / 2, gap = 22 * DEG, n = 120, arc = [];
    for (let i = 0; i <= n; i++) { const t = PI / 2 + gap / 2 + (i / n) * (2 * PI - gap); arc.push([R * Math.cos(t), R * Math.sin(t), 0]); }
    const prof = { rond: 'circle', 'demi-rond': 'half', carre: 'square', plat: 'rounded' }[p.profil] || 'circle';
    const hoop = wire(arc, p.epaisseur / 2, false, q ? 12 : 20, prof, p.profil === 'plat' ? 0.45 : 1, R * 0.002);
    const post = []; for (let i = 0; i <= 24; i++) { const t = PI / 2 - gap / 2 - 10 * DEG + (i / 24) * (gap + 20 * DEG); post.push([R * Math.cos(t), R * Math.sin(t), 0]); }
    parts = [part('Créole', hoop), part('Tige', wire(post, 0.4, false, 10))];
  } else if (p.modele === 'pendante') {
    const hook = [];
    for (let i = 0; i <= 12; i++) hook.push([0, (i / 12) * 7, 0]);
    for (let i = 1; i <= 24; i++) { const t = (i / 24) * PI; hook.push([-4 + 4 * Math.cos(t), 7 + 4 * Math.sin(t), 0]); }
    for (let i = 1; i <= 16; i++) hook.push([-8 + (i / 16) * 0.8, 7 - (i / 16) * 13, 0]);
    const eye = ringAt([0, -1.1, 0], 1.1, 0.4, 'xy', q);
    const jr = ringAt([0, -2.2 - 1.6 + 0.8, 0], 1.6, 0.4, 'yz', q);
    const pend = flatPiece(p.forme, p.taille, p.epaisseurPend, p.bombe, res);
    const top = hangY(pend, p.taille);
    const loop = ringAt([0, -2.2 - 3.2 + 0.8 - 0.9, 0], 1.0, 0.35, 'xy', q);
    const ly = -2.2 - 3.2 + 0.8 - 0.9 - 1.0;
    parts = [part('Crochet', mergeMeshes([wire(hook, 0.4, false, 10), eye])), part('Anneau', jr), part('Pampille', mergeMeshes([loop, translateMesh(pend, [0, ly + 0.3 - top, 0])]))];
  } else {
    const a = p.pierre === 'ronde' ? p.tailleP / 2 : p.tailleP / 2, b = p.pierre === 'ovale' ? p.tailleP * 0.72 / 2 : p.tailleP / 2;
    const kind = p.pierre === 'carree' ? 'carre' : p.pierre === 'ovale' ? 'ovale' : 'rond';
    const s2 = shape2D(kind, a, b), wall = 0.45, hgt = Math.min(a, b) * 0.55;
    const bezel = node((x, y, z) => { const d = s2(x, y); return smax(smax(d - wall, -(d + 0.05) - (z < -0.6 ? 10 : 0), 0.05), Math.max(-1.0 - z, z - hgt * 0.45), 0.15); }, [-a - wall, -b - wall, -1.2, a + wall, b + wall, hgt]);
    const stone = node((x, y, z) => { const e = ellipsoid(0, 0, -0.4, a * 0.98, b * 0.98, hgt + 0.4).f(x, y, z); return Math.max(e, kind === 'carre' ? s2(x, y) + 0.02 : -1e9, -0.55 - z); }, [-a, -b, -0.6, a, b, hgt]);
    const post = cylinderMesh([0, 0, -0.9], [0, 0, -11], 0.45, q ? 10 : 16);
    const back = union([cyl('z', 0, 0, -7, 2.8, -7.25, -6.75, 0.2), torus('x', 1.25, 0, -6.2, 0.8, 0.32), torus('x', -1.25, 0, -6.2, 0.8, 0.32)], 0.2);
    const backH = sub(back, cyl('z', 0, 0, 0, 0.52, -9, -5));
    const h = (2 * a + 2) / res;
    parts = [part('Monture', mergeMeshes([meshSDF(bezel, { h }), post])), part('Pierre', meshSDF(stone, { h })), part('Poussette', meshSDF(backH, { h: 6 / res }))];
  }
  if (p.paire) {
    const bb0 = parts.map((pt) => meshBounds(pt.mesh)), w = Math.max(...bb0.map((b) => b[3] - b[0]));
    const dx = w + 6;
    parts = parts.flatMap((pt) => [part(pt.name + ' G', translateMesh(pt.mesh, [-dx / 2, 0, 0])), part(pt.name + ' D', mirrorMeshX(pt.mesh, dx / 2))]);
  }
  return parts;
}

// ------------------------------------------------------------ humanoïde
function humanoid(p, ctx) {
  const H = p.taille, nh = p.tetes, hu = H / nh, B = H - hu, bu = B / 7;
  const c = p.corpulence, rc = Math.sqrt(c), sil = p.silhouette, sh = 1 + 0.12 * sil, hp = 1 - 0.1 * sil;
  const k = 0.12 * bu * p.lissage, chin = B, hy = H - 0.5 * hu;
  let head = union([ellipsoid(0, hy, 0.02 * hu, 0.37 * hu, 0.5 * hu, 0.43 * hu), ellipsoid(0, H - 0.8 * hu, 0.1 * hu, 0.27 * hu, 0.24 * hu, 0.3 * hu)], 0.1 * hu);
  if (p.visage) {
    head = union([head, roundCone([0, hy - 0.02 * hu, 0.36 * hu], [0, hy - 0.2 * hu, 0.46 * hu], 0.035 * hu, 0.06 * hu), mirrorX(ellipsoid(0.37 * hu, hy - 0.05 * hu, -0.02 * hu, 0.05 * hu, 0.13 * hu, 0.08 * hu))], 0.04 * hu);
    head = sub(head, mirrorX(sphere(0.15 * hu, hy + 0.03 * hu, 0.43 * hu, 0.075 * hu)), 0.05 * hu);
  }
  const neck = capsule([0, chin + 0.15 * hu, -0.04 * hu], [0, chin - 0.5 * bu, -0.03 * bu], 0.2 * bu * rc);
  const torso = union([
    ellipsoid(0, chin - 1.2 * bu, 0, 0.88 * bu * sh * rc, 0.86 * bu, 0.55 * bu * c),
    ellipsoid(0, chin - 2.25 * bu, 0, 0.66 * bu * c * (1 - 0.05 * sil), 0.75 * bu, 0.47 * bu * c),
    ellipsoid(0, chin - 3.05 * bu, -0.03 * bu, 0.82 * bu * hp * rc, 0.62 * bu, 0.52 * bu * c),
  ], 0.4 * bu);
  const a = p.bras * DEG, S = [0.92 * bu * sh, chin - 0.78 * bu, -0.04 * bu];
  const d1 = [Math.sin(a), -Math.cos(a), 0], E = add(S, mul(d1, 1.5 * bu));
  const d2 = norm([Math.sin(a * 0.85), -Math.cos(a * 0.85), 0.28]), W = add(E, mul(d2, 1.2 * bu)), Hd = add(W, mul(d2, 0.72 * bu));
  const arm = union([sphere(S[0] - 0.05 * bu, S[1], S[2], 0.27 * bu * rc), roundCone(S, E, 0.21 * bu * rc, 0.15 * bu * rc), roundCone(E, W, 0.15 * bu * rc, 0.1 * bu * rc),
    roundCone(W, Hd, 0.11 * bu, 0.08 * bu), capsule(add(W, [0, -0.15 * bu, 0.08 * bu]), add(W, [-0.08 * bu, -0.42 * bu, 0.2 * bu]), 0.045 * bu)], k * 0.6);
  const sp = p.jambes * DEG, Hip = [0.45 * bu * hp, chin - 3.35 * bu, 0];
  const dl = [Math.sin(sp), -Math.cos(sp), 0], Kn = add(Hip, mul(norm(add(dl, [0, 0, 0.03])), 2.0 * bu)), An = add(Kn, mul(norm(add(dl, [0, 0, -0.02])), 1.95 * bu));
  const leg = union([roundCone(Hip, Kn, 0.45 * bu * rc, 0.27 * bu * rc), roundCone(Kn, An, 0.27 * bu * rc, 0.15 * bu * rc), ellipsoid(Kn[0] + (An[0] - Kn[0]) * 0.3, Kn[1] - 0.6 * bu, -0.08 * bu, 0.22 * bu * rc, 0.6 * bu, 0.25 * bu * rc),
    roundCone(An, add(An, [0.06 * bu, -0.42 * bu, 0.95 * bu]), 0.17 * bu, 0.12 * bu), sphere(An[0], An[1] - 0.3 * bu, An[2] - 0.08 * bu, 0.17 * bu)], k * 0.6);
  const body = union([head, neck, torso, mirrorX(arm), mirrorX(leg)], k, true);
  const m = meshSDF(body, { res: resOf(ctx, p.res) });
  const bb = meshBounds(m), s = H / (bb[4] - bb[1]);
  return [part('Humanoïde', xformMesh(m, [s, 0, 0, 0, s, 0, 0, 0, s], [0, -bb[1] * s, 0]))];
}

// ------------------------------------------------------------ animaux
const SPECIES = {
  chien: { leg: 0.62, chest: 0.2, hip: 0.16, legR: 0.065, neck: 0.28, neckA: 48, head: 0.13, muz: 0.16, muzR: 0.06, ears: 'tombantes', ear: 0.12, tail: 0.42, tailR: 0.035, curl: 45 },
  chat: { leg: 0.46, chest: 0.15, hip: 0.15, legR: 0.045, neck: 0.15, neckA: 42, head: 0.12, muz: 0.05, muzR: 0.05, ears: 'pointues', ear: 0.08, tail: 0.85, tailR: 0.03, curl: 80 },
  cheval: { leg: 0.95, chest: 0.24, hip: 0.22, legR: 0.06, neck: 0.55, neckA: 55, head: 0.11, muz: 0.36, muzR: 0.075, ears: 'pointues', ear: 0.07, tail: 0.65, tailR: 0.05, curl: -70 },
  ours: { leg: 0.45, chest: 0.3, hip: 0.28, legR: 0.11, neck: 0.16, neckA: 22, head: 0.16, muz: 0.1, muzR: 0.07, ears: 'rondes', ear: 0.06, tail: 0.07, tailR: 0.05, curl: 0 },
  lapin: { leg: 0.32, chest: 0.18, hip: 0.25, legR: 0.05, neck: 0.08, neckA: 50, head: 0.15, muz: 0.05, muzR: 0.06, ears: 'longues', ear: 0.36, tail: 0.0, tailR: 0.08, curl: 0 },
};
function quadruped(p, sp) {
  const S = Object.assign({}, SPECIES[p.espece] || SPECIES.chien);
  const c = p.corpulence, L = p.corps, legL = S.leg * p.pattes, ear = p.oreilles === 'auto' ? S.ears : p.oreilles;
  const Hp = [0, legL * 0.95 + S.hip * 0.25, -0.5 * L], Cp = [0, legL + S.chest * 0.15, 0.5 * L];
  const k = 0.05;
  const torso = union([roundCone(Hp, Cp, S.hip * c, S.chest * c), ellipsoid(0, (Hp[1] + Cp[1]) / 2 - S.chest * 0.25, 0.05 * L, S.chest * 0.85 * c, S.chest * 0.8 * c, 0.45 * L)], 0.08);
  const legR = S.legR * Math.sqrt(c);
  const fs = [S.chest * 0.55 * c, Cp[1] - S.chest * 0.35, Cp[2] - 0.02], fp = [fs[0] * 0.9, legR * 0.6, Cp[2] + 0.03];
  const fe = [fs[0], fs[1] * 0.45 + fp[1] * 0.55, fs[2] - 0.05 * legL];
  const front = union([roundCone(fs, fe, legR * 1.7, legR * 1.05), roundCone(fe, fp, legR * 1.05, legR * 0.85), ellipsoid(fp[0], legR * 0.5, fp[2] + legR * 0.6, legR * 1.1, legR * 0.55, legR * 1.6)], k * 0.5);
  const hindTop = p.espece === 'lapin' ? 1.6 : 1;
  const hs = [S.hip * 0.6 * c, Hp[1] - S.hip * 0.25, Hp[2] + 0.05], hk = [hs[0], hs[1] - legL * 0.38, hs[2] + 0.14 * legL * hindTop];
  const hh = [hs[0] * 0.95, legL * 0.28, hs[2] - 0.1 * legL], hpw = [hs[0] * 0.92, legR * 0.6, hs[2] - 0.02];
  const hind = union([roundCone(hs, hk, legR * 2.2 * hindTop, legR * 1.3), roundCone(hk, hh, legR * 1.3, legR * 0.9), roundCone(hh, hpw, legR * 0.9, legR * 0.85),
    ellipsoid(hpw[0], legR * 0.5, hpw[2] + legR * 0.6 * hindTop, legR * 1.1, legR * 0.55, legR * 1.6 * hindTop)], k * 0.5);
  const na = S.neckA * DEG, nd = [0, Math.sin(na), Math.cos(na)];
  const n0 = add(Cp, [0, S.chest * 0.45, S.chest * 0.25]), n1 = add(n0, mul(nd, S.neck * p.cou));
  const hr = S.head * p.tete, hc = add(n1, mul(nd, hr * 0.55));
  const fwd = norm([0, -0.28, 1]);
  const m0 = add(hc, mul(fwd, hr * 0.45)), m1 = add(m0, mul(fwd, S.muz * p.tete));
  const parts = [roundCone(n0, n1, S.chest * 0.55 * Math.sqrt(c), hr * 0.7), sphere(hc[0], hc[1], hc[2], hr), roundCone(m0, m1, S.muzR * 1.25 * p.tete, S.muzR * p.tete), sphere(m1[0], m1[1] + S.muzR * 0.4, m1[2] + S.muzR * 0.6, S.muzR * 0.45 * p.tete)];
  const eye = mirrorX(sphere(hr * 0.45, hc[1] + hr * 0.25, hc[2] + hr * 0.78, hr * 0.15));
  let head = union(parts, 0.04);
  const e0 = add(hc, [hr * 0.5, hr * 0.72, -hr * 0.1]), es = S.ear * p.tete;
  if (ear === 'pointues') head = union([head, mirrorX(roundCone(e0, add(e0, [es * 0.35, es, -es * 0.1]), es * 0.35, es * 0.06))], 0.02);
  else if (ear === 'rondes') head = union([head, mirrorX(ellipsoid(e0[0] + es * 0.3, e0[1] + es * 0.4, e0[2], es * 0.6, es * 0.6, es * 0.3))], 0.02);
  else if (ear === 'tombantes') head = union([head, mirrorX(roundCone(add(e0, [hr * 0.15, 0, 0]), add(e0, [hr * 0.45, -es * 1.1, 0.02]), es * 0.3, es * 0.4))], 0.02);
  else if (ear === 'longues') head = union([head, mirrorX(roundCone(e0, add(e0, [es * 0.15, es, -es * 0.25]), es * 0.16, es * 0.12))], 0.02);
  head = union([head, eye], 0.01);
  const list = [torso, mirrorX(front), mirrorX(hind), head];
  const tl = S.tail * p.queue;
  if (p.espece === 'lapin' || tl < 0.08) list.push(sphere(0, Hp[1] + S.hip * 0.4, Hp[2] - S.hip * 0.9, Math.max(0.03, S.tailR * p.queue + 0.02)));
  else {
    const seg = 7, pts = [add(Hp, [0, S.hip * 0.55, -S.hip * 0.7])]; let ang = 15 * DEG; const curl = S.curl * DEG / seg;
    for (let i = 0; i < seg; i++) { ang += curl; pts.push(add(pts[i], [0, Math.sin(ang) * tl / seg, -Math.cos(ang) * tl / seg])); }
    const tail = []; for (let i = 0; i < seg; i++) tail.push(roundCone(pts[i], pts[i + 1], S.tailR * (1 - i / seg * 0.6), S.tailR * (1 - (i + 1) / seg * 0.6)));
    list.push(union(tail, 0.01));
  }
  return union(list, k, true);
}
function bird(p) {
  const c = p.corpulence, t = p.tete;
  const body = ellipsoid(0, 0.55, 0, 0.21 * c, 0.23 * c, 0.4 * p.corps);
  const hc = [0, 0.95, 0.32 * p.corps];
  const list = [body, capsule([0, 0.7, 0.2 * p.corps], hc, 0.11 * c), sphere(hc[0], hc[1], hc[2], 0.15 * t),
    roundCone(add(hc, [0, -0.02, 0.12 * t]), add(hc, [0, -0.06, 0.12 * t + 0.2 * t]), 0.055 * t, 0.008),
    mirrorX(ellipsoid(0.19 * c, 0.6, -0.06, 0.06, 0.18 * c, 0.4 * p.corps)),
    ellipsoid(0, 0.55, -0.42 * p.corps - 0.22 * p.queue, 0.17 * p.queue + 0.02, 0.035, 0.28 * p.queue + 0.02),
    mirrorX(sphere(0.085 * t, hc[1] + 0.04 * t, hc[2] + 0.1 * t, 0.03 * t))];
  const lg = 0.35 * p.pattes;
  const leg = union([capsule([0.09, 0.4, 0.04], [0.09, 0.4 - lg, 0.06], 0.022), capsule([0.09, 0.4 - lg, 0.06], [0.09, 0.4 - lg, 0.2], 0.016),
    capsule([0.09, 0.4 - lg, 0.06], [0.16, 0.4 - lg, 0.16], 0.016), capsule([0.09, 0.4 - lg, 0.06], [0.04, 0.4 - lg, 0.17], 0.016), capsule([0.09, 0.4 - lg, 0.06], [0.09, 0.4 - lg, -0.06], 0.016)], 0.02);
  list.push(mirrorX(leg));
  return union(list, 0.04, true);
}
function fish(p) {
  const c = p.corpulence, Lb = p.corps, pts = [], R = [];
  for (let i = 0; i <= 8; i++) { const t = i / 8; pts.push([0, 0, (0.5 - t) * Lb]); R.push(Math.max(0.025, 0.2 * c * Math.sin(Math.PI * Math.pow(t * 0.92 + 0.04, 0.85)))); }
  const segs = []; for (let i = 0; i < 8; i++) segs.push(roundCone(pts[i], pts[i + 1], R[i], R[i + 1]));
  const body = scale(union(segs, 0.02), 0.55, 1, 1);
  const tq = p.queue;
  const fin = (ang) => xform(ellipsoid(0, 0, 0, 0.015, 0.17 * tq, 0.11 * tq), rot('x', ang), [0, Math.sin(-ang) * 0.12 * tq, -0.5 * Lb - 0.08 * tq]);
  const list = [body, fin(40 * DEG), fin(-40 * DEG), ellipsoid(0, 0.17 * c, -0.02, 0.012, 0.11, 0.18 * Lb), mirrorX(ellipsoid(0.09 * c, -0.07, 0.17 * Lb, 0.09, 0.012, 0.06)),
    ellipsoid(0, -0.15 * c, -0.18 * Lb, 0.012, 0.06, 0.08), mirrorX(sphere(0.07 * c, 0.05, 0.37 * Lb * p.tete, 0.028 * p.tete))];
  return union(list, 0.02, true);
}
function animal(p, ctx) {
  let nd = p.espece === 'oiseau' ? bird(p) : p.espece === 'poisson' ? fish(p) : quadruped(p);
  const ext = Math.max(nd.bb[3] - nd.bb[0], nd.bb[4] - nd.bb[1], nd.bb[5] - nd.bb[2]);
  const s = p.taille / ext;
  const m = meshSDF(nd, { res: resOf(ctx, p.res) });
  const sc = xformMesh(m, [s, 0, 0, 0, s, 0, 0, 0, s], [0, 0, 0]);
  const bb = meshBounds(sc);
  const name = { chien: 'Chien', chat: 'Chat', cheval: 'Cheval', ours: 'Ours', lapin: 'Lapin', oiseau: 'Oiseau', poisson: 'Poisson' }[p.espece] || 'Animal';
  return [part(name, translateMesh(sc, [0, p.espece === 'poisson' ? -(bb[1] + bb[4]) / 2 : -bb[1], 0]))];
}

// ------------------------------------------------------------ squelettes de ZSpheres
const ZS_PARTS = ['Torse', 'Tête', 'Bras', 'Mains', 'Jambes', 'Pieds', 'Queue', 'Oreilles'];
// Ajoute le côté gauche par symétrie : chaque nœud marqué side 'R' est dupliqué (x → -x)
function mirrorSkeleton(nodes) {
  const map = new Map(), out = nodes.map((n) => ({ p: n.p.slice(), r: n.r, parent: n.parent, part: n.part }));
  nodes.forEach((n, i) => { if (n.side === 'R') { map.set(i, out.length); out.push({ p: [-n.p[0], n.p[1], n.p[2]], r: n.r, parent: n.parent, part: n.part }); } });
  for (const [src, dst] of map) { const par = nodes[src].parent; out[dst].parent = map.has(par) ? map.get(par) : par; }
  return out;
}
function zsHumanoid(p) {
  const H = p.taille, hu = H / p.tetes, B = H - hu, bu = B / 7, c = p.corpulence, rc = Math.sqrt(c);
  const sh = 1 + 0.12 * p.silhouette, hp = 1 - 0.1 * p.silhouette, chin = B;
  const N = [];
  const add3 = (pp, r, parent, part, side) => { N.push({ p: pp, r, parent, part, side }); return N.length - 1; };
  const pelvis = add3([0, chin - 3.0 * bu, -0.02 * bu], 0.6 * bu * hp * rc, -1, 0);
  const waist = add3([0, chin - 2.15 * bu, 0], 0.52 * bu * c, pelvis, 0);
  const chest = add3([0, chin - 1.25 * bu, 0], 0.68 * bu * sh * rc, waist, 0);
  const neck = add3([0, chin - 0.2 * bu, -0.03 * bu], 0.24 * bu * rc, chest, 1);
  const head = add3([0, H - 0.5 * hu, 0.04 * hu], 0.42 * hu, neck, 1);
  add3([0, H - 0.24 * hu, -0.01 * hu], 0.3 * hu, head, 1);
  const a = p.bras * DEG, S = [0.86 * bu * sh, chin - 0.72 * bu, -0.04 * bu];
  const d1 = [Math.sin(a), -Math.cos(a), 0], E = add(S, mul(d1, 1.5 * bu));
  const d2 = norm([Math.sin(a * 0.85), -Math.cos(a * 0.85), 0.25]), W = add(E, mul(d2, 1.2 * bu));
  const sR = add3(S, 0.3 * bu * rc, chest, 2, 'R'), eR = add3(E, 0.19 * bu * rc, sR, 2, 'R'), wR = add3(W, 0.12 * bu * rc, eR, 2, 'R');
  const hR = add3(add(W, mul(d2, 0.42 * bu)), 0.15 * bu, wR, 3, 'R'); add3(add(W, mul(d2, 0.82 * bu)), 0.09 * bu, hR, 3, 'R');
  const sp = p.jambes * DEG, Hip = [0.5 * bu * hp, chin - 3.25 * bu, 0], dl = [Math.sin(sp), -Math.cos(sp), 0];
  const Kn = add(Hip, mul(norm(add(dl, [0, 0, 0.03])), 2.0 * bu)), An = add(Kn, mul(norm(add(dl, [0, 0, -0.02])), 1.85 * bu));
  const hipR = add3(Hip, 0.42 * bu * rc, pelvis, 4, 'R'), kR = add3(Kn, 0.26 * bu * rc, hipR, 4, 'R'), aR = add3(An, 0.15 * bu * rc, kR, 4, 'R');
  add3(add(An, [0.03 * bu, -0.3 * bu, 0.85 * bu]), 0.12 * bu, aR, 5, 'R');
  return mirrorSkeleton(N);
}
function zsQuadruped(p) {
  const S = SPECIES[p.espece] || SPECIES.chien, c = p.corpulence, L = p.corps, legL = S.leg * p.pattes, legR = S.legR * Math.sqrt(c);
  const N = [];
  const add3 = (pp, r, parent, part, side) => { N.push({ p: pp, r, parent, part, side }); return N.length - 1; };
  const Hp = [0, legL * 0.95 + S.hip * 0.25, -0.45 * L], Cp = [0, legL + S.chest * 0.15, 0.45 * L];
  const pelvis = add3(Hp, S.hip * 0.95 * c, -1, 0);
  const mid = add3([0, (Hp[1] + Cp[1]) / 2 + 0.01, 0], (S.hip + S.chest) * 0.5 * c, pelvis, 0);
  const chest = add3(Cp, S.chest * c, mid, 0);
  const na = S.neckA * DEG, nd = [0, Math.sin(na), Math.cos(na)];
  const nb = add3(add(Cp, [0, S.chest * 0.55, S.chest * 0.45]), S.chest * 0.55 * Math.sqrt(c), chest, 1);
  const hr = S.head * p.tete, hc = add(N[nb].p, mul(nd, S.neck * p.cou + hr * 0.4));
  const head = add3(hc, hr, nb, 1);
  const fwd = norm([0, -0.3, 1]);
  add3(add(hc, mul(fwd, hr * 0.7 + S.muz * p.tete)), S.muzR * p.tete, head, 1);
  const ear = p.oreilles === 'auto' ? S.ears : p.oreilles, es = S.ear * p.tete;
  if (ear && ear !== 'aucune') {
    const base = add(hc, [hr * 0.5, hr * 0.62, -hr * 0.15]);
    const tip = ear === 'tombantes' ? add(base, [hr * 0.35, -es * 1.1, 0]) : ear === 'rondes' ? add(base, [es * 0.4, es * 0.5, 0]) : add(base, [es * 0.25, es, -es * 0.15]);
    add3(tip, ear === 'rondes' ? es * 0.45 : es * 0.18, head, 7, 'R');
  }
  const tl = S.tail * p.queue;
  if (tl > 0.08) {
    let pt = add(Hp, [0, S.hip * 0.45, -S.hip * 0.85]), prev = pelvis, ang = 15 * DEG;
    for (let i = 0; i < 3; i++) { ang += (S.curl * DEG) / 3; const r = S.tailR * (1 - i * 0.25); prev = add3(pt, r, prev, 6); pt = add(pt, [0, Math.sin(ang) * tl / 3, -Math.cos(ang) * tl / 3]); }
    add3(pt, S.tailR * 0.4, prev, 6);
  }
  const fs = [S.chest * 0.55 * c, Cp[1] - S.chest * 0.3, Cp[2] - 0.02], fe = [fs[0] * 0.95, legL * 0.42, Cp[2] - 0.05 * legL], fp = [fs[0] * 0.9, legR * 0.9, Cp[2] + 0.02];
  const f1 = add3(fs, legR * 1.7, chest, 2, 'R'), f2 = add3(fe, legR * 1.05, f1, 2, 'R'), f3 = add3(fp, legR * 1.0, f2, 5, 'R'); add3(add(fp, [0, -legR * 0.2, legR * 1.6]), legR * 0.75, f3, 5, 'R');
  const hs = [S.hip * 0.6 * c, Hp[1] - S.hip * 0.2, Hp[2] + 0.04], hk = [hs[0], hs[1] - legL * 0.36, hs[2] + 0.14 * legL], hh = [hs[0] * 0.95, legL * 0.28, hs[2] - 0.1 * legL], hpw = [hs[0] * 0.92, legR * 0.9, hs[2] - 0.01];
  const h1 = add3(hs, legR * 2.1, pelvis, 4, 'R'), h2 = add3(hk, legR * 1.3, h1, 4, 'R'), h3 = add3(hh, legR * 0.95, h2, 4, 'R'), h4 = add3(hpw, legR * 1.0, h3, 5, 'R');
  add3(add(hpw, [0, -legR * 0.2, legR * 1.6]), legR * 0.75, h4, 5, 'R');
  const s = p.taille / (L + S.head + S.muz + 0.3);
  return mirrorSkeleton(N).map((n) => ({ ...n, p: mul(n.p, s), r: n.r * s }));
}
function skinFigure(nodes, p, ctx, name, height) {
  const lv = ctx.preview ? Math.min(2, p.subdiv) : p.subdiv;
  const m = Surface.skinZSpheres(nodes, lv, { density: p.densite || 1, shape: p.mode === 'boites' ? 'box' : 'sphere', chamfer: p.chanfrein, profile: p.profilChanfrein });
  const bb = meshBounds(m), s = height ? height / (bb[4] - bb[1]) : 1;
  return [part(name, xformMesh(m, [s, 0, 0, 0, s, 0, 0, 0, s], [0, -bb[1] * s, 0]))];
}

// ------------------------------------------------------------ architecture
function archH(u, W, H) {
  const au = Math.min(Math.abs(u), W / 2);
  if (H <= W / 2 + 1e-9) { const R = (W * W / 4 + H * H) / (2 * H), cy = H - R; return cy + Math.sqrt(Math.max(0, R * R - au * au)); }
  const R = (W * W / 4 + H * H) / W, c = R - W / 2; return Math.sqrt(Math.max(0, R * R - (au + c) * (au + c)));
}
// Intérieur d'une baie : arc (plein cintre, brisé ou surbaissé) au-dessus des naissances (v = 0), piédroits dessous
function archInterior(u, v, W, H) {
  let d;
  if (H <= W / 2 + 1e-9) { const R = (W * W / 4 + H * H) / (2 * H), cy = H - R; d = Math.hypot(u, v - cy) - R; }
  else { const R = (W * W / 4 + H * H) / W, c = R - W / 2; d = Math.max(Math.hypot(u - c, v) - R, Math.hypot(u + c, v) - R); }
  return Math.min(Math.max(d, -v), Math.max(Math.abs(u) - W / 2, v));
}
function archCenter(u, W, H) {
  if (H <= W / 2 + 1e-9) { const R = (W * W / 4 + H * H) / (2 * H); return [0, H - R]; }
  const R = (W * W / 4 + H * H) / W, c = R - W / 2; return [u < 0 ? c : -c, 0];
}
function house(p, ctx) {
  const W = p.largeur, D = p.profondeur, nf = p.etages, hf = p.hauteurEtage, Hw = nf * hf, t = Math.tan(p.pente * DEG), ov = p.debord;
  const walls = [boxMM(-W / 2, 0, -D / 2, W / 2, Hw, D / 2), boxMM(-W / 2 - 0.08, 0, -D / 2 - 0.08, W / 2 + 0.08, 0.45, D / 2 + 0.08)];
  if (p.corniche) for (let f = 1; f <= nf; f++) walls.push(boxMM(-W / 2 - 0.12, f * hf - 0.22, -D / 2 - 0.12, W / 2 + 0.12, f * hf, D / 2 + 0.12));
  if (p.toit === 'deux') walls.push(node((x, y, z) => Math.max((y - Hw - (D / 2) * t + Math.abs(z) * t) / Math.sqrt(1 + t * t), Math.abs(x) - W / 2, Math.abs(z) - D / 2, Hw - 0.01 - y), [-W / 2, Hw, -D / 2, W / 2, Hw + (D / 2) * t, D / 2]));
  let body = union(walls);
  const holes = [], sills = [];
  const winW = Math.min(1.1, (W / Math.max(1, p.fenetres)) * 0.55), winH = Math.min(1.5, hf - 1.2);
  const facade = (axis, sign, count, span) => {
    for (let f = 0; f < nf; f++) for (let i = 0; i < count; i++) {
      const u = -span / 2 + (i + 0.5) * span / count, y0 = f * hf + 0.95;
      if (f === 0 && p.porte && axis === 'z' && sign > 0 && Math.abs(u) < winW * 0.9 + 0.6) continue;
      if (axis === 'z') { holes.push(boxMM(u - winW / 2, y0, sign * D / 2 - 0.2 * sign, u + winW / 2, y0 + winH, sign * (D / 2 + 1))); sills.push(boxMM(u - winW / 2 - 0.1, y0 - 0.08, sign * D / 2, u + winW / 2 + 0.1, y0, sign * (D / 2 + 0.12))); }
      else { holes.push(boxMM(sign * W / 2 - 0.2 * sign, y0, u - winW / 2, sign * (W / 2 + 1), y0 + winH, u + winW / 2)); sills.push(boxMM(sign * W / 2, y0 - 0.08, u - winW / 2 - 0.1, sign * (W / 2 + 0.12), y0, u + winW / 2 + 0.1)); }
    }
  };
  if (p.fenetres > 0) { facade('z', 1, p.fenetres, W); facade('z', -1, p.fenetres, W); const ns = Math.max(0, Math.round(p.fenetres * D / W)); if (ns) { facade('x', 1, ns, D); facade('x', -1, ns, D); } }
  if (p.porte) holes.push(boxMM(-0.6, 0.02, D / 2 - 0.25, 0.6, Math.min(2.3, hf - 0.4), D / 2 + 1));
  if (holes.length) body = sub(body, union(holes));
  if (sills.length) body = union([body, union(sills)]);
  let roof;
  const tr = 0.22;
  if (p.toit === 'plat') roof = union([boxMM(-W / 2 - ov, Hw, -D / 2 - ov, W / 2 + ov, Hw + 0.3, D / 2 + ov), sub(boxMM(-W / 2 - ov, Hw, -D / 2 - ov, W / 2 + ov, Hw + 1.0, D / 2 + ov), boxMM(-W / 2 - ov + 0.25, Hw + 0.2, -D / 2 - ov + 0.25, W / 2 + ov - 0.25, Hw + 2, D / 2 + ov - 0.25))]);
  else {
    const cs = 1 / Math.sqrt(1 + t * t);
    const pl = p.toit === 'deux' ? (x, y, z) => (y - Hw - (D / 2) * t + Math.abs(z) * t) * cs : (x, y, z) => Math.max(y - Hw - (D / 2) * t + Math.abs(z) * t, y - Hw - (W / 2) * t + Math.abs(x) * t) * cs;
    const top = Hw + (Math.min(D, p.toit === 'deux' ? D : Math.min(W, D)) / 2) * t;
    roof = node((x, y, z) => { const d = pl(x, y, z); return Math.max(-d, d - tr, Math.abs(x) - W / 2 - ov, Math.abs(z) - D / 2 - ov, Hw - ov * t - tr - y); }, [-W / 2 - ov, Hw - ov * t - tr, -D / 2 - ov, W / 2 + ov, top + tr, D / 2 + ov]);
    if (p.cheminee) roof = union([roof, boxMM(W * 0.22, Hw, -D * 0.15 - 0.35, W * 0.22 + 0.7, top + 0.9, -D * 0.15 + 0.35)]);
  }
  const ext = Math.max(W + 2 * ov, D + 2 * ov, Hw + 4), h = ext / resOf(ctx, p.res);
  return [part('Murs', meshSDF(body, { h })), part('Toit', meshSDF(roof, { h }))];
}
function arch(p, ctx) {
  const W = p.portee, hpi = p.piedroits, H = p.fleche * W, e = p.anneau, d = p.profondeur / 2, pw = p.pilier;
  const I = (x, y) => archInterior(x, y - hpi, W, H);
  let ring = node((x, y, z) => { const di = I(x, y); return Math.max(-di, di - e, hpi - y, Math.abs(z) - d); }, [-W / 2 - e, hpi, -d, W / 2 + e, hpi + H + e * 1.3, d]);
  if (p.claveaux > 1) {
    const N = 240, pts = [], cum = [0];
    for (let i = 0; i <= N; i++) { const u = -W / 2 + (i / N) * W; pts.push([u, hpi + archH(u, W, H)]); if (i) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])); }
    const Ltot = cum[N], g = p.joint * 1.5, grooves = [];
    for (let kq = 1; kq < p.claveaux; kq++) {
      const s = (kq / p.claveaux) * Ltot; let j = 0; while (j < N - 1 && cum[j + 1] < s) j++;
      const f = (s - cum[j]) / (cum[j + 1] - cum[j] || 1), Q = [pts[j][0] + (pts[j + 1][0] - pts[j][0]) * f, pts[j][1] + (pts[j + 1][1] - pts[j][1]) * f];
      const cc = archCenter(Q[0], W, H), C = [cc[0], hpi + cc[1]];
      const rd = norm([Q[0] - C[0], Q[1] - C[1], 0]), tg = [-rd[1], rd[0]];
      grooves.push(node((x, y, z) => Math.max(Math.abs((x - Q[0]) * tg[0] + (y - Q[1]) * tg[1]) - p.joint / 2, -((x - C[0]) * rd[0] + (y - C[1]) * rd[1])), [Math.min(Q[0], Q[0] + rd[0] * e * 2) - e, Math.min(Q[1], Q[1] + rd[1] * e * 2) - e, -d - 1, Math.max(Q[0], Q[0] + rd[0] * e * 2) + e, Math.max(Q[1], Q[1] + rd[1] * e * 2) + e, d + 1]));
    }
    const ringF = ring.f, G = union(grooves);
    ring = sub(ring, node((x, y, z) => Math.max(G.f(x, y, z), -(ringF(x, y, z) + g)), ring.bb));
  }
  const list = [ring];
  for (const s of [-1, 1]) {
    const x0 = s * W / 2, x1 = s * (W / 2 + pw);
    list.push(boxMM(Math.min(x0, x1), 0, -d, Math.max(x0, x1), hpi, d));
    list.push(boxMM(Math.min(x0, x1) - 0.08, hpi - 0.18, -d - 0.08, Math.max(x0, x1) + 0.08, hpi, d + 0.08));
    list.push(boxMM(Math.min(x0, x1) - 0.1, 0, -d - 0.1, Math.max(x0, x1) + 0.1, 0.35, d + 0.1));
  }
  if (p.cle) { const ap = hpi + H, kw = Math.max(0.15, (W * 1.6) / Math.max(5, p.claveaux) * 0.5); list.push(boxMM(-kw / 2, ap - 0.02, -d - 0.06, kw / 2, ap + e * 1.15 + 0.12, d + 0.06)); }
  const ext = Math.max(W + 2 * pw + 0.4, hpi + H + e + 0.4, p.mur ? Math.max(p.murL, p.murH) : 0);
  const h = ext / resOf(ctx, p.res);
  const parts = [part('Arche', meshSDF(union(list), { h }))];
  if (p.mur) {
    const wall = node((x, y, z) => Math.max(Math.abs(x) - p.murL / 2, -y, y - p.murH, Math.abs(z) - (d - 0.04), -(I(x, y) - e), -(Math.max(Math.abs(x) - W / 2 - pw, y - hpi))), [-p.murL / 2, 0, -d, p.murL / 2, p.murH, d]);
    parts.push(part('Mur', meshSDF(wall, { h })));
  }
  return parts;
}
function vault(p, ctx) {
  const W = p.largeur, Lb = p.travee, nb = p.travees, hp = p.hauteurPiliers, H = p.acuite * W, t = p.voutain, rr = p.nervure;
  const Lt = nb * Lb;
  const zl = (z) => { const zz = clamp(z, -Lt / 2, Lt / 2) + Lt / 2; const i = Math.min(nb - 1, Math.floor(zz / Lb)); return z - (-Lt / 2 + (i + 0.5) * Lb); };
  const dInt = (x, y, z) => Math.min(archInterior(x, y - hp, W, H), archInterior(zl(z), y - hp, Lb, H));
  const Hm = H + t + 0.2;
  const shell = node((x, y, z) => { const di = dInt(x, y, z); return Math.max(-di, di - t, Math.abs(x) - W / 2 - t, Math.abs(z) - Lt / 2 - t * 0.5, hp - y); }, [-W / 2 - t, hp, -Lt / 2 - t, W / 2 + t, hp + Hm + Math.max(0, Lb / 2 - H), Lt / 2 + t]);
  const ribs = [];
  const chain = (pts) => { for (let i = 0; i + 1 < pts.length; i++) ribs.push(capsule(pts[i], pts[i + 1], rr)); };
  const NS = ctx.preview ? 12 : 22;
  for (let b = 0; b < nb; b++) {
    const zc = -Lt / 2 + (b + 0.5) * Lb;
    for (const sgn of [1, -1]) { const pts = []; for (let i = 0; i <= NS; i++) { const s = -1 + (2 * i) / NS, x = (s * W) / 2, z = zc + sgn * (s * Lb) / 2; pts.push([x, hp + Math.max(archH(x, W, H), archH((s * Lb) / 2, Lb, H)) - rr * 0.3, z]); } chain(pts); }
    for (const sx of [-1, 1]) { const pts = []; for (let i = 0; i <= NS; i++) { const u = -Lb / 2 + (i / NS) * Lb; pts.push([sx * W / 2, hp + archH(u, Lb, H) - rr * 0.3, zc + u]); } chain(pts); }
    if (p.cle) { ribs.push(sphere(0, hp + H - rr * 0.6, zc, rr * 2.2)); ribs.push(torus('y', 0, hp + H - rr * 1.6, zc, rr * 2.0, rr * 0.7)); }
  }
  for (let b = 0; b <= nb; b++) { const z = -Lt / 2 + b * Lb, pts = []; for (let i = 0; i <= NS; i++) { const u = -W / 2 + (i / NS) * W; pts.push([u, hp + archH(u, W, H) - rr * 0.3, z]); } chain(pts); }
  const piers = [];
  const rp = p.pilier;
  for (let b = 0; b <= nb; b++) for (const sx of [-1, 1]) {
    const x = sx * W / 2, z = -Lt / 2 + b * Lb;
    const list = [cyl('y', x, 0, z, rp, 0, hp, 0.02), cyl('y', x, 0, z, rp * 1.3, 0, 0.45, 0.04), boxMM(x - rp * 1.45, 0, z - rp * 1.45, x + rp * 1.45, 0.22, z + rp * 1.45),
      roundCone([x, hp - 0.55, z], [x, hp - 0.05, z], rp * 1.02, rp * 1.45), boxMM(x - rp * 1.55, hp - 0.08, z - rp * 1.55, x + rp * 1.55, hp + 0.05, z + rp * 1.55)];
    if (p.colonnettes) for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) list.push(cyl('y', x + dx * rp * 0.72, 0, z + dz * rp * 0.72, rp * 0.32, 0.2, hp - 0.4, 0.03));
    piers.push(union(list, 0.03));
  }
  const ext = Math.max(W + 2 * rp + 1, Lt + 2 * rp + 1, hp + H + 1), h = ext / resOf(ctx, p.res);
  return [part('Voûtains', meshSDF(shell, { h })), part('Nervures', meshSDF(union(ribs, 0.02), { h })), part('Piliers', meshSDF(union(piers), { h }))];
}

// ------------------------------------------------------------ catalogue
const P_BOX = (cond) => [{ key: 'chanfrein', label: 'Chanfrein', type: 'range', min: 0, max: 0.4, step: 0.01, def: 0.15, fmt: (v) => Math.round(v * 100) + ' %', show: (v) => v.mode === 'boites' && cond(v) },
  { key: 'profilChanfrein', label: 'Profil du chanfrein', type: 'select', def: 'arrondi', options: [['arrondi', 'Arrondi'], ['plat', 'Plat (arêtes vives)']], show: (v) => v.mode === 'boites' && cond(v) }];
const CATALOG = [
  { id: 'chevaliere', cat: 'bijoux', name: 'Chevalière', unit: 'mm', desc: 'Bague à plateau, taille réelle, monogramme gravé ou en relief. Surfacique (quads) ou volumique.', build: (p, ctx) => (p.mode === 'volume' ? signet(p, ctx) : signetSurface(p, ctx)),
    params: [{ key: 'mode', label: 'Modélisation', type: 'select', def: 'surface', options: [['surface', 'Surfacique (quads subdivisés)'], ['volume', 'Volumique (voxels)']] }, ...P_RING, ...P_PLATE, { key: 'plateauH', label: 'Hauteur plateau', type: 'range', min: 2.5, max: 8, step: 0.1, def: 4, unit: 'mm' },
      { key: 'bombe', label: 'Bombé', type: 'range', min: 0, max: 2, step: 0.05, def: 0.3, unit: 'mm' }, { key: 'depouille', label: 'Évasement', type: 'range', min: 0, max: 0.4, step: 0.01, def: 0.15 },
      { key: 'epaule', label: 'Épaules', type: 'range', min: 0.5, max: 5, step: 0.1, def: 2.2, unit: 'mm' },
      { key: 'arete', label: 'Netteté des arêtes', type: 'range', min: 0.05, max: 1.2, step: 0.05, def: 0.25, unit: 'mm', show: (v) => v.mode !== 'volume' },
      ...P_TEXT, { key: 'subdiv', label: 'Subdivisions', type: 'range', min: 1, max: 5, step: 1, def: 3, show: (v) => v.mode !== 'volume' }, { ...P_RES(200), show: (v) => v.mode === 'volume' }] },
  { id: 'chevaliere-clapet', cat: 'bijoux', name: 'Chevalière à clapet', unit: 'mm', desc: 'Plateau creux à couvercle articulé : anneau, clapet et goupille séparés.', build: signetLocket,
    params: [...P_RING, ...P_PLATE.map((q) => (q.key === 'plateauW' ? { ...q, def: 13 } : q.key === 'plateauL' ? { ...q, def: 15 } : q)),
      { key: 'plateauH', label: 'Hauteur plateau', type: 'range', min: 4, max: 10, step: 0.1, def: 6, unit: 'mm' }, { key: 'couvercle', label: 'Épaisseur clapet', type: 'range', min: 1, max: 2.5, step: 0.05, def: 1.4, unit: 'mm' },
      { key: 'paroi', label: 'Paroi', type: 'range', min: 0.6, max: 1.6, step: 0.05, def: 0.8, unit: 'mm' }, { key: 'cavite', label: 'Profondeur cavité', type: 'range', min: 1, max: 6, step: 0.1, def: 3, unit: 'mm' },
      { key: 'jeu', label: 'Jeu de charnière', type: 'range', min: 0.05, max: 0.4, step: 0.01, def: 0.15, unit: 'mm' }, { key: 'ouverture', label: 'Ouverture', type: 'range', min: 0, max: 120, step: 1, def: 35, unit: '°', live: true },
      { key: 'bombe', label: 'Bombé', type: 'range', min: 0, max: 1.5, step: 0.05, def: 0.3, unit: 'mm' }, { key: 'depouille', label: 'Évasement', type: 'range', min: 0, max: 0.3, step: 0.01, def: 0.1 },
      { key: 'epaule', label: 'Épaules', type: 'range', min: 0.5, max: 5, step: 0.1, def: 2.2, unit: 'mm' }, ...P_TEXT.map((q) => (q.key === 'texte' ? { ...q, def: 'A' } : q)), P_RES(240, 120, 360)] },
  { id: 'collier', cat: 'bijoux', name: 'Collier', unit: 'mm', desc: 'Chaîne à maillons entrelacés, fermoir, bélière et pendentif.', build: necklace,
    params: [{ key: 'longueur', label: 'Longueur', type: 'range', min: 350, max: 800, step: 10, def: 450, unit: 'mm' },
      { key: 'maille', label: 'Maille', type: 'select', def: 'forcat', options: [['forcat', 'Forçat'], ['ronde', 'Ronde'], ['allongee', 'Forçat allongée']] },
      { key: 'maillon', label: 'Longueur maillon', type: 'range', min: 2.5, max: 10, step: 0.1, def: 4.5, unit: 'mm' }, { key: 'fil', label: 'Fil', type: 'range', min: 0.4, max: 1.8, step: 0.05, def: 0.8, unit: 'mm' },
      { key: 'chute', label: 'Chute en V', type: 'range', min: 0, max: 1, step: 0.05, def: 0.35 }, { key: 'fermoir', label: 'Fermoir', type: 'check', def: true },
      { key: 'pendentif', label: 'Pendentif', type: 'select', def: 'coeur', options: [['coeur', 'Cœur'], ['goutte', 'Goutte'], ['medaille', 'Médaille'], ['losange', 'Losange'], ['etoile', 'Étoile'], ['aucun', 'Aucun']] },
      { key: 'taillePend', label: 'Taille pendentif', type: 'range', min: 6, max: 45, step: 0.5, def: 18, unit: 'mm', show: (v) => v.pendentif !== 'aucun' },
      { key: 'epaisseurPend', label: 'Épaisseur', type: 'range', min: 0.8, max: 6, step: 0.1, def: 2.2, unit: 'mm', show: (v) => v.pendentif !== 'aucun' },
      { key: 'bombePend', label: 'Bombé', type: 'range', min: 0, max: 1, step: 0.05, def: 0.6, show: (v) => v.pendentif !== 'aucun' }, P_RES(160, 80, 280)] },
  { id: 'boucle', cat: 'bijoux', name: 'Boucle d’oreille', unit: 'mm', desc: 'Créole, pendante à crochet ou puce à collet, à l’unité ou par paire.', build: earring,
    params: [{ key: 'modele', label: 'Modèle', type: 'select', def: 'pendante', options: [['creole', 'Créole'], ['pendante', 'Pendante'], ['puce', 'Puce']] },
      { key: 'diametre', label: 'Diamètre', type: 'range', min: 10, max: 60, step: 1, def: 24, unit: 'mm', show: (v) => v.modele === 'creole' },
      { key: 'epaisseur', label: 'Épaisseur', type: 'range', min: 1, max: 6, step: 0.1, def: 2.5, unit: 'mm', show: (v) => v.modele === 'creole' },
      { key: 'profil', label: 'Profil', type: 'select', def: 'demi-rond', options: [['rond', 'Rond'], ['demi-rond', 'Demi-rond'], ['carre', 'Carré'], ['plat', 'Plat']], show: (v) => v.modele === 'creole' },
      { key: 'forme', label: 'Pampille', type: 'select', def: 'goutte', options: [['goutte', 'Goutte'], ['coeur', 'Cœur'], ['medaille', 'Médaille'], ['losange', 'Losange'], ['etoile', 'Étoile']], show: (v) => v.modele === 'pendante' },
      { key: 'taille', label: 'Taille pampille', type: 'range', min: 5, max: 35, step: 0.5, def: 14, unit: 'mm', show: (v) => v.modele === 'pendante' },
      { key: 'epaisseurPend', label: 'Épaisseur', type: 'range', min: 0.8, max: 6, step: 0.1, def: 2.4, unit: 'mm', show: (v) => v.modele === 'pendante' },
      { key: 'bombe', label: 'Bombé', type: 'range', min: 0, max: 1, step: 0.05, def: 0.9, show: (v) => v.modele === 'pendante' },
      { key: 'pierre', label: 'Pierre', type: 'select', def: 'ronde', options: [['ronde', 'Ronde'], ['ovale', 'Ovale'], ['carree', 'Carrée']], show: (v) => v.modele === 'puce' },
      { key: 'tailleP', label: 'Taille pierre', type: 'range', min: 3, max: 12, step: 0.25, def: 6, unit: 'mm', show: (v) => v.modele === 'puce' },
      { key: 'paire', label: 'Paire (symétrique)', type: 'check', def: true }, P_RES(180, 80, 300)] },
  { id: 'bracelet-clapet', cat: 'bijoux', name: 'Bracelet à clapet', unit: 'mm', desc: 'Jonc ovale ouvrant : charnière à goupille, fermoir à languette, ouverture réglable.', build: bangle,
    params: [{ key: 'largeurInt', label: 'Largeur intérieure', type: 'range', min: 48, max: 72, step: 0.5, def: 60, unit: 'mm' }, { key: 'hauteurInt', label: 'Hauteur intérieure', type: 'range', min: 38, max: 62, step: 0.5, def: 50, unit: 'mm' },
      { key: 'largeurJonc', label: 'Largeur du jonc', type: 'range', min: 4, max: 30, step: 0.5, def: 10, unit: 'mm' }, { key: 'epaisseur', label: 'Épaisseur', type: 'range', min: 1.5, max: 4.5, step: 0.1, def: 2.5, unit: 'mm' },
      { key: 'bombe', label: 'Bombé', type: 'range', min: 0, max: 1, step: 0.05, def: 0.5 }, { key: 'jeu', label: 'Jeu de charnière', type: 'range', min: 0.05, max: 0.4, step: 0.01, def: 0.15, unit: 'mm' },
      { key: 'fermoir', label: 'Fermoir à languette', type: 'check', def: true }, { key: 'ouverture', label: 'Ouverture', type: 'range', min: 0, max: 110, step: 1, def: 25, unit: '°', live: true }, P_RES(260, 120, 400)] },
  { id: 'humanoide', cat: 'figures', name: 'Humanoïde', unit: 'cm', desc: 'Mannequin proportionné : squelette de ZSpheres éditable et peau en quads, ou volume.', zs: true,
    build: (p, ctx) => (p.mode === 'volume' ? humanoid(p, ctx) : skinFigure(zsHumanoid(p), p, ctx, 'Humanoïde', p.taille)),
    params: [{ key: 'mode', label: 'Modélisation', type: 'select', def: 'zspheres', options: [['zspheres', 'ZSpheres (peau en quads)'], ['boites', 'Boîtes chanfreinées (quads)'], ['volume', 'Volumique (voxels)']] }, { key: 'taille', label: 'Taille', type: 'range', min: 5, max: 200, step: 1, def: 30, unit: 'cm' }, { key: 'tetes', label: 'Hauteur en têtes', type: 'range', min: 2.5, max: 8.5, step: 0.25, def: 7.5 },
      { key: 'corpulence', label: 'Corpulence', type: 'range', min: 0.6, max: 1.6, step: 0.05, def: 1 }, { key: 'silhouette', label: 'Hanches ↔ épaules', type: 'range', min: -1, max: 1, step: 0.05, def: 0 },
      { key: 'bras', label: 'Ouverture des bras', type: 'range', min: 0, max: 95, step: 1, def: 35, unit: '°' }, { key: 'jambes', label: 'Écart des jambes', type: 'range', min: 0, max: 30, step: 1, def: 6, unit: '°' },
      { key: 'lissage', label: 'Fondu des jonctions', type: 'range', min: 0.2, max: 2.5, step: 0.05, def: 1, show: (v) => v.mode === 'volume' }, { key: 'visage', label: 'Ébauche du visage', type: 'check', def: true, show: (v) => v.mode === 'volume' },
      { key: 'subdiv', label: 'Subdivisions', type: 'range', min: 1, max: 4, step: 1, def: 3, show: (v) => v.mode !== 'volume' }, { key: 'densite', label: 'Densité des liens', type: 'range', min: 0.5, max: 2.5, step: 0.1, def: 1, show: (v) => v.mode === 'zspheres' },
      ...P_BOX(() => true), { ...P_RES(200), show: (v) => v.mode === 'volume' }] },
  { id: 'animal', cat: 'figures', name: 'Animal', unit: 'cm', desc: 'Chien, chat, cheval, ours, lapin, oiseau ou poisson. Quadrupèdes en ZSpheres éditables ou en volume.', zs: (v) => !['oiseau', 'poisson'].includes(v.espece) && v.mode !== 'volume',
    build: (p, ctx) => (p.mode === 'volume' || ['oiseau', 'poisson'].includes(p.espece) ? animal(p, ctx) : skinFigure(zsQuadruped(p), p, ctx, { chien: 'Chien', chat: 'Chat', cheval: 'Cheval', ours: 'Ours', lapin: 'Lapin' }[p.espece] || 'Animal')),
    params: [{ key: 'mode', label: 'Modélisation', type: 'select', def: 'zspheres', options: [['zspheres', 'ZSpheres (peau en quads)'], ['boites', 'Boîtes chanfreinées (quads)'], ['volume', 'Volumique (voxels)']], show: (v) => !['oiseau', 'poisson'].includes(v.espece) }, { key: 'espece', label: 'Espèce', type: 'select', def: 'chien', options: [['chien', 'Chien'], ['chat', 'Chat'], ['cheval', 'Cheval'], ['ours', 'Ours'], ['lapin', 'Lapin'], ['oiseau', 'Oiseau'], ['poisson', 'Poisson']] },
      { key: 'taille', label: 'Taille', type: 'range', min: 5, max: 200, step: 1, def: 30, unit: 'cm' }, { key: 'corps', label: 'Longueur du corps', type: 'range', min: 0.6, max: 1.6, step: 0.05, def: 1 },
      { key: 'pattes', label: 'Pattes', type: 'range', min: 0.5, max: 1.6, step: 0.05, def: 1, show: (v) => v.espece !== 'poisson' }, { key: 'cou', label: 'Cou', type: 'range', min: 0.3, max: 2, step: 0.05, def: 1, show: (v) => !['oiseau', 'poisson'].includes(v.espece) },
      { key: 'tete', label: 'Tête', type: 'range', min: 0.6, max: 1.6, step: 0.05, def: 1 }, { key: 'queue', label: 'Queue', type: 'range', min: 0, max: 2, step: 0.05, def: 1 },
      { key: 'corpulence', label: 'Corpulence', type: 'range', min: 0.6, max: 1.6, step: 0.05, def: 1 },
      { key: 'oreilles', label: 'Oreilles', type: 'select', def: 'auto', options: [['auto', 'Selon l’espèce'], ['pointues', 'Pointues'], ['rondes', 'Rondes'], ['tombantes', 'Tombantes'], ['longues', 'Longues'], ['aucune', 'Aucune']], show: (v) => !['oiseau', 'poisson'].includes(v.espece) },
      { key: 'subdiv', label: 'Subdivisions', type: 'range', min: 1, max: 4, step: 1, def: 3, show: (v) => v.mode !== 'volume' && !['oiseau', 'poisson'].includes(v.espece) },
      { key: 'densite', label: 'Densité des liens', type: 'range', min: 0.5, max: 2.5, step: 0.1, def: 1, show: (v) => v.mode === 'zspheres' && !['oiseau', 'poisson'].includes(v.espece) },
      ...P_BOX((v) => !['oiseau', 'poisson'].includes(v.espece)),
      { ...P_RES(180), show: (v) => v.mode === 'volume' || ['oiseau', 'poisson'].includes(v.espece) }] },
  { id: 'maison', cat: 'batiments', name: 'Bâtiment simple', unit: 'm', desc: 'Maison ou immeuble : étages, fenêtres avec appuis, porte, corniches, toit.', build: house,
    params: [{ key: 'largeur', label: 'Largeur', type: 'range', min: 4, max: 24, step: 0.5, def: 10, unit: 'm' }, { key: 'profondeur', label: 'Profondeur', type: 'range', min: 4, max: 16, step: 0.5, def: 8, unit: 'm' },
      { key: 'etages', label: 'Niveaux', type: 'range', min: 1, max: 6, step: 1, def: 2 }, { key: 'hauteurEtage', label: 'Hauteur d’étage', type: 'range', min: 2.5, max: 4.5, step: 0.1, def: 3, unit: 'm' },
      { key: 'toit', label: 'Toit', type: 'select', def: 'deux', options: [['deux', 'Deux pans'], ['quatre', 'Quatre pans'], ['plat', 'Toit-terrasse']] }, { key: 'pente', label: 'Pente', type: 'range', min: 10, max: 60, step: 1, def: 35, unit: '°', show: (v) => v.toit !== 'plat' },
      { key: 'debord', label: 'Débord', type: 'range', min: 0, max: 1, step: 0.05, def: 0.4, unit: 'm' }, { key: 'fenetres', label: 'Fenêtres par façade', type: 'range', min: 0, max: 8, step: 1, def: 3 },
      { key: 'porte', label: 'Porte', type: 'check', def: true }, { key: 'corniche', label: 'Corniches', type: 'check', def: true }, { key: 'cheminee', label: 'Cheminée', type: 'check', def: true, show: (v) => v.toit !== 'plat' }, P_RES(220, 96, 360)] },
  { id: 'arche', cat: 'batiments', name: 'Arche', unit: 'm', desc: 'Arc plein cintre, brisé ou surbaissé, claveaux, clé saillante, mur optionnel.', build: arch,
    params: [{ key: 'portee', label: 'Portée', type: 'range', min: 1, max: 12, step: 0.1, def: 4, unit: 'm' }, { key: 'piedroits', label: 'Hauteur des piédroits', type: 'range', min: 0.5, max: 8, step: 0.1, def: 3, unit: 'm' },
      { key: 'fleche', label: 'Flèche / portée', type: 'range', min: 0.2, max: 1, step: 0.01, def: 0.5, fmt: (v) => v.toFixed(2) + (v < 0.49 ? ' · surbaissé' : v > 0.51 ? ' · brisé' : ' · plein cintre') },
      { key: 'anneau', label: 'Épaisseur de l’arc', type: 'range', min: 0.2, max: 1.5, step: 0.05, def: 0.6, unit: 'm' }, { key: 'profondeur', label: 'Profondeur', type: 'range', min: 0.3, max: 3, step: 0.05, def: 0.8, unit: 'm' },
      { key: 'pilier', label: 'Largeur des piédroits', type: 'range', min: 0.3, max: 2, step: 0.05, def: 0.8, unit: 'm' }, { key: 'claveaux', label: 'Claveaux', type: 'range', min: 0, max: 25, step: 1, def: 13 },
      { key: 'joint', label: 'Joint', type: 'range', min: 0.01, max: 0.08, step: 0.005, def: 0.03, unit: 'm', show: (v) => v.claveaux > 1 }, { key: 'cle', label: 'Clé saillante', type: 'check', def: true },
      { key: 'mur', label: 'Mur autour', type: 'check', def: false }, { key: 'murL', label: 'Largeur du mur', type: 'range', min: 4, max: 30, step: 0.5, def: 10, unit: 'm', show: (v) => v.mur },
      { key: 'murH', label: 'Hauteur du mur', type: 'range', min: 3, max: 20, step: 0.5, def: 7, unit: 'm', show: (v) => v.mur }, P_RES(220, 96, 360)] },
  { id: 'voute', cat: 'batiments', name: 'Voûte néo-gothique', unit: 'm', desc: 'Croisée d’ogives quadripartite : voûtains, nervures, clés et piliers fasciculés.', build: vault,
    params: [{ key: 'largeur', label: 'Largeur de nef', type: 'range', min: 3, max: 16, step: 0.5, def: 6, unit: 'm' }, { key: 'travee', label: 'Longueur de travée', type: 'range', min: 3, max: 12, step: 0.5, def: 5, unit: 'm' },
      { key: 'travees', label: 'Travées', type: 'range', min: 1, max: 5, step: 1, def: 2 }, { key: 'hauteurPiliers', label: 'Hauteur des piliers', type: 'range', min: 2, max: 18, step: 0.5, def: 6, unit: 'm' },
      { key: 'acuite', label: 'Acuité des arcs', type: 'range', min: 0.5, max: 1.1, step: 0.01, def: 0.75, fmt: (v) => v.toFixed(2) + (v < 0.52 ? ' · plein cintre' : v > 0.84 && v < 0.9 ? ' · équilatéral' : ' · brisé') },
      { key: 'voutain', label: 'Épaisseur voûtains', type: 'range', min: 0.1, max: 0.6, step: 0.01, def: 0.22, unit: 'm' }, { key: 'nervure', label: 'Rayon des nervures', type: 'range', min: 0.05, max: 0.4, step: 0.01, def: 0.14, unit: 'm' },
      { key: 'pilier', label: 'Rayon des piliers', type: 'range', min: 0.2, max: 1, step: 0.02, def: 0.4, unit: 'm' }, { key: 'colonnettes', label: 'Piliers fasciculés', type: 'check', def: true },
      { key: 'cle', label: 'Clés de voûte', type: 'check', def: true }, P_RES(200, 96, 320)] },
];
const CATEGORIES = [{ id: 'bijoux', label: 'Bijoux', code: 'Bj', unit: 'mm' }, { id: 'figures', label: 'Figures', code: 'Fg', unit: 'cm' }, { id: 'batiments', label: 'Bâtiments', code: 'Bt', unit: 'm' }];
function defaults(id) { const s = CATALOG.find((x) => x.id === id); const v = {}; for (const q of s.params) v[q.key] = q.def; return v; }
function build(id, values, ctx = {}) {
  const s = CATALOG.find((x) => x.id === id);
  const v = Object.assign(defaults(id), values || {});
  return s.build(v, ctx).filter((pt) => pt.mesh && pt.mesh.nv > 0 && pt.mesh.idx.length > 0);
}

function skeleton(id, values) {
  const v = Object.assign(defaults(id), values || {});
  if (id === 'humanoide') return zsHumanoid(v);
  if (id === 'animal' && !['oiseau', 'poisson'].includes(v.espece)) return zsQuadruped(v);
  return null;
}
// Esquisses éditables d'un modèle (null si le modèle n'en a pas dans ce mode)
function sketches(id, values) {
  const v = Object.assign(defaults(id), values || {});
  if (id !== 'chevaliere' || v.mode === 'volume') return null;
  const sk = signetSketches(v), E = sketchEval(sk);
  return { face: sk.face, cote: sk.cote, dessus: sk.dessus, custom: sk.custom, ri: sk.base.ri, yBot: sk.base.yBot, a: E.a, b: E.b, yTop: E.yTop };
}
const Samples = { CATALOG, CATEGORIES, ZS_PARTS, defaults, build, skeleton, sketches, archInterior, archH };
root.Samples = Samples;
if (typeof module !== 'undefined' && module.exports) module.exports = Samples;
})(typeof window !== 'undefined' ? window : globalThis);
