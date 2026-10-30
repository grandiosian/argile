const Core = require('../src/core.js');
require('../src/curves.js');
const SDF = require('../src/sdf.js');
const S = require('../src/samples.js');
const assert = (c, m) => { if (!c) { console.error('ÉCHEC:', m); process.exitCode = 1; } else console.log('ok -', m); };
function topo(m) {
  const E = Core.buildEdges(m.idx, m.nv); let open = 0, over = 0;
  for (let e = 0; e < E.ne; e++) { if (E.ecount[e] === 1) open++; else if (E.ecount[e] > 2) over++; }
  return { open, over, euler: m.nv - E.ne + m.idx.length / 3 };
}
const vol = (m) => Core.fixOrientation(m.pos, m.idx.slice()) / 6;
const bounds = SDF.meshBounds;

// ---------- noyau
{
  const sp = SDF.meshSDF(SDF.sphere(0, 0, 0, 1), { res: 48 });
  const t = topo(sp);
  assert(t.open === 0 && t.over === 0 && t.euler === 2, 'sphère SDF : fermée');
  assert(Math.abs(vol(sp) - 4 / 3 * Math.PI) / (4 / 3 * Math.PI) < 0.03, 'sphère SDF : volume ' + vol(sp).toFixed(3));
  const full = SDF.meshSDF(SDF.sphere(0, 0, 0, 1), { res: 48 });
  assert(full.info.exact < full.info.voxels * 0.5, 'maillage en bande : ' + Math.round(100 * full.info.exact / full.info.voxels) + ' % des voxels évalués');
  const rc = SDF.roundCone([0, 0, 0], [0, 1, 0], 0.3, 0.1);
  assert(Math.abs(rc.f(0, -0.3, 0)) < 1e-9 && Math.abs(rc.f(0, 1.1, 0)) < 1e-9, 'cône arrondi : extrémités exactes');
  assert(Math.abs(SDF.ellipse2(3, 0, 3, 2)) < 1e-9 && Math.abs(SDF.ellipse2(0, 3, 3, 2) - 1) < 1e-6 && SDF.ellipse2(0, 0, 3, 2) < 0, 'distance à l’ellipse exacte');
  const lab = SDF.union([SDF.sphere(-1, 0, 0, 0.8), SDF.sphere(1, 0, 0, 0.8)], 0.2, true);
  const m = SDF.meshSDF(lab, { res: 48 });
  assert(new Set(m.groups).size === 2, 'étiquettes → 2 polygroupes');
  const r = SDF.ringMesh(2, 1, 0.3); const tr = topo(r);
  assert(tr.open === 0 && tr.euler === 0 && vol(r) > 0, 'maillon : tore fermé orienté');
}

// ---------- catalogue complet en aperçu
const fakeText = () => (x, z) => Math.hypot(x, z) - 2; // disque à la place des lettres
for (const s of S.CATALOG) {
  const t0 = Date.now();
  const parts = S.build(s.id, {}, { preview: true, previewRes: 64, textSDF: fakeText });
  const ms = Date.now() - t0;
  const faces = parts.reduce((n, p) => n + p.mesh.idx.length / 3, 0);
  const bad = parts.filter((p) => { const t = topo(p.mesh); return t.open > 0; }).map((p) => p.name);
  assert(parts.length > 0 && faces > 500 && bad.length === 0, s.name + ' : ' + parts.length + ' pièce(s) [' + parts.map((p) => p.name).join(', ') + '], ' + faces + ' faces, ' + ms + ' ms' + (bad.length ? ' — ouvertes : ' + bad.join(', ') : ''));
}

// ---------- vérifications dimensionnelles
{
  const parts = S.build('chevaliere', { taille: 56 }, { preview: false, textSDF: fakeText });
  const m = parts[0].mesh, bb = bounds(m), ri = 56 / (2 * Math.PI);
  let rmin = 1e9; for (let i = 0; i < m.nv * 3; i += 3) { const z = m.pos[i + 2]; if (Math.abs(z) < 0.5) rmin = Math.min(rmin, Math.hypot(m.pos[i], m.pos[i + 1])); }
  assert(Math.abs(rmin - ri) < 0.12, 'chevalière taille 56 : rayon intérieur ' + rmin.toFixed(2) + ' mm (attendu ' + ri.toFixed(2) + ')');
  assert(Math.abs(bb[4] - (ri + 4 + 0.3)) < 0.3, 'chevalière : sommet du plateau à ' + bb[4].toFixed(2) + ' mm');
  const t = topo(m); assert(t.open === 0 && t.over === 0, 'chevalière finale : surface fermée (' + m.idx.length / 3 + ' faces)');
}
{
  const closed = S.build('chevaliere-clapet', { ouverture: 0 }, { preview: false, previewRes: 64 });
  const open = S.build('chevaliere-clapet', { ouverture: 90 }, { preview: false });
  const lidC = bounds(closed[1].mesh), lidO = bounds(open[1].mesh);
  assert(closed.map((p) => p.name).join() === 'Anneau,Clapet,Goupille', 'chevalière à clapet : 3 pièces');
  assert(lidO[4] - lidC[4] > 3, 'clapet ouvert à 90° : se relève de ' + (lidO[4] - lidC[4]).toFixed(1) + ' mm');
  const ring = closed[0].mesh; let inLid = 0;
  for (let i = 0; i < closed[1].mesh.nv * 3; i += 30) { const x = closed[1].mesh.pos[i], y = closed[1].mesh.pos[i + 1], z = closed[1].mesh.pos[i + 2]; if (x > lidC[0] + 1 && x < lidC[3] - 2 && y < lidC[1] - 0.05) inLid++; }
  assert(inLid === 0, 'clapet fermé posé au-dessus de l’assise');
}
{
  const b = S.build('bracelet-clapet', { ouverture: 0 }, { preview: true, previewRes: 96 });
  const mid = (m, f) => { let v = f === 'max' ? -1e9 : 1e9; for (let i = 0; i < m.nv * 3; i += 3) if (Math.abs(m.pos[i]) < 20) v = f === 'max' ? Math.max(v, m.pos[i + 1]) : Math.min(v, m.pos[i + 1]); return v; };
  const fMax = mid(b[0].mesh, 'max'), mMin = mid(b[1].mesh, 'min');
  assert(fMax < 0 && mMin > 0, 'bracelet : hors charnière et fermoir, demi-joncs séparés (fixe ≤ ' + fMax.toFixed(2) + ', mobile ≥ ' + mMin.toFixed(2) + ')');
  const bm = bounds(b[1].mesh);
  const bo = S.build('bracelet-clapet', { ouverture: 60 }, { preview: true, previewRes: 96 });
  assert(bounds(bo[1].mesh)[4] > bm[4] + 10, 'bracelet ouvert : la partie mobile pivote');
}
{
  const c = S.build('collier', { longueur: 450, pendentif: 'coeur' }, { preview: true });
  const chain = c.find((p) => p.name === 'Chaîne').mesh, rings = chain.nv / (14 * 6);
  assert(rings > 100 && rings % 2 === 0, 'collier 450 mm : ' + rings + ' maillons');
  const pd = bounds(c.find((p) => p.name === 'Pendentif').mesh), ch = bounds(chain);
  assert(pd[4] < ch[1] + 1 && pd[4] > ch[1] - 6, 'pendentif accroché sous la chaîne');
}
{
  const h = S.build('humanoide', { taille: 30 }, { preview: true });
  const bb = bounds(h[0].mesh);
  assert(Math.abs(bb[4] - bb[1] - 30) < 0.01 && Math.abs(bb[1]) < 1e-4, 'humanoïde : 30 cm, pieds au sol (' + (bb[4] - bb[1]).toFixed(1) + ' cm)');
  assert(new Set(h[0].mesh.groups).size === 5, 'humanoïde : 5 polygroupes (tête, cou, torse, bras, jambes)');
  for (const e of ['chat', 'cheval', 'ours', 'lapin', 'oiseau', 'poisson']) {
    const a = S.build('animal', { espece: e }, { preview: true, previewRes: 56 });
    const t = topo(a[0].mesh);
    assert(t.open === 0 && a[0].mesh.idx.length > 1000, 'animal ' + e + ' : fermé, ' + new Set(a[0].mesh.groups).size + ' polygroupes');
  }
}
{
  const ar = S.build('arche', { fleche: 0.75, mur: true }, { preview: true, previewRes: 96 });
  assert(ar.length === 2, 'arche brisée avec mur');
  const v = S.build('voute', { travees: 3 }, { preview: true, previewRes: 80 });
  const ribs = bounds(v[1].mesh);
  assert(Math.abs(ribs[4] - (6 + 0.75 * 6)) < 0.6, 'voûte : clé à ' + ribs[4].toFixed(2) + ' m (attendu ≈ ' + (6 + 4.5) + ')');
  const ho = S.build('maison', { toit: 'quatre', etages: 3 }, { preview: true });
  assert(bounds(ho[0].mesh)[4] > 8.9, 'maison 3 niveaux : murs à ' + bounds(ho[0].mesh)[4].toFixed(2) + ' m');
}
