const Core = require('../src/core.js');
const Su = require('../src/surface.js');
const assert = (c, m) => { if (!c) { console.error('ÉCHEC:', m); process.exitCode = 1; } else console.log('ok -', m); };
const topo = (m) => { const E = Core.buildEdges(m.idx, m.nv); let open = 0, over = 0; for (let e = 0; e < E.ne; e++) { if (E.ecount[e] === 1) open++; else if (E.ecount[e] > 2) over++; } return { open, over, euler: m.nv - E.ne + m.idx.length / 3 }; };
const vol = (m) => Core.fixOrientation(m.pos, m.idx.slice()) / 6;

// cube → Catmull-Clark : tend vers une sphère arrondie, reste fermé
const cube = { V: [], F: [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]], G: [0, 1, 2, 3, 4, 5] };
for (let k = 0; k < 8; k++) cube.V.push([k & 1 ? 1 : -1, k & 2 ? 1 : -1, k & 4 ? 1 : -1]);
Su.orient(cube);
const c3 = Su.subdivide(cube, 3);
assert(c3.F.length === 6 * 64 && c3.F.every((f) => f.length === 4), 'Catmull-Clark : 6 → 384 quads');
const t3 = Su.toTriMesh(c3); const tp = topo(t3);
assert(tp.open === 0 && tp.over === 0 && tp.euler === 2 && vol(t3) > 0, 'cube subdivisé : fermé, orienté');
assert(new Set(t3.groups).size === 6, 'polygroupes hérités des faces de la cage');
assert(t3.qflags.filter((f) => f).length === t3.idx.length / 3, 'drapeaux de diagonales posés sur chaque triangle');
let rmin = 9, rmax = 0; for (let i = 0; i < t3.nv * 3; i += 3) { const r = Math.hypot(t3.pos[i], t3.pos[i + 1], t3.pos[i + 2]); rmin = Math.min(rmin, r); rmax = Math.max(rmax, r); }
assert(rmax / rmin < 1.25, 'forme limite arrondie (rapport ' + (rmax / rmin).toFixed(2) + ')');

// enveloppe convexe
const pts = []; for (let i = 0; i < 60; i++) { const u = Math.random() * 2 - 1, a = Math.random() * 6.283; pts.push([Math.sqrt(1 - u * u) * Math.cos(a), Math.sqrt(1 - u * u) * Math.sin(a), u]); }
pts.push([0, 0, 0], [0.1, 0.2, 0.1]);
const h = Su.convexHull(pts); const hv = new Set(h.flat());
assert(h && !hv.has(60) && !hv.has(61) && h.length === 2 * 60 - 4, 'enveloppe convexe : ' + h.length + ' faces, points intérieurs exclus');

// peaux de ZSpheres
const chain = [{ p: [0, 0, 0], r: 1, parent: -1 }, { p: [0, 3, 0], r: 0.8, parent: 0 }, { p: [1.5, 5, 0], r: 0.5, parent: 1 }];
const s1 = Su.skinZSpheres(chain, 2); const t1 = topo(s1);
assert(t1.open === 0 && t1.over === 0 && t1.euler === 2 && vol(s1) > 0, 'chaîne de 3 sphères : peau fermée (' + s1.idx.length / 3 + ' triangles)');
const star = [{ p: [0, 0, 0], r: 1, parent: -1 }];
for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1]]) star.push({ p: d.map((x) => x * 4), r: 0.6, parent: 0, part: star.length });
const s2 = Su.skinZSpheres(star, 2); const t2 = topo(s2);
assert(t2.open === 0 && t2.over === 0 && t2.euler === 2, 'embranchement à 5 branches : peau fermée');
assert(new Set(s2.groups).size === 6, 'un polygroupe par branche');
// rayon de la peau ≈ rayon des sphères au milieu d'un tube
const tube = [{ p: [0, 0, 0], r: 1, parent: -1 }, { p: [0, 10, 0], r: 1, parent: 0 }];
const s3 = Su.skinZSpheres(tube, 3); let rr = [];
for (let i = 0; i < s3.nv * 3; i += 3) if (Math.abs(s3.pos[i + 1] - 5) < 0.3) rr.push(Math.hypot(s3.pos[i], s3.pos[i + 2]));
const ravg = rr.reduce((a, b) => a + b, 0) / rr.length;
assert(Math.abs(ravg - 1) < 0.12, 'rayon de peau au milieu d’un lien : ' + ravg.toFixed(3) + ' (sphères de rayon 1)');
const one = Su.skinZSpheres([{ p: [0, 0, 0], r: 2, parent: -1 }], 3);
assert(topo(one).euler === 2, 'sphère seule : peau fermée');

// chevalière surfacique
require('../src/curves.js'); require('../src/sdf.js');
const Smp = require('../src/samples.js');
for (const forme of ['ovale', 'rond', 'carre', 'coussin', 'octogone']) {
  const t0 = Date.now();
  const r = Smp.build('chevaliere', { forme, subdiv: 3 }, { textSDF: () => (x, z) => Math.hypot(x, z) - 2 });
  const m = r[0].mesh, t = topo(m);
  let rmin = 1e9, ymax = -1e9; for (let i = 0; i < m.nv * 3; i += 3) { if (Math.abs(m.pos[i + 2]) < 0.4) rmin = Math.min(rmin, Math.hypot(m.pos[i], m.pos[i + 1])); ymax = Math.max(ymax, m.pos[i + 1]); }
  const ri = 56 / (2 * Math.PI);
  assert(t.open === 0 && t.over === 0 && t.euler === 0 && Math.abs(rmin - ri) < 0.06, 'chevalière surfacique ' + forme + ' : tore fermé, Ø int ' + (2 * rmin).toFixed(2) + ' mm (attendu ' + (2 * ri).toFixed(2) + '), ' + m.idx.length / 3 + ' triangles, ' + (Date.now() - t0) + ' ms');
}
{
  const r = Smp.build('chevaliere', { subdiv: 2, gravure: 'aucune' }, {});
  const m = r[0].mesh; let ymax = -1e9; for (let i = 1; i < m.nv * 3; i += 3) ymax = Math.max(ymax, m.pos[i]);
  const ri = 56 / (2 * Math.PI);
  assert(Math.abs(ymax - (ri + 4 + 0.3)) < 0.15, 'plateau à la bonne hauteur (' + ymax.toFixed(2) + ' mm)');
  assert(new Set(m.groups).size >= 3 && m.qflags.some((f) => f), 'polygroupes intérieur / dessus / flancs, quads marqués');
  const flat = []; for (let i = 0; i < m.nv * 3; i += 3) if (Math.abs(m.pos[i]) < 2 && Math.abs(m.pos[i + 2]) < 2 && m.pos[i + 1] > ri + 3) flat.push(m.pos[i + 1]);
  const spread = Math.max(...flat) - Math.min(...flat);
  assert(spread < 0.35, 'dessus du plateau lisse et quasi plan au centre (écart ' + spread.toFixed(3) + ' mm, bombé 0,3)');
}
{
  const t0 = Date.now();
  const h = Smp.build('humanoide', {}, {});
  const m = h[0].mesh, t = topo(m), bb = require('../src/sdf.js').meshBounds(m);
  assert(t.open === 0 && t.over === 0 && t.euler === 2, 'humanoïde ZSpheres : peau fermée de genre 0 (' + m.idx.length / 3 + ' triangles, ' + (Date.now() - t0) + ' ms)');
  assert(Math.abs(bb[4] - bb[1] - 30) < 1e-3 && new Set(m.groups).size === 6, 'humanoïde ZSpheres : 30 cm, 6 polygroupes (torse, tête, bras, mains, jambes, pieds)');
  assert(m.qflags.every((f) => f), 'humanoïde ZSpheres : tout en quads');
  for (const tetes of [3, 5.5, 8.5]) for (const bras of [0, 45, 90]) {
    const r = Smp.build('humanoide', { tetes, bras, corpulence: 1.4 }, { preview: true });
    const tt = topo(r[0].mesh);
    assert(tt.open === 0 && tt.over === 0, 'humanoïde ' + tetes + ' têtes, bras à ' + bras + '° : peau valide');
  }
  for (const e of ['chien', 'chat', 'cheval', 'ours', 'lapin']) {
    const r = Smp.build('animal', { espece: e }, { preview: true });
    const tt = topo(r[0].mesh);
    assert(tt.open === 0 && tt.over === 0 && tt.euler === 2, 'quadrupède ZSpheres ' + e + ' : peau fermée');
  }
  const sk = Smp.skeleton('humanoide', {});
  assert(sk.length === 6 + 2 * 9 && sk.filter((n) => n.parent < 0).length === 1, 'squelette humanoïde : ' + sk.length + ' sphères, une racine');
}
// ------------------------------------------------------------ boîtes chanfreinées (ZBoxes)
{
  const bar = [0, 3, 6].map((y, i) => ({ p: [0, y, 0], r: 1, parent: i - 1, sx: 2, sy: 0.5 }));
  const c = Su.zsphereCage(bar, { shape: 'box' });
  assert(Math.abs(Su.volume(c) - 4 * 8 * 1) < 1e-9, 'barre de boîtes : volume exact 4 × 8 × 1 (largeur, longueur, épaisseur)');
  const b = Su.bevel(c, 0.15), tb = topo(Su.toTriMesh(b));
  assert(tb.open === 0 && tb.over === 0 && tb.euler === 2, 'chanfrein : maillage fermé de genre 0 (' + b.F.length + ' faces)');
  assert(Su.volume(b) < 32 && Su.volume(b) > 30, 'chanfrein : volume légèrement réduit (' + Su.volume(b).toFixed(2) + ')');
  let mx = 0; for (const p of b.V) mx = Math.max(mx, Math.abs(p[0])); assert(Math.abs(mx - 2) < 1e-9, 'chanfrein : les faces restent sur leurs plans');
  const elbow = Su.zsphereCage([{ p: [0, 0, 0], r: 1, parent: -1 }, { p: [0, 4, 0], r: 1, parent: 0 }, { p: [4, 4, 0], r: 1, parent: 1 }], { shape: 'box' });
  assert(Math.abs(Su.volume(elbow) - 40) < 1e-6, 'coude en onglet : volume exact (40)');
  const hum = Smp.skeleton('humanoide', {});
  for (const profile of ['arrondi', 'plat']) for (const lv of [0, 2]) {
    const m = Su.skinZSpheres(hum, lv, { shape: 'box', chamfer: 0.2, profile }), t = topo(m);
    assert(t.open === 0 && t.over === 0 && t.euler === 2, 'humanoïde en boîtes (' + profile + ', niveau ' + lv + ') : peau fermée, ' + m.idx.length / 3 + ' triangles');
  }
  const r = Smp.build('humanoide', { mode: 'boites' }, {}), bb = require('../src/sdf.js').meshBounds(r[0].mesh);
  assert(Math.abs(bb[4] - bb[1] - 30) < 1e-3 && new Set(r[0].mesh.groups).size === 6, 'humanoïde mode boîtes : 30 cm, 6 polygroupes');
  const fr = Su.zsNodeFrames(hum, true);
  assert(fr.length === hum.length && fr.every((f) => Math.abs(Su.v.dot(f.d, f.u)) < 1e-9 && Math.abs(Su.v.len(f.v) - 1) < 1e-9), 'repères des nœuds orthonormés');
}
// ------------------------------------------------------------ esquisses de la chevalière
{
  const sk = Smp.sketches('chevaliere', {}), ri = 56 / (2 * Math.PI);
  assert(sk && sk.face.length >= 3 && sk.cote.length >= 2 && sk.dessus.length >= 2, 'esquisses : face (' + sk.face.length + ' points), côté (' + sk.cote.length + '), dessus (' + sk.dessus.length + ')');
  assert(Math.abs(sk.face[0].p[0]) < 1e-9 && Math.abs(sk.face[sk.face.length - 1].p[0]) < 1e-9, 'esquisse de face : extrémités sur l’axe de symétrie');
  assert(Math.abs(sk.a - 6) < 0.05 && Math.abs(sk.b - 7) < 0.05 && Math.abs(sk.yTop - (ri + 4)) < 0.05, 'esquisses depuis les réglages : plateau 12 × 14 mm à ' + sk.yTop.toFixed(2) + ' mm');
  assert(Smp.sketches('chevaliere', { mode: 'volume' }) === null && Smp.sketches('collier', {}) === null, 'pas d’esquisses en mode volume ni pour les autres modèles');
  const rin = (m) => { let r = 1e9; for (let i = 0; i < m.nv * 3; i += 3) if (Math.abs(m.pos[i + 2]) < 0.5) r = Math.min(r, Math.hypot(m.pos[i], m.pos[i + 1])); return r; };
  const ext = (m, k) => { let a = 0; for (let i = k; i < m.nv * 3; i += 3) a = Math.max(a, Math.abs(m.pos[i])); return a; };
  const base = Smp.build('chevaliere', { subdiv: 2, gravure: 'aucune' }, {})[0].mesh;
  // plateau étiré dans l'esquisse de dessus (premier point remonté de 2 mm)
  const top = JSON.parse(JSON.stringify(sk.dessus)); for (const w of ['p', 'i', 'o']) top[0][w][1] += 2;
  const m1 = Smp.build('chevaliere', { subdiv: 2, gravure: 'aucune', sketch: { dessus: { pts: top } } }, {})[0].mesh, t1 = topo(m1);
  assert(t1.open === 0 && t1.over === 0, 'esquisse de dessus modifiée : maillage fermé');
  assert(ext(m1, 2) - ext(base, 2) > 1.5, 'esquisse de dessus modifiée : plateau allongé (' + (2 * ext(base, 2)).toFixed(1) + ' → ' + (2 * ext(m1, 2)).toFixed(1) + ' mm)');
  assert(Math.abs(2 * rin(m1) - 2 * rin(base)) < 0.02, 'esquisse de dessus modifiée : taille de doigt inchangée');
  // esquisse de face éditée à la taille 56, puis taille 64 : le profil suit le doigt
  const m2 = Smp.build('chevaliere', { subdiv: 2, gravure: 'aucune', taille: 64, sketch: { face: { pts: sk.face, ri } } }, {})[0].mesh, t2 = topo(m2);
  assert(t2.open === 0 && Math.abs(2 * rin(m2) - 64 / Math.PI) < 0.1, 'esquisse de face + taille 64 : Ø intérieur ' + (2 * rin(m2)).toFixed(2) + ' mm');
  const sk64 = Smp.sketches('chevaliere', { taille: 64, sketch: { face: { pts: sk.face, ri } } });
  assert(sk64.custom.face && Math.abs(sk64.yTop - (64 / (2 * Math.PI) + 4)) < 0.05, 'esquisse de face décalée avec la taille (plateau à ' + sk64.yTop.toFixed(2) + ' mm)');
  // face rehaussée : le plateau monte
  const face = JSON.parse(JSON.stringify(sk.face)); for (const A of face.slice(0, 3)) for (const w of ['p', 'i', 'o']) A[w][1] += 1.5;
  const m3 = Smp.build('chevaliere', { subdiv: 2, gravure: 'aucune', sketch: { face: { pts: face, ri } } }, {})[0].mesh;
  let y3 = -1e9, y0 = -1e9; for (let i = 1; i < m3.nv * 3; i += 3) y3 = Math.max(y3, m3.pos[i]); for (let i = 1; i < base.nv * 3; i += 3) y0 = Math.max(y0, base.pos[i]);
  assert(Math.abs(y3 - y0 - 1.5) < 0.1, 'esquisse de face rehaussée de 1,5 mm : plateau ' + (y3 - y0).toFixed(2) + ' mm plus haut');
}
