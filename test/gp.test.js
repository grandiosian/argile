const Core = require('../src/core.js');
const GP = require('../src/gp.js');
const assert = (c, m) => { if (!c) { console.error('ÉCHEC:', m); process.exitCode = 1; } else console.log('ok -', m); };

// trait en arc
const raw = []; for (let i = 0; i <= 40; i++) { const a = i / 40 * Math.PI; raw.push(Math.cos(a), Math.sin(a), 0, 0.05 + 0.03 * Math.sin(a)); }
raw.push(raw[raw.length - 4], raw[raw.length - 3], raw[raw.length - 2], 0.05); // doublon
const s = GP.finalize(raw, [255, 0, 0], 2, 1e-4);
assert(s && GP.count(s) === 41, 'finalisation : doublons retirés (' + GP.count(s) + ' points)');
assert(Math.abs(s.pts[0] - 1) < 1e-6 && Math.abs(s.pts[4 * 40] + 1) < 1e-6, 'lissage : extrémités fixes');

// tube fermé
const m = GP.strokesToMesh([s], { sides: 8 });
const E = Core.buildEdges(m.idx, m.nv);
let bad = 0; for (let e = 0; e < E.ne; e++) if (E.ecount[e] !== 2) bad++;
assert(bad === 0 && m.nv - E.ne + m.idx.length / 3 === 2, 'tube : surface fermée de genre 0');
const vol = Core.fixOrientation(m.pos, m.idx.slice());
assert(vol > 0, 'tube : normales vers l’extérieur');
assert(m.col[3] === 255 && m.col[0] === 255, 'tube : couleur du trait transférée');
// deux traits → deux groupes, DynaMesh les soude s'ils se croisent
const s2 = GP.lineStroke([0, -0.2, 0], [0, 1.2, 0], 0.08, [0, 0, 255], 30);
const m2 = GP.strokesToMesh([s, s2]);
assert(new Set(m2.groups).size === 2, 'conversion : un polygroupe par trait');
const L = Core.makeLevel(m2.pos, m2.idx, m2.nv, { groups: m2.groups, col: m2.col });
const dm = Core.remeshVoxel(L, 96);
const { n } = Core.connectedComponents(dm.idx, dm.nv);
assert(n === 1, 'DynaMesh des tubes croisés : une seule pièce');

// gomme : projection orthographique simple (x,y) → pixels
const st = GP.makeState(); st.layers[0].strokes.push(s, s2);
const proj = (x, y) => [x * 100, -y * 100];
const v0 = st.version;
GP.erase(st, proj, 0, -100, 12, false); // efface le haut de l'arc (x=0,y=1) et le haut de la ligne
const strokes = st.layers[0].strokes;
assert(st.version > v0 && strokes.length >= 3, 'gomme par points : traits coupés en morceaux (' + strokes.length + ')');
const st2 = GP.makeState(); st2.layers[0].strokes.push(s, s2);
GP.erase(st2, proj, 0, -50, 5, true);
assert(st2.layers[0].strokes.length === 1 && st2.layers[0].strokes[0] === s, 'gomme trait entier : seule la ligne disparaît');
const snap = GP.snapshot(st2); st2.layers[0].strokes = []; GP.restore(st2, snap);
assert(st2.layers[0].strokes.length === 1, 'annulation : instantané restauré');
const b = GP.buildBatch([s, s2]);
assert(b.np === 41 + 30 && b.ns === 40 + 29, 'lot GPU : points et segments');
const IO = require('../src/io.js');
{
  const sc = Core.icosphere(1); const stp = Core.makeSubtool('P', Core.makeLevel(sc.pos, sc.idx, sc.nv));
  const g = GP.makeState(); g.layers[0].strokes.push(s, s2); g.layers.push(GP.makeLayer('Croquis')); g.cursor = [1, 2, 3];
  const back = IO.deserializeScene(IO.serializeScene({ subtools: [stp], active: 0, gp: g }));
  assert(back.gp && back.gp.layers.length === 2 && back.gp.layers[0].strokes[1].pts.length === s2.pts.length && back.gp.cursor[2] === 3, 'projet : traits et calques enregistrés');
}
