/* Argile — caméra et rendu WebGPU (lecture des sommets depuis des storage buffers, draw non indexé). */
(function (root) {
'use strict';

// ------------------------------------------------------------ maths
const V = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
};
const Q = {
  mul: (a, b) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ],
  axis: (ax, ang) => { const s = Math.sin(ang / 2); return [ax[0] * s, ax[1] * s, ax[2] * s, Math.cos(ang / 2)]; },
  rot: (q, v) => { // v + 2w(q×v) + 2 q×(q×v)
    const [x, y, z, w] = q;
    const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
    return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
  },
  norm: (q) => { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; },
  toMat3: (q) => { const [x, y, z, w] = q; return [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)]; },
};
function mat4Mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; }
  return o;
}

// 24 orientations alignées sur les axes (pour l'accrochage Maj)
const SNAPS = (() => {
  const out = []; const axes = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (const b of axes) for (const u of axes) {
    if (Math.abs(V.dot(b, u)) > 0.5) continue;
    const r = V.cross(u, b); // colonnes r,u,b
    const m00 = r[0], m11 = u[1], m22 = b[2];
    const tr = m00 + m11 + m22; let q;
    if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(u[2] - b[1]) / s, (b[0] - r[2]) / s, (r[1] - u[0]) / s, 0.25 * s]; }
    else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; q = [0.25 * s, (u[0] + r[1]) / s, (b[0] + r[2]) / s, (u[2] - b[1]) / s]; }
    else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; q = [(u[0] + r[1]) / s, 0.25 * s, (b[1] + u[2]) / s, (b[0] - r[2]) / s]; }
    else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; q = [(b[0] + r[2]) / s, (b[1] + u[2]) / s, 0.25 * s, (r[1] - u[0]) / s]; }
    out.push(Q.norm(q));
  }
  return out;
})();

class Camera {
  constructor() { this.target = [0, 0, 0]; this.dist = 4.2; this.q = [0, 0, 0, 1]; this.fov = 32 * Math.PI / 180; this.w = 1; this.h = 1; }
  basis() { return { r: Q.rot(this.q, [1, 0, 0]), u: Q.rot(this.q, [0, 1, 0]), b: Q.rot(this.q, [0, 0, 1]) }; }
  eye() { const { b } = this.basis(); return V.add(this.target, V.scale(b, this.dist)); }
  matrices(sceneRadius = 1) {
    const { r, u, b } = this.basis(); const e = this.eye();
    const view = new Float32Array([r[0], u[0], b[0], 0, r[1], u[1], b[1], 0, r[2], u[2], b[2], 0, -V.dot(r, e), -V.dot(u, e), -V.dot(b, e), 1]);
    const near = Math.max(1e-4, (this.dist - sceneRadius * 3) * 0.5, this.dist * 0.002), far = this.dist + sceneRadius * 6 + 10;
    const f = 1 / Math.tan(this.fov / 2), a = this.w / this.h;
    const proj = new Float32Array([f / a, 0, 0, 0, 0, f, 0, 0, 0, 0, far / (near - far), -1, 0, 0, near * far / (near - far), 0]);
    return { view, proj, vp: mat4Mul(proj, view), eye: e };
  }
  ray(sx, sy) {
    const { r, u, b } = this.basis(); const t = Math.tan(this.fov / 2), a = this.w / this.h;
    const x = (2 * sx / this.w - 1) * t * a, y = (1 - 2 * sy / this.h) * t;
    return { o: this.eye(), d: V.norm([r[0] * x + u[0] * y - b[0], r[1] * x + u[1] * y - b[1], r[2] * x + u[2] * y - b[2]]) };
  }
  // taille monde d'un pixel à la profondeur du point p
  pixelSize(p) { const { b } = this.basis(); const depth = V.dot(V.sub(this.eye(), p), b); return 2 * Math.max(depth, 1e-4) * Math.tan(this.fov / 2) / this.h; }
  project(p) {
    const { r, u, b } = this.basis(); const d = V.sub(p, this.eye());
    const z = -V.dot(d, b); if (z <= 1e-6) return null; const t = Math.tan(this.fov / 2), a = this.w / this.h;
    return [(V.dot(d, r) / (z * t * a) * 0.5 + 0.5) * this.w, (0.5 - V.dot(d, u) / (z * t) * 0.5) * this.h, z];
  }
  orbit(dx, dy) {
    this.q = Q.norm(Q.mul(this.q, Q.mul(Q.axis([0, 1, 0], -dx * 0.0085), Q.axis([1, 0, 0], -dy * 0.0085))));
  }
  roll(a) { this.q = Q.norm(Q.mul(this.q, Q.axis([0, 0, 1], a))); }
  pan(dx, dy) { const { r, u } = this.basis(); const s = this.pixelSize(this.target); this.target = V.add(this.target, V.add(V.scale(r, -dx * s), V.scale(u, dy * s))); }
  zoom(f) { this.dist = Math.min(1e4, Math.max(1e-3, this.dist * f)); }
  snap() {
    let best = SNAPS[0], bd = -1;
    for (const s of SNAPS) { const d = Math.abs(s[0] * this.q[0] + s[1] * this.q[1] + s[2] * this.q[2] + s[3] * this.q[3]); if (d > bd) { bd = d; best = s; } }
    this.q = best.slice();
  }
  frame(min, max) {
    this.target = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const rad = Math.max(1e-3, V.len(V.sub(max, min)) / 2);
    this.dist = rad / Math.sin(this.fov / 2) * 1.08;
  }
  toJSON() { return { target: this.target, dist: this.dist, q: this.q }; }
  fromJSON(j) { if (!j) return; this.target = j.target; this.dist = j.dist; this.q = j.q; }
}

// ------------------------------------------------------------ WGSL
const SHADER = /* wgsl */`
struct Cam { vp: mat4x4f, view: mat4x4f, eye: vec4f, params: vec4f };
struct Obj { flags: vec4f, flags2: vec4f };
@group(0) @binding(0) var<uniform> cam: Cam;
@group(1) @binding(0) var<uniform> obj: Obj;
@group(1) @binding(1) var<storage, read> idx: array<u32>;
@group(1) @binding(2) var<storage, read> pos: array<f32>;
@group(1) @binding(3) var<storage, read> nrm: array<f32>;
@group(1) @binding(4) var<storage, read> col: array<u32>;
@group(1) @binding(5) var<storage, read> msk: array<f32>;
@group(1) @binding(6) var<storage, read> grp: array<u32>;

struct VO {
  @builtin(position) clip: vec4f,
  @location(0) n: vec3f,
  @location(1) c: vec4f,
  @location(2) m: f32,
  @location(3) bary: vec3f,
  @location(4) @interpolate(flat) g: u32,
  @location(5) @interpolate(flat) q: u32,
};

@vertex fn vs(@builtin(vertex_index) vi: u32) -> VO {
  var o: VO;
  let t = vi / 3u;
  let k = vi - t * 3u;
  let gg = grp[t];
  let v = idx[vi];
  let p = vec3f(pos[3u * v], pos[3u * v + 1u], pos[3u * v + 2u]);
  o.clip = cam.vp * vec4f(p, 1.0);
  if ((gg & 0x80000000u) != 0u) { o.clip = vec4f(0.0, 0.0, -2.0, 1.0); }
  o.n = vec3f(nrm[3u * v], nrm[3u * v + 1u], nrm[3u * v + 2u]);
  o.c = unpack4x8unorm(col[v]);
  o.m = msk[v];
  var b = vec3f(1.0, 0.0, 0.0);
  if (k == 1u) { b = vec3f(0.0, 1.0, 0.0); }
  if (k == 2u) { b = vec3f(0.0, 0.0, 1.0); }
  o.bary = b;
  o.g = gg & 0x0fffffffu;
  o.q = (gg >> 28u) & 7u;
  return o;
}

fn groupColor(g: u32) -> vec3f {
  var x = g * 747796405u + 2891336453u;
  x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  x = (x >> 22u) ^ x;
  let h = f32(x & 1023u) / 1023.0;
  let k = vec3f(1.0, 2.0 / 3.0, 1.0 / 3.0);
  let p = abs(fract(vec3f(h) + k) * 6.0 - 3.0);
  return mix(vec3f(1.0), clamp(p - 1.0, vec3f(0.0), vec3f(1.0)), 0.62) * 0.88;
}

// matcap procédural en espace vue (n.z vers la caméra)
fn shade(n: vec3f, base: vec3f, mat: f32) -> vec3f {
  let key = normalize(vec3f(-0.42, 0.62, 0.66));
  let fill = normalize(vec3f(0.75, -0.25, 0.45));
  let wrapK = select(0.35, 0.55, mat < 0.5);
  let d1 = clamp((dot(n, key) + wrapK) / (1.0 + wrapK), 0.0, 1.0);
  let d2 = max(dot(n, fill), 0.0);
  let h = normalize(key + vec3f(0.0, 0.0, 1.0));
  var specP = 30.0; var specK = 0.32; var rimK = 0.35; var amb = 0.22;
  if (mat > 0.5 && mat < 1.5) { specP = 12.0; specK = 0.06; rimK = 0.18; amb = 0.28; }
  if (mat > 1.5 && mat < 2.5) { specP = 48.0; specK = 0.16; rimK = 0.22; amb = 0.3; }
  if (mat > 2.5) { specP = 70.0; specK = 0.85; rimK = 0.55; amb = 0.14; }
  let spec = pow(max(dot(n, h), 0.0), specP) * specK;
  let rim = pow(1.0 - clamp(n.z, 0.0, 1.0), 3.0) * rimK;
  var c = base * (amb + 0.85 * d1 + 0.18 * d2);
  if (mat < 0.5) { c = c + vec3f(0.55, 0.12, 0.06) * pow(1.0 - d1, 2.0) * 0.25; }
  var specCol = vec3f(1.0, 0.95, 0.9);
  if (mat > 2.5) { specCol = base * 1.4 + vec3f(0.2); }
  return c + specCol * spec + vec3f(1.0, 0.92, 0.85) * rim * (0.4 + 0.6 * d1);
}

@fragment fn fs(i: VO, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  let fw = fwidth(i.bary);
  var n = normalize(i.n);
  if (!ff) { n = -n; }
  let nv = normalize((cam.view * vec4f(n, 0.0)).xyz);
  let mat = cam.params.x;
  var base = vec3f(0.66, 0.25, 0.18);
  if (mat > 0.5 && mat < 1.5) { base = vec3f(0.62, 0.6, 0.57); }
  if (mat > 1.5 && mat < 2.5) { base = vec3f(0.86, 0.85, 0.82); }
  if (mat > 2.5) { base = vec3f(0.55, 0.38, 0.2); }
  if (obj.flags.w > 0.5) { base = mix(base, i.c.rgb, i.c.a); }
  if (obj.flags.y > 0.5) { base = groupColor(i.g); }
  var c = shade(nv, base, mat);
  c = c * (1.0 - 0.62 * i.m);
  if (obj.flags.z > 0.5) {
    var a3 = smoothstep(vec3f(0.0), fw * 1.25, i.bary);
    if ((i.q & 1u) != 0u) { a3.x = 1.0; }
    if ((i.q & 2u) != 0u) { a3.y = 1.0; }
    if ((i.q & 4u) != 0u) { a3.z = 1.0; }
    let e = min(min(a3.x, a3.y), a3.z);
    c = mix(c * 0.32, c, e);
  }
  if (obj.flags.x < 0.5) { c = mix(c, vec3f(dot(c, vec3f(0.333))), 0.55) * 0.72; }
  if (!ff) { c = c * 0.55; }
  return vec4f(c, 1.0);
}
`;

// Traits 3D (Grease Pencil) : rubans orientés vers l'écran + capuchons ronds à chaque point
const GP_SHADER = /* wgsl */`
struct Cam { vp: mat4x4f, view: mat4x4f, eye: vec4f, params: vec4f };
@group(0) @binding(0) var<uniform> cam: Cam;
@group(1) @binding(0) var<storage, read> gpts: array<vec4f>;
@group(1) @binding(1) var<storage, read> gcol: array<u32>;
@group(1) @binding(2) var<storage, read> gseg: array<u32>;
struct GO { @builtin(position) clip: vec4f, @location(0) uv: vec2f, @location(1) col: vec4f, @location(2) @interpolate(flat) cap: u32 };

fn corner(vi: u32) -> vec2f {
  var c = array<vec2f, 6>(vec2f(0.0, -1.0), vec2f(0.0, 1.0), vec2f(1.0, 1.0), vec2f(0.0, -1.0), vec2f(1.0, 1.0), vec2f(1.0, -1.0));
  return c[vi];
}
// demi-épaisseur en unités clip (au moins ~0.6 px)
fn halfClip(r: f32, w: f32) -> f32 { return max(r * cam.params.w, 1.2 / cam.params.y * w); }

@vertex fn vsSeg(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> GO {
  var o: GO;
  let i0 = gseg[ii];
  let a = gpts[i0]; let b = gpts[i0 + 1u];
  let ca = cam.vp * vec4f(a.xyz, 1.0); let cb = cam.vp * vec4f(b.xyz, 1.0);
  let asp = cam.params.z / cam.params.y;
  let sa = ca.xy / max(ca.w, 1e-6) * vec2f(asp, 1.0);
  let sb = cb.xy / max(cb.w, 1e-6) * vec2f(asp, 1.0);
  var d = sb - sa;
  if (length(d) < 1e-7) { d = vec2f(1.0, 0.0); }
  d = normalize(d);
  let n = vec2f(-d.y, d.x);
  let k = corner(vi);
  var c = mix(ca, cb, k.x);
  let h = halfClip(mix(a.w, b.w, k.x), c.w);
  c = vec4f(c.xy + vec2f(n.x / asp, n.y) * k.y * h, c.zw);
  o.clip = c;
  o.uv = vec2f(0.0, k.y);
  o.col = mix(unpack4x8unorm(gcol[i0]), unpack4x8unorm(gcol[i0 + 1u]), k.x);
  o.cap = 0u;
  return o;
}
@vertex fn vsCap(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> GO {
  var o: GO;
  let p = gpts[ii];
  var c = cam.vp * vec4f(p.xyz, 1.0);
  let asp = cam.params.z / cam.params.y;
  let k = corner(vi);
  let uv = vec2f(k.x * 2.0 - 1.0, k.y);
  let h = halfClip(p.w, c.w);
  c = vec4f(c.xy + vec2f(uv.x / asp, uv.y) * h, c.zw);
  o.clip = c; o.uv = uv; o.col = unpack4x8unorm(gcol[ii]); o.cap = 1u;
  return o;
}
@fragment fn fsGP(i: GO) -> @location(0) vec4f {
  if (i.cap == 1u && dot(i.uv, i.uv) > 1.0) { discard; }
  return vec4f(i.col.rgb, 1.0);
}
`;

class Renderer {
  async init(canvas) {
    if (!navigator.gpu) throw new Error('WebGPU n’est pas disponible dans ce navigateur.');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('Aucun adaptateur WebGPU trouvé.');
    const lim = adapter.limits;
    this.device = await adapter.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: lim.maxStorageBufferBindingSize, maxBufferSize: lim.maxBufferSize } });
    this.maxBind = this.device.limits.maxStorageBufferBindingSize;
    this.device.lost.then((info) => { this.lost = info; if (this.onLost) this.onLost(info); });
    this.canvas = canvas;
    this.ctx = canvas.getContext('webgpu');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.ctx.configure({ device: this.device, format: this.format, alphaMode: 'premultiplied' });
    const d = this.device;
    this.camBuf = d.createBuffer({ size: 160, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.bgl0 = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
    const st = { type: 'read-only-storage' };
    this.bgl1 = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: st },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: st },
        { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: st },
        { binding: 4, visibility: GPUShaderStage.VERTEX, buffer: st },
        { binding: 5, visibility: GPUShaderStage.VERTEX, buffer: st },
        { binding: 6, visibility: GPUShaderStage.VERTEX, buffer: st },
      ],
    });
    this.bg0 = d.createBindGroup({ layout: this.bgl0, entries: [{ binding: 0, resource: { buffer: this.camBuf } }] });
    const module = d.createShaderModule({ code: SHADER });
    if (module.getCompilationInfo) {
      const info = await module.getCompilationInfo();
      const errs = info.messages.filter((m) => m.type === 'error');
      if (errs.length) throw new Error('Shader : ' + errs.map((m) => m.lineNum + ': ' + m.message).join('\n'));
    }
    this.pipeline = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.bgl0, this.bgl1] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
      multisample: { count: 4 },
    });
    // pipelines des traits 3D : avec test de profondeur, ou toujours au premier plan
    const gm = d.createShaderModule({ code: GP_SHADER });
    if (gm.getCompilationInfo) {
      const info = await gm.getCompilationInfo();
      const errs = info.messages.filter((m) => m.type === 'error');
      if (errs.length) throw new Error('Shader traits : ' + errs.map((m) => m.lineNum + ': ' + m.message).join('\n'));
    }
    this.bglGP = d.createBindGroupLayout({ entries: [0, 1, 2].map((b) => ({ binding: b, visibility: GPUShaderStage.VERTEX, buffer: st })) });
    const gpLayout = d.createPipelineLayout({ bindGroupLayouts: [this.bgl0, this.bglGP] });
    const mk = (entry, always) => d.createRenderPipeline({
      layout: gpLayout,
      vertex: { module: gm, entryPoint: entry },
      fragment: { module: gm, entryPoint: 'fsGP', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: always ? 'always' : 'less-equal' },
      multisample: { count: 4 },
    });
    this.gpPipes = { seg: mk('vsSeg', false), cap: mk('vsCap', false), segFront: mk('vsSeg', true), capFront: mk('vsCap', true) };
    this.gpSlots = {};
    this.size = [0, 0];
  }
  // Envoie un lot de traits (GP.buildBatch) dans l'emplacement nommé
  syncGP(name, batch) {
    const d = this.device; let s = this.gpSlots[name];
    const need = [batch.pts.byteLength, batch.col.byteLength, batch.seg.byteLength];
    if (!s || need.some((n, i) => n > s.cap[i])) {
      if (s) for (const b of s.bufs) b.destroy();
      const cap = need.map((n) => Math.max(256, 1 << Math.ceil(Math.log2(n))));
      const bufs = cap.map((n) => d.createBuffer({ size: n, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));
      s = this.gpSlots[name] = { cap, bufs, bg: d.createBindGroup({ layout: this.bglGP, entries: bufs.map((b, i) => ({ binding: i, resource: { buffer: b } })) }) };
    }
    d.queue.writeBuffer(s.bufs[0], 0, batch.pts); d.queue.writeBuffer(s.bufs[1], 0, batch.col); d.queue.writeBuffer(s.bufs[2], 0, batch.seg);
    s.np = batch.np; s.ns = batch.ns;
  }
  resize(w, h) {
    if (w === this.size[0] && h === this.size[1] && this.msaa) return;
    this.size = [w, h];
    if (this.msaa) { this.msaa.destroy(); this.depth.destroy(); }
    this.msaa = this.device.createTexture({ size: [w, h], sampleCount: 4, format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.depth = this.device.createTexture({ size: [w, h], sampleCount: 4, format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT });
  }
  _buf(bytes) { return this.device.createBuffer({ size: Math.max(16, (bytes + 3) & ~3), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }); }
  releaseLevel(L) {
    const g = L.gpu; if (!g) return;
    for (const k of ['idx', 'pos', 'nrm', 'col', 'msk', 'grp', 'uni']) g[k].destroy();
    L.gpu = null;
  }
  // Crée / met à jour les buffers GPU d'un niveau (L.nrm doit exister)
  syncLevel(L) {
    const d = this.device, q = d.queue;
    if (L.nt * 12 > this.maxBind) throw new Error('Maillage trop lourd pour ce GPU (' + (L.nt / 1e6).toFixed(1) + ' M faces).');
    let g = L.gpu;
    if (!g || g.nv !== L.nv || g.nt !== L.nt || g.idxRef !== L.idx) {
      if (g) this.releaseLevel(L);
      g = L.gpu = {
        nv: L.nv, nt: L.nt, idxRef: L.idx,
        idx: this._buf(L.nt * 12), pos: this._buf(L.nv * 12), nrm: this._buf(L.nv * 12), col: this._buf(L.nv * 4), msk: this._buf(L.nv * 4), grp: this._buf(L.nt * 4),
        uni: d.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      };
      g.bg = d.createBindGroup({
        layout: this.bgl1, entries: [
          { binding: 0, resource: { buffer: g.uni } }, { binding: 1, resource: { buffer: g.idx } }, { binding: 2, resource: { buffer: g.pos } },
          { binding: 3, resource: { buffer: g.nrm } }, { binding: 4, resource: { buffer: g.col } }, { binding: 5, resource: { buffer: g.msk } }, { binding: 6, resource: { buffer: g.grp } },
        ],
      });
      q.writeBuffer(g.idx, 0, L.idx);
      root.Core.fullDirty(L);
    }
    const D = L.dirty; if (!D) return;
    const DB = root.Core.DB, nv = L.nv;
    const runs = (blocks, fn) => {
      if (!blocks) return;
      for (let i = 0; i < blocks.length;) {
        if (!blocks[i]) { i++; continue; }
        let j = i; while (j < blocks.length && blocks[j]) j++;
        const a = i * DB, b = Math.min(nv, j * DB); if (b > a) fn(a, b - a);
        i = j;
      }
    };
    runs(D.pos, (a, n) => { q.writeBuffer(g.pos, a * 12, L.pos, a * 3, n * 3); q.writeBuffer(g.nrm, a * 12, L.nrm, a * 3, n * 3); });
    const c32 = new Uint32Array(L.col.buffer, L.col.byteOffset, nv);
    runs(D.col, (a, n) => q.writeBuffer(g.col, a * 4, c32, a, n));
    runs(D.mask, (a, n) => q.writeBuffer(g.msk, a * 4, L.mask, a, n));
    if (D.groups) {
      const tmp = new Uint32Array(L.nt);
      const qf = L.qflags && L.qflags.length === L.nt ? L.qflags : null;
      for (let t = 0; t < L.nt; t++) tmp[t] = (L.groups[t] & 0x0fffffff) | (qf ? (qf[t] & 7) << 28 : 0) | (L.hidden && L.hidden[t] ? 0x80000000 : 0);
      q.writeBuffer(g.grp, 0, tmp);
    }
    L.dirty = null;
  }
  // items: [{level, active, groups, wire, paint}]
  draw(cam, items, material, sceneRadius, gp) {
    const d = this.device; if (this.lost) return;
    const m = cam.matrices(sceneRadius);
    const cb = new Float32Array(40);
    cb.set(m.vp, 0); cb.set(m.view, 16); cb.set([m.eye[0], m.eye[1], m.eye[2], 1], 32); cb.set([material, cam.h, cam.w, m.proj[5]], 36);
    d.queue.writeBuffer(this.camBuf, 0, cb);
    for (const it of items) {
      this.syncLevel(it.level);
      d.queue.writeBuffer(it.level.gpu.uni, 0, new Float32Array([it.active ? 1 : 0, it.groups ? 1 : 0, it.wire ? 1 : 0, it.paint ? 1 : 0, 0, 0, 0, 0]));
    }
    const enc = d.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.msaa.createView(), resolveTarget: this.ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'discard', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
      depthStencilAttachment: { view: this.depth.createView(), depthLoadOp: 'clear', depthStoreOp: 'discard', depthClearValue: 1 },
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bg0);
    for (const it of items) { pass.setBindGroup(1, it.level.gpu.bg); pass.draw(it.level.nt * 3); }
    if (gp) for (const name of gp.slots) {
      const s = this.gpSlots[name]; if (!s || !s.np) continue;
      pass.setBindGroup(1, s.bg);
      if (s.ns) { pass.setPipeline(gp.front ? this.gpPipes.segFront : this.gpPipes.seg); pass.draw(6, s.ns); }
      pass.setPipeline(gp.front ? this.gpPipes.capFront : this.gpPipes.cap); pass.draw(6, s.np);
    }
    pass.end();
    d.queue.submit([enc.finish()]);
  }
}

root.Render = { V, Q, Camera, Renderer, mat4Mul };
})(typeof window !== 'undefined' ? window : globalThis);
