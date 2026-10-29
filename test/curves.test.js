const Core = require('../src/core.js');
const C = require('../src/curves.js');
const assert = (c, m) => { if (!c) { console.error('ÉCHEC:', m); process.exitCode = 1; } else console.log('ok -', m); };
const { sub, len, dot, norm, cross } = C.v;

function closedManifold(m) {
  const E = Core.buildEdges(m.idx, m.nv); let bad = 0;
  for (let e = 0; e < E.ne; e++) if (E.ecount[e] !== 2) bad++;
  return { bad, euler: m.nv - E.ne + m.idx.length / 3 };
}
const volume = (m) => Core.fixOrientation(m.pos, m.idx.slice()) / 6;
const maxDev = (c, pts) => { const dense = C.polyline(c, 64); let mx = 0; for (const p of pts) { let b = Infinity; for (const q of dense) b = Math.min(b, len(sub(p, q))); mx = Math.max(mx, b); } return mx; };

// ---------- ajustement
const circ = Array.from({ length: 200 }, (_, i) => { const a = i / 200 * Math.PI * 2; return [Math.cos(a), Math.sin(a), 0]; });
const fc = C.fitPath(circ, 0.01, true);
const cc = C.makeCurve('shape', fc, true);
assert(fc.length >= 3 && fc.length <= 12 && fc.every((a) => a.smooth), 'cercle : ' + fc.length + ' ancres lisses');
assert(maxDev(cc, circ) < 0.02, 'cercle : écart max ' + maxDev(cc, circ).toFixed(4));

const sq = []; const corners = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
for (let s = 0; s < 4; s++) for (let i = 0; i < 50; i++) { const a = corners[s], b = corners[(s + 1) % 4]; sq.push([a[0] + (b[0] - a[0]) * i / 50, a[1] + (b[1] - a[1]) * i / 50, 0]); }
const fs = C.fitPath(sq, 0.01, true);
const sharp = fs.filter((a) => !a.smooth);
assert(sharp.length === 4, 'carré : 4 coins vifs détectés (' + sharp.length + ' sur ' + fs.length + ' ancres)');
assert(sharp.every((a) => corners.some((k) => len(sub(a.p, k)) < 0.04)), 'carré : coins au bon endroit');
const sqC = C.makeCurve('shape', fs, true);
assert(maxDev(sqC, sq) < 0.02, 'carré : écart max ' + maxDev(sqC, sq).toFixed(4));

const wave = Array.from({ length: 120 }, (_, i) => [i / 60, Math.sin(i / 120 * Math.PI * 3) * 0.4, 0]);
const fw = C.fitPath(wave, 0.005, false);
const wc = C.makeCurve('sweep', fw, false);
assert(len(sub(fw[0].p, wave[0])) < 1e-6 && len(sub(fw[fw.length - 1].p, wave[119])) < 1e-6, 'courbe ouverte : extrémités exactes');
assert(maxDev(wc, wave) < 0.01, 'vague : écart max ' + maxDev(wc, wave).toFixed(4) + ' avec ' + fw.length + ' ancres');

// ---------- édition
const n0 = wc.pts.length;
const seg1 = C.segment(wc, 1).map((p) => p.slice());
const k = C.splitAt(wc, 1, 0.37);
let errSplit = 0;
for (let i = 0; i <= 20; i++) {
  const t = i / 20, q = C.bez(seg1, t);
  const r = t <= 0.37 ? C.bez(C.segment(wc, 1), t / 0.37) : C.bez(C.segment(wc, 2), (t - 0.37) / 0.63);
  errSplit = Math.max(errSplit, len(sub(q, r)));
}
assert(wc.pts.length === n0 + 1 && errSplit < 1e-9, 'insertion d’ancre sans déformer la courbe (écart ' + errSplit.toExponential(1) + ')');
C.moveHandle(wc, k, 'o', [wc.pts[k].p[0] + 0.1, wc.pts[k].p[1] + 0.2, 0]);
const A = wc.pts[k]; const d1 = norm(sub(A.o, A.p)), d2 = norm(sub(A.i, A.p));
assert(dot(d1, d2) < -0.999, 'ancre lisse : poignées restent alignées');
C.setSmooth(wc, k, false);
assert(len(sub(wc.pts[k].o, wc.pts[k].p)) === 0, 'ancre anguleuse : poignées rétractées');
assert(C.removeAnchor(wc, k) && wc.pts.length === n0, 'suppression d’ancre');
const proj = (p) => [p[0] * 100, -p[1] * 100];
const nr = C.nearest(wc, proj, 50, -C.bez(C.segment(wc, 0), 0.5)[1] * 100);
assert(nr.d < 30, 'recherche du point le plus proche (' + nr.d.toFixed(1) + ' px)');

// ---------- plan moyen
const nTilt = norm([0.3, 1, 0.2]); const u0 = norm(cross(nTilt, [0, 0, 1])), v0 = cross(nTilt, u0);
const tilted = Array.from({ length: 50 }, (_, i) => { const a = i / 50 * 6.28; return [0.5 + u0[0] * Math.cos(a) + v0[0] * Math.sin(a) * 0.5, 0.2 + u0[1] * Math.cos(a) + v0[1] * Math.sin(a) * 0.5, u0[2] * Math.cos(a) + v0[2] * Math.sin(a) * 0.5]; });
const pl = C.fitPlane(tilted, [0, 1, 0]);
assert(dot(pl.n, nTilt) > 0.9999, 'plan moyen : normale retrouvée et orientée');
assert(Math.abs(dot(cross(pl.u, pl.v), pl.n) - 1) < 1e-9, 'plan moyen : repère direct');

// ---------- triangulation
const star = C.profilePoly('star', 10);
const tri = C.earClip(star);
let at = 0; for (let q = 0; q < tri.length; q += 3) { const a = star[tri[q]], b = star[tri[q + 1]], c = star[tri[q + 2]]; at += ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2; }
assert(tri.length / 3 === star.length - 2 && Math.abs(at - C.area2(star)) < 1e-9, 'triangulation de l’étoile : ' + tri.length / 3 + ' triangles, aire exacte');

// ---------- balayage
const line = C.makeCurve('sweep', [C.anchor([0, 0, 0], null, [0.33, 0, 0]), C.anchor([1, 0, 0], [0.66, 0, 0], null)], false, { params: { radius: 0.1, sides: 32 } });
const m1 = C.sweepMesh(line);
const t1 = closedManifold(m1);
assert(t1.bad === 0 && t1.euler === 2, 'cylindre fermé (genre 0)');
const vcyl = volume(m1), vexp = Math.PI * 0.01 * 1 * (32 / (2 * Math.PI)) * Math.sin(2 * Math.PI / 32);
assert(Math.abs(vcyl - vexp) / vexp < 0.02, 'cylindre : volume ' + vcyl.toFixed(4) + ' ≈ ' + vexp.toFixed(4));
const loop = C.makeCurve('sweep', C.fitPath(circ, 0.005, true), true, { params: { radius: 0.1, profile: 'square', sides: 8 } });
const m2 = C.sweepMesh(loop); const t2 = closedManifold(m2);
assert(t2.bad === 0 && t2.euler === 0, 'boucle fermée avec profil carré : tore (genre 1)');
const fancy = C.makeCurve('sweep', C.clone(fw), false, { params: { radius: 0.05, profile: 'star', sides: 20, taperStart: 0.2, taperEnd: 1.5, twist: 180, aspect: 2 } });
fancy.up = [0, 0, 1];
const m3 = C.sweepMesh(fancy); const t3 = closedManifold(m3);
assert(t3.bad === 0 && t3.euler === 2 && volume(m3) > 0, 'étoile effilée et torsadée : fermée, normales extérieures');
const flatShape = C.makeCurve('shape', fs, true, { plane: { o: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] } });
const custom = C.profilePoly('shape', 24, flatShape);
assert(custom.length >= 24 && C.area2(custom) > 3, 'profil personnalisé tiré d’une forme (aire ' + C.area2(custom).toFixed(2) + ')');
const m4 = C.bake({ ...line, params: { ...line.params, profile: 'shape', profileRef: flatShape.id } }, [flatShape]);
assert(closedManifold(m4).bad === 0, 'balayage avec profil personnalisé');

// ---------- forme → solide
const XY = { o: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] };
const sqShape = C.makeCurve('shape', fs, true, { plane: XY, params: { thickness: 0.2, bevel: 0, res: 96 } });
let t0 = Date.now(); const s1 = C.shapeSolid(sqShape); const ms1 = Date.now() - t0;
const ts1 = closedManifold(s1);
assert(ts1.bad === 0 && ts1.euler === 2, 'carré extrudé : solide fermé (' + s1.idx.length / 3 + ' faces, ' + ms1 + ' ms)');
const vs1 = volume(s1);
assert(Math.abs(vs1 - 0.2) / 0.2 < 0.04, 'carré extrudé : volume ' + vs1.toFixed(4) + ' ≈ 0.2');
let zmin = Infinity, zmax = -Infinity; for (let i = 2; i < s1.pos.length; i += 3) { zmin = Math.min(zmin, s1.pos[i]); zmax = Math.max(zmax, s1.pos[i]); }
assert(Math.abs(zmin + 0.1) < 0.01 && Math.abs(zmax - 0.1) < 0.01, 'ancrage centré : z de ' + zmin.toFixed(3) + ' à ' + zmax.toFixed(3));
const s2 = C.shapeSolid({ ...sqShape, params: { ...sqShape.params, bevel: 0.06, anchor: 'top' } });
assert(closedManifold(s2).bad === 0 && volume(s2) < vs1, 'arrondi : volume réduit (' + volume(s2).toFixed(4) + ')');
let z2 = Infinity; for (let i = 2; i < s2.pos.length; i += 3) z2 = Math.min(z2, s2.pos[i]);
assert(Math.abs(z2) < 0.01, 'ancrage au-dessus : base posée sur le plan');
const s3 = C.shapeSolid({ ...sqShape, params: { ...sqShape.params, inflate: 1, thickness: 0.3 } });
assert(closedManifold(s3).euler === 2 && volume(s3) < 0.3 && volume(s3) > 0.1, 'bombé : coussin fermé (volume ' + volume(s3).toFixed(3) + ')');
// forme concave en C sur un plan incliné
const cPts = []; for (let i = 0; i <= 60; i++) { const a = 0.4 + i / 60 * (Math.PI * 2 - 0.8); cPts.push([Math.cos(a), Math.sin(a), 0]); }
for (let i = 60; i >= 0; i--) { const a = 0.4 + i / 60 * (Math.PI * 2 - 0.8); cPts.push([0.6 * Math.cos(a), 0.6 * Math.sin(a), 0]); }
const plT = { o: [0.2, 0.5, -0.3], u: u0, v: v0, n: nTilt };
const cShape = C.makeCurve('shape', C.fitPath(cPts.map((p) => C.fromPlane(plT, p[0], p[1])), 0.004, true), true, { plane: plT, params: { thickness: 0.1, bevel: 0.02, res: 128 } });
t0 = Date.now(); const s4 = C.shapeSolid(cShape); const ms4 = Date.now() - t0;
const ts4 = closedManifold(s4);
let off = 0; for (let i = 0; i < s4.pos.length; i += 3) off = Math.max(off, Math.abs(dot(sub([s4.pos[i], s4.pos[i + 1], s4.pos[i + 2]], plT.o), plT.n)));
assert(ts4.bad === 0 && ts4.euler === 2 && off < 0.06, 'forme en C sur plan incliné : solide fermé, épaisseur respectée (' + ms4 + ' ms)');
const prev = C.previewLines(cShape); const prev2 = C.previewLines(fancy);
assert(prev.length > 3 && prev2.length > 3, 'aperçus filaires générés');
const IO = require('../src/io.js');
{
  const sc = Core.icosphere(1); const stp = Core.makeSubtool('P', Core.makeLevel(sc.pos, sc.idx, sc.nv));
  const back = IO.deserializeScene(IO.serializeScene({ subtools: [stp], active: 0, curves: [sqShape, fancy] }));
  assert(back.curves.length === 2 && back.curves[1].params.twist === 180 && back.curves[0].plane.n[2] === 1, 'projet : courbes et paramètres enregistrés');
}
