const Core = require('../src/core.js');
const Sculpt = require('../src/sculpt.js');
const assert = (c, m) => { if (!c) { console.error('ÉCHEC:', m); process.exitCode = 1; } else console.log('ok -', m); };
const t0 = () => process.hrtime.bigint();
const ms = (a) => Number(process.hrtime.bigint() - a) / 1e6;

// sphère de base
const s = Core.icosphere(3);
assert(s.nv === 642 && s.idx.length / 3 === 1280, 'icosphère niveau 3 : 642 sommets / 1280 faces');
const E = Core.buildEdges(s.idx, s.nv);
assert(E.ne === 1920 && Array.from(E.ecount).every(c => c === 2), 'arêtes : 1920, toutes variété');

const st = Core.makeSubtool('Sphère', Core.makeLevel(s.pos, s.idx, s.nv));
let a = t0();
Core.subtoolDivide(st); Core.subtoolDivide(st); Core.subtoolDivide(st);
const top = Core.curLevel(st);
console.log('  3 divisions :', ms(a).toFixed(0), 'ms →', top.nt, 'faces');
assert(top.nt === 1280 * 64 && st.levels.length === 4, 'subdivision Loop ×3');
// euler: V - E + F = 2
const E2 = Core.buildEdges(top.idx, top.nv);
assert(top.nv - E2.ne + top.nt === 2, 'caractéristique d\'Euler conservée');
let r = 0; for (let i = 0; i < top.nv; i++) r += Math.hypot(top.pos[3 * i], top.pos[3 * i + 1], top.pos[3 * i + 2]); r /= top.nv;
assert(r > 0.95 && r < 1.0, 'rayon moyen après Loop ≈ 1 (' + r.toFixed(4) + ')');

// Mesh + BVH
a = t0();
const mesh = Core.getMesh(top);
console.log('  construction Mesh+BVH :', ms(a).toFixed(0), 'ms');
const hit = mesh.bvh.raycast(0, 0, 5, 0, 0, -1);
assert(hit && Math.abs(hit.t - 5 + r) < 0.02, 'raycast touche la sphère (t=' + (hit && hit.t.toFixed(4)) + ')');
const cp = mesh.bvh.closest(0, 2, 0, {});
assert(cp.tri >= 0 && Math.abs(Math.sqrt(cp.d2) - (2 - r)) < 0.02, 'point le plus proche');

// sculpt : Standard en haut
const S = new Sculpt.Stroke(top, mesh);
const P = { type: 'standard', sign: 1, strength: 0.5, radius: 0.3, focal: 0, alpha: null, right: [1, 0, 0], up: [0, 1, 0], color: [255, 0, 0] };
const hz = 5 - hit.t;
a = t0();
for (let i = 0; i < 20; i++) Sculpt.dab(S, 0, 0, hz, P);
console.log('  20 dabs :', ms(a).toFixed(1), 'ms');
const before = top.pos.slice();
let maxZ = 0; for (let i = 0; i < top.nv; i++) maxZ = Math.max(maxZ, top.pos[3 * i + 2]);
assert(maxZ > r + 0.1, 'la brosse Standard ajoute du volume (z max ' + maxZ.toFixed(3) + ')');
const entry = S.finish();
assert(entry && entry.idx.length > 10, 'entrée d\'annulation (' + entry.idx.length + ' sommets)');
// raycast après refit doit toucher la bosse
const hit2 = mesh.bvh.raycast(0, 0, 5, 0, 0, -1);
assert(hit2 && 5 - hit2.t > r + 0.1, 'BVH refit : le rayon touche la bosse');
// annulation / rétablissement
Sculpt.applyVerts(entry, false, (L) => L.mesh);
let maxZ2 = 0; for (let i = 0; i < top.nv; i++) maxZ2 = Math.max(maxZ2, top.pos[3 * i + 2]);
assert(Math.abs(maxZ2 - r) < 0.05, 'annulation rétablit la forme');
Sculpt.applyVerts(entry, true, (L) => L.mesh);

// multirésolution : descendre, sculpter bas, remonter → détails conservés
const detailCopy = top.pos.slice();
Core.subtoolSetLevel(st, 1);
const lo = Core.curLevel(st);
Core.subtoolSetLevel(st, 3);
let err = 0; for (let i = 0; i < top.nv * 3; i++) err = Math.max(err, Math.abs(top.pos[i] - detailCopy[i]));
assert(err < 1e-4, 'aller-retour niveaux sans modification : erreur ' + err.toExponential(2));
// bas : déplace tout en x de +0.5, remonter : la bosse doit suivre
Core.subtoolSetLevel(st, 0);
const L0 = Core.curLevel(st);
for (let i = 0; i < L0.nv; i++) L0.pos[3 * i] += 0.5;
Core.subtoolSetLevel(st, 3);
let mz = -1, mi = 0; for (let i = 0; i < top.nv; i++) if (top.pos[3 * i + 2] > mz) { mz = top.pos[3 * i + 2]; mi = i; }
assert(Math.abs(top.pos[3 * mi] - 0.5) < 0.05 && mz > r + 0.1, 'détails suivent la modification du niveau bas (x=' + top.pos[3 * mi].toFixed(3) + ')');
// rotation au niveau bas (90° autour de y) : la bosse doit tourner avec
Core.subtoolSetLevel(st, 0);
for (let i = 0; i < L0.nv; i++) { const x = L0.pos[3 * i] - 0.5, z = L0.pos[3 * i + 2]; L0.pos[3 * i] = z + 0.5; L0.pos[3 * i + 2] = -x; }
Core.subtoolSetLevel(st, 3);
let mxx = -9; for (let i = 0; i < top.nv; i++) mxx = Math.max(mxx, top.pos[3 * i]);
assert(mxx - 0.5 > r + 0.1, 'détails en repère local : la bosse a tourné (x max ' + (mxx - 0.5).toFixed(3) + ')');
// sculpt haut puis descendre : propagation vers le bas
Core.subtoolSetLevel(st, 3);
const before0 = Core.curLevel(st).pos.slice();
for (let i = 0; i < top.nv; i++) top.pos[3 * i + 1] += 0.2;
Core.subtoolSetLevel(st, 0);
let dy = 0; for (let i = 0; i < L0.nv; i++) dy += L0.pos[3 * i + 1]; dy /= L0.nv;
assert(Math.abs(dy - 0.2) < 0.02, 'modifs du niveau haut propagées vers le bas (dy moyen ' + dy.toFixed(3) + ')');

// DynaMesh
const sf = Core.icosphere(3); const Lr = Core.makeLevel(sf.pos, sf.idx, sf.nv);
a = t0();
const dm = Core.remeshVoxel(Lr, 64);
console.log('  DynaMesh 64 :', ms(a).toFixed(0), 'ms →', dm.nt, 'faces', dm.info);
const E3 = Core.buildEdges(dm.idx, dm.nv);
let nonMan = 0; for (let e = 0; e < E3.ne; e++) if (E3.ecount[e] !== 2) nonMan++;
assert(dm.nt > 1000 && nonMan === 0, 'DynaMesh sphère fermée (' + nonMan + ' arêtes non-variété)');
assert(dm.nv - E3.ne + dm.nt === 2, 'DynaMesh : Euler = 2 (genre 0)');
const vol = Core.fixOrientation(dm.pos, dm.idx.slice());
assert(vol > 0, 'DynaMesh : orientation vers l\'extérieur (volume ' + (vol / 6).toFixed(3) + ')');
let rr = 0; for (let i = 0; i < dm.nv; i++) rr = Math.max(rr, Math.abs(Math.hypot(dm.pos[3 * i], dm.pos[3 * i + 1], dm.pos[3 * i + 2]) - 1));
assert(rr < 0.02, 'DynaMesh projeté sur la surface (écart max ' + rr.toFixed(4) + ')');
// fusion de deux sphères qui se chevauchent → union
const s2 = Core.icosphere(3); for (let i = 0; i < s2.nv; i++) s2.pos[3 * i] += 1.2;
const s1 = Core.icosphere(3); const merged = Core.mergeLevels([Core.makeLevel(s1.pos, s1.idx, s1.nv), Core.makeLevel(s2.pos, s2.idx, s2.nv)]);
const un = Core.remeshVoxel(merged, 96);
const E4 = Core.buildEdges(un.idx, un.nv);
const { n: comps } = Core.connectedComponents(un.idx, un.nv);
assert(comps === 1 && un.nv - E4.ne + un.nt === 2, 'union booléenne par DynaMesh : 1 pièce, genre 0');
// tore : genre 1
const tor = Core.torus(48, 24);
const dt = Core.remeshVoxel(Core.makeLevel(tor.pos, tor.idx, tor.nv), 80);
const E5 = Core.buildEdges(dt.idx, dt.nv);
assert(dt.nv - E5.ne + dt.nt === 0, 'DynaMesh tore : Euler = 0');

// OBJ
const txt = Core.exportOBJ([top], ['Test'], false);
const back = Core.parseOBJ(txt);
assert(back.nv === top.nv && back.idx.length === top.idx.length, 'OBJ aller-retour');
const q = Core.parseOBJ('v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\ng a\nf 1/1/1 2/2/2 3/3/3 4/4/4\n');
assert(q.idx.length === 6 && q.nv === 4, 'OBJ : quad triangulé, formats v/vt/vn');

// polygroupes
const box = Core.box(4);
const Lb = Core.makeLevel(box.pos, box.idx, box.nv);
const mb = Core.getMesh(Lb);
const ng = Sculpt.groupsByNormal(Lb, mb, 30);
assert(ng === 6, 'groupes par normales sur un cube : ' + ng);
assert(box.nv === 6 * 16 + 2, 'cube : sommets partagés (' + box.nv + ')');

// cube divisé (bord vif + Loop) et sous-niveau supprimé
const sb = Core.makeSubtool('Cube', Lb);
Core.subtoolDivide(sb); Core.subtoolSetLevel(sb, 0); Core.subtoolSetLevel(sb, 1);
assert(Core.subtoolDelLower(sb) && sb.levels.length === 1, 'suppression des niveaux inférieurs');

// gros maillage : performance
const big = Core.icosphere(7); // 327 680 faces
a = t0(); const Lbig = Core.makeLevel(big.pos, big.idx, big.nv); const mbig = Core.getMesh(Lbig);
console.log('  Mesh 327k faces :', ms(a).toFixed(0), 'ms');
const Sb = new Sculpt.Stroke(Lbig, mbig);
a = t0(); for (let i = 0; i < 50; i++) Sculpt.dab(Sb, 0, 0, 1, { ...P, type: 'clay', radius: 0.15 });
console.log('  50 dabs Clay (r=0.15) :', ms(a).toFixed(1), 'ms');

// projet : sérialisation aller-retour + zip
const IO = require('../src/io.js');
(async () => {
  const sc = Core.icosphere(2);
  const stp = Core.makeSubtool('P', Core.makeLevel(sc.pos, sc.idx, sc.nv));
  Core.subtoolDivide(stp); Core.subtoolDivide(stp); Core.subtoolSetLevel(stp, 1);
  const lv = Core.curLevel(stp); lv.mask[3] = 0.5; lv.col[7] = 255;
  const bytes = IO.serializeScene({ subtools: [stp], active: 0, camera: { a: 1 } });
  const back = IO.deserializeScene(bytes);
  const b = back.subtools[0];
  assert(b.levels.length === 3 && b.cur === 1 && b.levels[2].idx.length === stp.levels[2].idx.length, 'projet : niveaux restaurés');
  Core.subtoolSetLevel(b, 2); Core.subtoolSetLevel(stp, 2);
  let e = 0; for (let i = 0; i < b.levels[2].pos.length; i++) e = Math.max(e, Math.abs(b.levels[2].pos[i] - stp.levels[2].pos[i]));
  assert(e < 1e-6 && b.levels[1].mask[3] === 0.5, 'projet : positions et masque identiques');
  const zb = IO.zipStore([{ name: 'a.txt', data: new TextEncoder().encode('bonjour') }, { name: 'scene.bin', data: bytes }]);
  const files = await IO.unzip(await zb.arrayBuffer());
  assert(files.length === 2 && new TextDecoder().decode(files[0].data) === 'bonjour' && files[1].data.length === bytes.length, 'zip aller-retour');
})();
