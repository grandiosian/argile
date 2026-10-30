/* Argile — fichiers : ZIP (stocké / deflate en lecture), projet binaire, sauvegarde auto IndexedDB. */
(function (root) {
'use strict';
const Core = root.Core || require('./core.js');

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

// files: [{name, data: Uint8Array}] → Blob
function zipStore(files) {
  const enc = new TextEncoder(); const parts = []; const central = []; let offset = 0;
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, dosTime, true); h.setUint16(12, dosDate, true); h.setUint32(14, crc, true); h.setUint32(18, size, true); h.setUint32(22, size, true);
    h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    parts.push(h.buffer, name, f.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, dosTime, true); c.setUint16(14, dosDate, true); c.setUint32(16, crc, true); c.setUint32(20, size, true); c.setUint32(24, size, true);
    c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    central.push(c.buffer, name);
    offset += 30 + name.length + size;
  }
  let csize = 0; for (const p of central) csize += p.byteLength;
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, csize, true); e.setUint32(16, offset, true);
  return new Blob([...parts, ...central, e.buffer], { type: 'application/zip' });
}
async function unzip(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 70000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Archive ZIP illisible.');
  const n = dv.getUint16(eocd + 10, true); let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder(); const out = [];
  for (let i = 0; i < n; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lo = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nl));
    const start = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
    let data = u8.subarray(start, start + csize);
    if (method === 8) {
      const ds = new DecompressionStream('deflate-raw');
      data = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(ds)).arrayBuffer());
    } else if (method !== 0) { p += 46 + nl + xl + cl; continue; }
    out.push({ name, data });
    p += 46 + nl + xl + cl;
  }
  return out;
}

// ------------------------------------------------------------ projet binaire
const MAGIC = 'ARGILE1';
function serializeScene(scene) {
  const arrays = []; let off = 0;
  const add = (ta) => { if (!ta) return null; const ref = { o: off, n: ta.length, t: ta.constructor.name }; arrays.push(ta); off += ta.byteLength; off = (off + 3) & ~3; return ref; };
  const head = { magic: MAGIC, active: scene.active, camera: scene.camera, subtools: [] };
  for (const st of scene.subtools) {
    const s = { name: st.name, visible: st.visible, cur: st.cur, levels: [] };
    st.levels.forEach((L, k) => {
      s.levels.push({
        nv: L.nv, nt: L.nt, pos: add(L.pos), idx: k === 0 ? add(L.idx) : null, col: add(L.col), mask: add(L.mask), groups: add(L.groups), hidden: add(L.hidden), qflags: add(L.qflags),
        detail: k > 0 ? add(L.detail) : null, ref: k > 0 ? add(L.ref) : null,
      });
    });
    head.subtools.push(s);
  }
  if (scene.gp) head.gp = { active: scene.gp.active, cursor: scene.gp.cursor, layers: scene.gp.layers.map((l) => ({ name: l.name, visible: l.visible, locked: l.locked, strokes: l.strokes.map((st) => ({ color: st.color, pts: add(st.pts) })) })) };
  if (scene.curves && scene.curves.length) head.curves = scene.curves;
  const json = new TextEncoder().encode(JSON.stringify(head));
  const hlen = (8 + json.length + 3) & ~3;
  const out = new Uint8Array(hlen + off);
  new DataView(out.buffer).setUint32(0, json.length, true);
  out.set(json, 8);
  let o = 0;
  for (const a of arrays) { out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), hlen + o); o += a.byteLength; o = (o + 3) & ~3; }
  return out;
}
function deserializeScene(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const jl = dv.getUint32(0, true);
  const head = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + jl)));
  if (head.magic !== MAGIC) throw new Error('Ce fichier n’est pas un projet Argile.');
  const hlen = (8 + jl + 3) & ~3;
  const T = { Float32Array, Uint32Array, Uint8Array, Int32Array };
  const get = (ref) => { if (!ref) return null; const C = T[ref.t]; const bytes = u8.slice(hlen + ref.o + 0, hlen + ref.o + ref.n * C.BYTES_PER_ELEMENT); return new C(bytes.buffer); };
  const subtools = head.subtools.map((s) => {
    const levels = [];
    s.levels.forEach((h, k) => {
      let idx;
      if (k === 0) idx = get(h.idx);
      else { const lo = levels[k - 1]; lo.op = Core.buildLoopOp(lo.idx, lo.nv); idx = lo.op.nidx; }
      const L = Core.makeLevel(get(h.pos), idx, h.nv, { col: get(h.col), mask: get(h.mask), groups: get(h.groups), hidden: get(h.hidden), qflags: get(h.qflags) });
      if (k > 0) { L.detail = get(h.detail); L.ref = get(h.ref); L.firstNb = Core.computeFirstNb ? Core.computeFirstNb(idx, h.nv) : null; }
      levels.push(L);
    });
    const st = Core.makeSubtool(s.name, levels[0]); st.levels = levels; st.cur = s.cur; st.visible = s.visible;
    return st;
  });
  let gp = null;
  if (head.gp && root.GP) {
    gp = root.GP.makeState(); gp.active = head.gp.active || 0; gp.cursor = head.gp.cursor;
    gp.layers = head.gp.layers.map((l) => { const L = root.GP.makeLayer(l.name); L.visible = l.visible; L.locked = l.locked; L.strokes = l.strokes.map((st) => root.GP.makeStroke(st.color, get(st.pts))); return L; });
    if (!gp.layers.length) gp.layers.push(root.GP.makeLayer('Calque 1'));
  }
  const curves = Array.isArray(head.curves) ? head.curves : [];
  if (curves.length && root.Curves) root.Curves.syncIds(curves);
  return { subtools, active: head.active || 0, camera: head.camera, gp, curves };
}

// ------------------------------------------------------------ IndexedDB (sauvegarde auto, propre à ce navigateur)
function idb() {
  return new Promise((res, rej) => {
    try {
      const r = indexedDB.open('argile', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('scenes');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    } catch (e) { rej(e); }
  });
}
async function autosavePut(bytes) {
  const db = await idb();
  return new Promise((res, rej) => { const tx = db.transaction('scenes', 'readwrite'); tx.objectStore('scenes').put({ bytes, at: Date.now() }, 'autosave'); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
}
async function autosaveGet() {
  const db = await idb();
  return new Promise((res, rej) => { const tx = db.transaction('scenes', 'readonly'); const r = tx.objectStore('scenes').get('autosave'); r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error); });
}

const IO = { crc32, zipStore, unzip, serializeScene, deserializeScene, autosavePut, autosaveGet };
root.IO = IO;
if (typeof module !== 'undefined' && module.exports) module.exports = IO;
})(typeof window !== 'undefined' ? window : globalThis);
