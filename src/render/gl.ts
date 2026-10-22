import { ERROR_PARTICLE, OK_PARTICLE, SLOW_PARTICLE, WARNING, healthColor, mix, serviceColor, type RGB } from '../app/palette';
import { FLARE_MS, TRAVEL_MS, type Engine, type Particle } from '../app/engine';
import type { ForceLayout } from '../layout/force';
import type { GlobeView } from '../geo/globe';
import { LAND_H, LAND_W, landMask } from '../geo/land';
import type { GeoEvent } from '../live/geo';
import { edgeCurve, ease, pointOn, type Curve } from './curve';
import type { View } from './view';

const QUAD_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aCorner;
layout(location=1) in vec3 aCenterSize;
layout(location=2) in vec4 aColor;
layout(location=3) in vec2 aShape;
uniform vec2 uViewport;
out vec2 vUv;
out vec4 vColor;
out vec2 vShape;
void main() {
  vec2 px = aCenterSize.xy + aCorner * aCenterSize.z;
  vec2 clip = (px / uViewport) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  vUv = aCorner;
  vColor = aColor;
  vShape = aShape;
}`;

// shape 0: glow sprite (param: hot-core strength) · 1: node orb (param: halo strength)
// shape 2: expanding ring (param: progress 0..1) · 3: dust mote
const QUAD_FS = `#version 300 es
precision highp float;
in vec2 vUv;
in vec4 vColor;
in vec2 vShape;
out vec4 o;
const float BODY = 0.42;
void main() {
  float r = length(vUv);
  if (r >= 1.0) discard;
  vec3 c = vColor.rgb;
  float a = vColor.a;
  float p = vShape.y;
  if (vShape.x < 0.5) {
    float glow = exp(-r * r * 6.0);
    float core = exp(-r * r * 70.0) * p;
    o = vec4((c * glow * 0.7 + mix(c, vec3(1.0), 0.6) * core * 1.3) * a, 0.0);
  } else if (vShape.x < 1.5) {
    float d = r / BODY;
    float inside = 1.0 - smoothstep(1.0 - 1.5 * fwidth(d), 1.0, d);
    vec2 q = vUv / BODY;
    float z = sqrt(max(0.0, 1.0 - min(1.0, d * d)));
    float lambert = max(0.0, dot(vec3(q, z), normalize(vec3(-0.5, -0.6, 0.65))));
    float rim = pow(1.0 - z, 2.5);
    vec3 body = vec3(0.016, 0.028, 0.058) + c * (0.05 + 0.2 * lambert) * a + c * rim * 0.85 * a + vec3(pow(lambert, 40.0) * 0.22);
    float halo = exp(-max(0.0, r - BODY) / (1.0 - BODY) * 4.0) * (1.0 - smoothstep(0.82, 1.0, r));
    o = vec4(body * inside + c * halo * p * a * (1.0 - inside), inside);
  } else if (vShape.x < 2.5) {
    float radius = mix(0.35, 0.95, p);
    float w = mix(0.1, 0.03, p);
    float ring = exp(-pow((r - radius) / w, 2.0));
    o = vec4(c * ring * (1.0 - p) * (1.0 - p) * a, 0.0);
  } else {
    o = vec4(c * exp(-r * r * 9.0) * a, 0.0);
  }
}`;

const RIBBON_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
layout(location=1) in vec2 aUv;
layout(location=2) in vec4 aColor;
layout(location=3) in float aFlow;
uniform vec2 uViewport;
out vec2 vUv;
out vec4 vColor;
out float vFlow;
void main() {
  vec2 clip = (aPos / uViewport) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  vUv = aUv;
  vColor = aColor;
  vFlow = aFlow;
}`;

// uv.x: distance along the ribbon in px, uv.y: -1..1 across it. Flow > 0 scrolls energy pulses along it.
const RIBBON_FS = `#version 300 es
precision highp float;
in vec2 vUv;
in vec4 vColor;
in float vFlow;
uniform float uTime;
uniform float uDpr;
out vec4 o;
void main() {
  float x = abs(vUv.y);
  float glow = exp(-x * x * 5.0);
  float core = exp(-x * x * 55.0);
  float pulse = 0.0;
  if (vFlow > 0.0) {
    float ph = fract((vUv.x - uTime * vFlow) / (64.0 * uDpr));
    pulse = smoothstep(0.0, 0.06, ph) * (1.0 - smoothstep(0.06, 0.45, ph));
  }
  float k = glow * 0.22 + core * 0.8 + pulse * (glow * 0.35 + core * 1.0);
  o = vec4(vColor.rgb * k * vColor.a, 0.0);
}`;

// The planet: an orthographic sphere with a dot-matrix land mask, ocean shading, rim light and atmosphere.
const GLOBE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
in vec4 vColor;
in vec2 vShape;
uniform sampler2D uLand;
uniform vec2 uRot;
uniform float uScale;
uniform float uDots;
out vec4 o;
void main() {
  vec2 p = vUv * uScale;
  float d = length(p);
  float inside = 1.0 - smoothstep(1.0 - fwidth(d) * 1.5, 1.0, d);
  float atmo = exp(-max(0.0, d - 1.0) * 8.0) * (1.0 - smoothstep(uScale * 0.8, uScale, d));
  vec3 air = vec3(0.2, 0.48, 1.0) * atmo * 0.16;
  if (d >= 1.0) { o = vec4(air, 0.0); return; }
  float z = sqrt(max(0.0, 1.0 - d * d));
  vec3 n = vec3(p.x, -p.y, z);
  float ct = cos(uRot.y), st = sin(uRot.y);
  vec3 a = vec3(n.x, n.y * ct + n.z * st, -n.y * st + n.z * ct);
  float cl = cos(uRot.x), sl = sin(uRot.x);
  vec3 w = vec3(a.x * cl + a.z * sl, a.y, -a.x * sl + a.z * cl);
  float lat = degrees(asin(clamp(w.y, -1.0, 1.0)));
  float lon = degrees(atan(w.x, w.z));
  float row = floor((lat + 90.0) / uDots);
  float rowLat = (row + 0.5) * uDots - 90.0;
  float cols = max(1.0, floor(360.0 * cos(radians(rowLat)) / uDots));
  float lonStep = 360.0 / cols;
  float colLon = (floor((lon + 180.0) / lonStep) + 0.5) * lonStep - 180.0;
  float land = step(0.5, texture(uLand, vec2((colLon + 180.0) / 360.0, (90.0 - rowLat) / 180.0)).r);
  float dist = length(vec2(lat - rowLat, (lon - colLon) * cos(radians(lat)))) / uDots;
  float aa = clamp(fwidth(dist), 0.02, 0.3);
  float dotMask = 1.0 - smoothstep(0.3 - aa, 0.3 + aa, dist);
  float light = 0.35 + 0.65 * max(0.0, dot(n, normalize(vec3(-0.45, 0.55, 0.75))));
  vec3 ocean = vec3(0.008, 0.022, 0.055) + vec3(0.012, 0.045, 0.1) * z;
  vec3 dots = vec3(0.3, 0.6, 1.0) * light * mix(0.3, 1.0, z);
  vec3 col = ocean + dots * dotMask * land * 0.75 + vec3(0.16, 0.4, 1.0) * pow(1.0 - z, 4.0) * 0.28;
  o = vec4(col * inside + air * (1.0 - inside), inside);
}`;

const FULL_VS = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const DOWN_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexel;
out vec4 o;
void main() {
  vec3 s = texture(uTex, vUv).rgb * 4.0;
  s += texture(uTex, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  s += texture(uTex, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  s += texture(uTex, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
  s += texture(uTex, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  o = vec4(s / 8.0, 1.0);
}`;

const UP_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexel;
out vec4 o;
void main() {
  vec2 h = uTexel;
  vec3 s = texture(uTex, vUv + vec2(-2.0 * h.x, 0.0)).rgb;
  s += texture(uTex, vUv + vec2(-h.x, h.y)).rgb * 2.0;
  s += texture(uTex, vUv + vec2(0.0, 2.0 * h.y)).rgb;
  s += texture(uTex, vUv + vec2(h.x, h.y)).rgb * 2.0;
  s += texture(uTex, vUv + vec2(2.0 * h.x, 0.0)).rgb;
  s += texture(uTex, vUv + vec2(h.x, -h.y)).rgb * 2.0;
  s += texture(uTex, vUv + vec2(0.0, -2.0 * h.y)).rgb;
  s += texture(uTex, vUv + vec2(-h.x, -h.y)).rgb * 2.0;
  o = vec4(s / 12.0, 1.0);
}`;

const COMPOSITE_FS = `#version 300 es
precision highp float;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform vec2 uRes;
uniform float uDpr;
uniform vec2 uCenter;
uniform float uZoom;
uniform float uBloomGain;
out vec4 o;
float gridLine(vec2 world, float cell, float zoom) {
  vec2 g = abs(fract(world / cell - 0.5) - 0.5) * cell * zoom;
  return 1.0 - smoothstep(0.0, 1.0, min(g.x, g.y));
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 css = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uDpr;
  vec2 world = (css - 0.5 * uRes / uDpr) / uZoom + uCenter;

  float glowA = 1.0 - smoothstep(0.0, 1.1, length((uv - vec2(0.36, 0.64)) * vec2(1.5, 1.0)));
  float glowB = 1.0 - smoothstep(0.0, 0.9, length((uv - vec2(0.82, 0.18)) * vec2(1.3, 1.0)));
  vec3 bg = vec3(0.012, 0.02, 0.043) + vec3(0.02, 0.045, 0.09) * glowA + vec3(0.035, 0.022, 0.07) * glowB;
  float minor = gridLine(world, 48.0, uZoom) * smoothstep(9.0, 26.0, 48.0 * uZoom);
  float major = gridLine(world, 192.0, uZoom);
  bg += vec3(0.24, 0.42, 0.78) * (minor * 0.022 + major * 0.045);
  float vig = smoothstep(1.3, 0.3, length((uv - 0.5) * vec2(1.2, 1.0)));
  bg *= mix(0.45, 1.0, vig);

  vec4 s = texture(uScene, uv);
  vec3 light = s.rgb + texture(uBloom, uv).rgb * uBloomGain;
  vec3 mapped = vec3(1.0) - exp(-light * 1.1);
  vec3 col = bg * (1.0 - s.a) + mapped;
  col += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
  o = vec4(col, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const mk = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error');
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link error');
  return p;
}

/** Growable float buffer that is reused frame to frame. */
class Batch {
  data: Float32Array;
  n = 0;
  constructor(readonly stride: number, capacity: number) {
    this.data = new Float32Array(stride * capacity);
  }
  reserve(count: number): void {
    const need = this.n + count * this.stride;
    if (need <= this.data.length) return;
    const next = new Float32Array(Math.max(need, this.data.length * 2));
    next.set(this.data.subarray(0, this.n));
    this.data = next;
  }
  get count(): number {
    return this.n / this.stride;
  }
}

interface Target { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number }

interface Programs {
  quad: WebGLProgram;
  ribbon: WebGLProgram;
  down: WebGLProgram;
  up: WebGLProgram;
  composite: WebGLProgram;
  globe: WebGLProgram;
}

const QUAD_STRIDE = 9;
const RIBBON_STRIDE = 9;
const EDGE_SEGMENTS = 28;
const TRAIL_POINTS = 10;
const TRAIL_SPAN = 0.17;
const BLOOM_LEVELS = 5;
const DUST = 240;
const BODY = 0.42;

const WHITE: RGB = [255, 255, 255];
const GLOBE_SCALE = 1.32;
/** A located change: arcs from its wiki to the globe, pulses, then lingers as a fading pin. */
export const GEO_ARC_MS = 900;
const GEO_PULSE_MS = 2600;
export const GEO_LINGER_MS = 600_000;

/**
 * Everything emissive is drawn here: a parallax dust field, edge beams with
 * flowing pulses, glass node orbs, particles with comet trails and arrival
 * flares. The scene renders into an offscreen (half-float when available)
 * buffer, gets a dual-filter bloom, and is tone-mapped over a background
 * with a world-anchored grid. Text and crisp rings are the Canvas 2D overlay's job.
 */
export class GlRenderer {
  private gl: WebGL2RenderingContext;
  private programs!: Programs;
  private uniforms = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  private quadVao!: WebGLVertexArrayObject;
  private ribbonVao!: WebGLVertexArrayObject;
  private emptyVao!: WebGLVertexArrayObject;
  private quadInstances!: WebGLBuffer;
  private ribbonVerts!: WebGLBuffer;
  private scene: Target | null = null;
  private bloom: Target[] = [];
  private hdr = false;
  private lost = false;
  private time = 0;
  private readonly quads = new Batch(QUAD_STRIDE, 4096);
  private readonly ribbons = new Batch(RIBBON_STRIDE, 16384);
  private readonly curve: Curve = { ax: 0, ay: 0, cx: 0, cy: 0, bx: 0, by: 0 };
  private readonly pt: [number, number] = [0, 0];
  private readonly px = new Float32Array(64);
  private readonly py = new Float32Array(64);
  private readonly pw = new Float32Array(64);
  private readonly pa = new Float32Array(64);
  private readonly pc = new Float32Array(64 * 3);
  private readonly dust = new Float32Array(DUST * 6);
  /** Trace id whose path is highlighted (selected in the waterfall). */
  highlightTrace: string | null = null;
  hoverEdge: string | null = null;
  globe: GlobeView | null = null;
  geo: readonly GeoEvent[] = [];
  /** [lat, lon, edits, flagged] per 1° cell: where geotagged pages were edited over the history window. */
  cells: Iterable<readonly [number, number, number, number]> = [];
  private land!: WebGLTexture;
  private readonly g3: [number, number, number] = [0, 0, 0];
  private readonly h3: [number, number, number] = [0, 0, 0];
  /** Freezes ambient motion: background drift, edge pulses, node pulsing, trails and flares. */
  reducedMotion = false;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: true, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is required.');
    this.gl = gl;
    let seed = 0x9e3779b9;
    const rand = () => ((seed = Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 4294967296;
    for (let i = 0; i < DUST; i++) {
      const o = i * 6;
      this.dust[o] = rand();
      this.dust[o + 1] = rand();
      this.dust[o + 2] = 0.12 + Math.pow(rand(), 2) * 0.55; // parallax depth
      this.dust[o + 3] = 0.6 + rand() * 1.6;                 // size
      this.dust[o + 4] = rand() * Math.PI * 2;               // twinkle phase
      this.dust[o + 5] = rand();                             // hue
    }
    this.init();
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    canvas.addEventListener('webglcontextrestored', () => {
      this.uniforms.clear();
      this.scene = null;
      this.bloom = [];
      this.init();
      this.lost = false;
      this.resize(canvas.width, canvas.height, 1);
    });
  }

  private init(): void {
    const gl = this.gl;
    this.hdr = !!gl.getExtension('EXT_color_buffer_float');
    this.programs = {
      quad: compile(gl, QUAD_VS, QUAD_FS),
      ribbon: compile(gl, RIBBON_VS, RIBBON_FS),
      down: compile(gl, FULL_VS, DOWN_FS),
      up: compile(gl, FULL_VS, UP_FS),
      composite: compile(gl, FULL_VS, COMPOSITE_FS),
      globe: compile(gl, QUAD_VS, GLOBE_FS),
    };

    const quad = gl.createBuffer()!;
    this.quadInstances = gl.createBuffer()!;
    this.quadVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadInstances);
    const qs = QUAD_STRIDE * 4;
    for (const [loc, size, offset] of [[1, 3, 0], [2, 4, 12], [3, 2, 28]] as const) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, qs, offset);
      gl.vertexAttribDivisor(loc, 1);
    }

    this.ribbonVerts = gl.createBuffer()!;
    this.ribbonVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.ribbonVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ribbonVerts);
    const rs = RIBBON_STRIDE * 4;
    for (const [loc, size, offset] of [[0, 2, 0], [1, 2, 8], [2, 4, 16], [3, 1, 32]] as const) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, rs, offset);
    }
    this.emptyVao = gl.createVertexArray()!;
    this.land = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.land);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, LAND_W, LAND_H, 0, gl.RED, gl.UNSIGNED_BYTE, landMask());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindVertexArray(null);
  }

  private u(program: WebGLProgram, name: string): WebGLUniformLocation | null {
    let m = this.uniforms.get(program);
    if (!m) this.uniforms.set(program, (m = new Map()));
    if (!m.has(name)) m.set(name, this.gl.getUniformLocation(program, name));
    return m.get(name)!;
  }

  private makeTarget(w: number, h: number): Target {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (this.hdr) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (this.hdr && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      // Some drivers expose the extension but refuse the format; fall back to 8-bit for good.
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
      this.hdr = false;
      return this.makeTarget(w, h);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, w, h };
  }

  private freeTarget(t: Target | null): void {
    if (!t) return;
    this.gl.deleteFramebuffer(t.fbo);
    this.gl.deleteTexture(t.tex);
  }

  resize(width: number, height: number, dpr: number): void {
    const w = Math.max(1, Math.round(width * dpr));
    const h = Math.max(1, Math.round(height * dpr));
    this.canvas.width = w;
    this.canvas.height = h;
    if (this.lost) return;
    this.freeTarget(this.scene);
    for (const t of this.bloom) this.freeTarget(t);
    this.scene = this.makeTarget(w, h);
    this.bloom = [];
    for (let i = 1; i <= BLOOM_LEVELS; i++) this.bloom.push(this.makeTarget(Math.max(1, w >> i), Math.max(1, h >> i)));
  }

  render(engine: Engine, layout: ForceLayout, view: View, now: number, dpr: number, timeSec: number): void {
    const gl = this.gl;
    if (this.lost || !this.scene || gl.isContextLost()) return;
    const time = this.reducedMotion ? 0 : timeSec;
    this.time = time;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fbo);
    gl.viewport(0, 0, this.scene.w, this.scene.h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    this.drawDust(view, dpr, time);
    if (this.globe?.visible) this.drawGlobe(this.globe, dpr);
    this.drawEdges(engine, layout, view, now, dpr);
    this.drawParticles(engine, layout, view, now, dpr);
    this.drawNodes(engine, layout, view, now, dpr, time);
    if (this.globe?.visible) this.drawGeo(this.globe, layout, view, now, dpr);
    if (!this.reducedMotion) this.drawFlares(engine, layout, view, now, dpr);

    this.bloomPasses();
    this.composite(view, dpr);
  }

  // ------------------------------------------------------------ geometry
  private pushQuad(x: number, y: number, r: number, c: RGB, a: number, shape: number, param: number): void {
    const b = this.quads;
    b.reserve(1);
    const d = b.data;
    let n = b.n;
    d[n++] = x; d[n++] = y; d[n++] = r;
    d[n++] = c[0] / 255; d[n++] = c[1] / 255; d[n++] = c[2] / 255; d[n++] = a;
    d[n++] = shape; d[n++] = param;
    b.n = n;
  }

  private flushQuads(program?: WebGLProgram): void {
    const b = this.quads;
    if (b.n === 0) return;
    const gl = this.gl;
    const p = program ?? this.programs.quad;
    gl.useProgram(p);
    gl.uniform2f(this.u(p, 'uViewport'), this.scene!.w, this.scene!.h);
    gl.bindVertexArray(this.quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadInstances);
    gl.bufferData(gl.ARRAY_BUFFER, b.data.subarray(0, b.n), gl.DYNAMIC_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, b.count);
    b.n = 0;
  }

  /** Builds a ribbon through the first `count` points of px/py with per-point width, alpha and colour. */
  private pushRibbon(count: number, flow: number): void {
    if (count < 2) return;
    const b = this.ribbons;
    b.reserve((count - 1) * 6);
    const d = b.data;
    const { px, py, pw, pa, pc } = this;
    let along = 0;
    let lx = 0, ly = 0, rx = 0, ry = 0, lAlong = 0;
    for (let i = 0; i < count; i++) {
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(count - 1, i + 1);
      let tx = px[i1]! - px[i0]!;
      let ty = py[i1]! - py[i0]!;
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl; ty /= tl;
      const hw = pw[i]! * 0.5;
      const nlx = px[i]! - ty * hw, nly = py[i]! + tx * hw;
      const nrx = px[i]! + ty * hw, nry = py[i]! - tx * hw;
      if (i > 0) {
        along += Math.hypot(px[i]! - px[i - 1]!, py[i]! - py[i - 1]!);
        const ca = i - 1, cb = i;
        let n = b.n;
        const put = (x: number, y: number, u: number, v: number, ci: number) => {
          d[n++] = x; d[n++] = y; d[n++] = u; d[n++] = v;
          d[n++] = pc[ci * 3]!; d[n++] = pc[ci * 3 + 1]!; d[n++] = pc[ci * 3 + 2]!; d[n++] = pa[ci]!;
          d[n++] = flow;
        };
        put(lx, ly, lAlong, -1, ca); put(rx, ry, lAlong, 1, ca); put(nlx, nly, along, -1, cb);
        put(rx, ry, lAlong, 1, ca); put(nrx, nry, along, 1, cb); put(nlx, nly, along, -1, cb);
        b.n = n;
      }
      lx = nlx; ly = nly; rx = nrx; ry = nry; lAlong = along;
    }
  }

  private flushRibbons(dpr: number): void {
    const b = this.ribbons;
    if (b.n === 0) return;
    const gl = this.gl;
    const p = this.programs.ribbon;
    gl.useProgram(p);
    gl.uniform2f(this.u(p, 'uViewport'), this.scene!.w, this.scene!.h);
    gl.uniform1f(this.u(p, 'uTime'), this.time);
    gl.uniform1f(this.u(p, 'uDpr'), dpr);
    gl.bindVertexArray(this.ribbonVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ribbonVerts);
    gl.bufferData(gl.ARRAY_BUFFER, b.data.subarray(0, b.n), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, b.count);
    b.n = 0;
  }

  private setPointColor(i: number, c: RGB): void {
    this.pc[i * 3] = c[0] / 255;
    this.pc[i * 3 + 1] = c[1] / 255;
    this.pc[i * 3 + 2] = c[2] / 255;
  }

  // ---------------------------------------------------------------- dust
  private drawDust(view: View, dpr: number, time: number): void {
    const w = view.width + 80;
    const h = view.height + 80;
    for (let i = 0; i < DUST; i++) {
      const o = i * 6;
      const depth = this.dust[o + 2]!;
      // Far motes barely move when panning, near ones move more: cheap depth.
      const sx = this.dust[o]! * w - view.centerX * view.zoom * depth + time * 4 * depth;
      const sy = this.dust[o + 1]! * h - view.centerY * view.zoom * depth;
      const x = (((sx % w) + w) % w) - 40;
      const y = (((sy % h) + h) % h) - 40;
      const tw = this.reducedMotion ? 0.8 : 0.55 + 0.45 * Math.sin(time * (0.6 + depth) + this.dust[o + 4]!);
      const hue = this.dust[o + 5]!;
      const c: RGB = hue < 0.6 ? [120, 170, 255] : hue < 0.85 ? [160, 140, 255] : [120, 230, 220];
      this.pushQuad(x * dpr, y * dpr, this.dust[o + 3]! * (1.6 + depth * 2.4) * dpr, c, (0.05 + depth * 0.22) * tw, 3, 0);
    }
    this.flushQuads();
  }

  // --------------------------------------------------------------- edges
  private litEdges(engine: Engine): Set<string> {
    const set = new Set<string>();
    const trace = engine.selectedTrace;
    if (!trace || this.highlightTrace !== trace.traceId) return set;
    const byId = new Map(trace.spans.map((s) => [s.spanId, s]));
    for (const s of trace.spans) {
      const p = s.parentSpanId ? byId.get(s.parentSpanId) : undefined;
      if (p && p.service !== s.service) set.add(`${p.service}→${s.service}`);
    }
    return set;
  }

  private drawEdges(engine: Engine, layout: ForceLayout, view: View, now: number, dpr: number): void {
    const lit = this.litEdges(engine);
    const sel = engine.selectedService;
    const focus = lit.size > 0 || sel !== null;
    const zoomScale = Math.min(1.4, Math.max(0.55, Math.sqrt(view.zoom)));
    for (const e of engine.topology.edges.values()) {
      const a = layout.nodes.get(e.source);
      const b = layout.nodes.get(e.target);
      if (!a || !b) continue;
      const [ax, ay] = view.toScreen(a.x, a.y);
      const [bx, by] = view.toScreen(b.x, b.y);
      edgeCurve(ax * dpr, ay * dpr, bx * dpr, by * dpr, this.curve);

      const rps = e.requests.rate(now, 10);
      const err = rps > 0 ? e.errors.rate(now, 10) / rps : 0;
      const isLit = lit.has(e.id) || this.hoverEdge === e.id || (sel !== null && (e.source === sel || e.target === sel));
      const dim = focus && !isLit ? 0.3 : 1;
      const alpha = (isLit ? 0.95 : 0.16 + Math.min(0.32, rps * 0.025)) * dim;
      const width = (isLit ? 16 : 9 + Math.min(9, rps * 0.9)) * zoomScale * dpr;
      const ca = mix(mix(OK_PARTICLE, serviceColor(e.source), 0.55), healthColor(err), err > 0.01 ? 0.85 : 0);
      const cb = mix(mix(OK_PARTICLE, serviceColor(e.target), 0.55), healthColor(err), err > 0.01 ? 0.85 : 0);
      const flow = this.reducedMotion || rps < 0.05 ? 0 : (40 + Math.min(150, rps * 14)) * dpr;

      for (let i = 0; i <= EDGE_SEGMENTS; i++) {
        const t = i / EDGE_SEGMENTS;
        pointOn(this.curve, t, this.pt);
        this.px[i] = this.pt[0];
        this.py[i] = this.pt[1];
        this.pw[i] = width;
        // Fade in from the source so the direction of flow reads at a glance.
        this.pa[i] = alpha * (0.35 + 0.65 * Math.min(1, t * 2));
        this.setPointColor(i, mix(ca, cb, t));
      }
      this.pushRibbon(EDGE_SEGMENTS + 1, flow);
    }
    this.flushRibbons(dpr);
  }

  // ----------------------------------------------------------- particles
  private particleColor(p: Particle): RGB {
    if (p.status === 'error') return ERROR_PARTICLE;
    if (p.status === 'slow') return SLOW_PARTICLE;
    if (p.backward) return mix(OK_PARTICLE, serviceColor(p.edge.target), 0.5);
    return mix(OK_PARTICLE, serviceColor(p.edge.source), p.oneWay ? 0.4 : 0.2);
  }

  private particleCurve(p: Particle, layout: ForceLayout, view: View, dpr: number): boolean {
    const a = layout.nodes.get(p.edge.source);
    const b = layout.nodes.get(p.edge.target);
    if (!a || !b) return false;
    const [ax, ay] = view.toScreen(a.x, a.y);
    const [bx, by] = view.toScreen(b.x, b.y);
    if (p.backward) edgeCurve(bx * dpr, by * dpr, ax * dpr, ay * dpr, this.curve);
    else edgeCurve(ax * dpr, ay * dpr, bx * dpr, by * dpr, this.curve);
    return true;
  }

  private isHighlighted(engine: Engine, p: Particle): boolean {
    const sel = engine.selectedService;
    return this.highlightTrace === p.traceId || (sel !== null && (p.edge.source === sel || p.edge.target === sel));
  }

  private drawParticles(engine: Engine, layout: ForceLayout, view: View, now: number, dpr: number): void {
    const dimOthers = engine.selectedService !== null || this.highlightTrace !== null;
    const zoomScale = Math.sqrt(Math.min(2.5, Math.max(0.3, view.zoom)));

    // Trails first, so the bright heads sit on top of them.
    if (!this.reducedMotion) {
      for (const p of engine.particles) {
        if (p.departAt > now || p.arriveAt <= now) continue;
        if (!this.particleCurve(p, layout, view, dpr)) continue;
        const hl = this.isHighlighted(engine, p);
        const dim = dimOthers && !hl ? 0.25 : 1;
        const c = this.particleColor(p);
        const t = (now - p.departAt) / TRAVEL_MS;
        const head = (p.status === 'ok' ? 5 : 7) * (hl ? 1.4 : 1) * zoomScale * dpr;
        let count = 0;
        for (let k = 0; k < TRAIL_POINTS; k++) {
          const tt = t - (k / (TRAIL_POINTS - 1)) * TRAIL_SPAN;
          if (tt < 0) break;
          const f = k / (TRAIL_POINTS - 1);
          pointOn(this.curve, ease(tt), this.pt);
          this.px[count] = this.pt[0];
          this.py[count] = this.pt[1];
          this.pw[count] = head * 2.2 * (1 - f * 0.85);
          this.pa[count] = (1 - f) ** 1.6 * 0.7 * dim;
          this.setPointColor(count, c);
          count++;
        }
        this.pushRibbon(count, 0);
      }
      this.flushRibbons(dpr);
    }

    for (const p of engine.particles) {
      if (p.departAt > now || p.arriveAt <= now) continue;
      if (!this.particleCurve(p, layout, view, dpr)) continue;
      const hl = this.isHighlighted(engine, p);
      const dim = dimOthers && !hl ? 0.25 : 1;
      const size = (p.status === 'ok' ? 8 : 12) * (hl ? 1.45 : 1) * zoomScale * dpr;
      pointOn(this.curve, ease((now - p.departAt) / TRAVEL_MS), this.pt);
      this.pushQuad(this.pt[0], this.pt[1], size, this.particleColor(p), dim, 0, 1);
    }
    this.flushQuads();
  }

  // --------------------------------------------------------------- nodes
  private drawNodes(engine: Engine, layout: ForceLayout, view: View, now: number, dpr: number, time: number): void {
    const sel = engine.selectedService;
    for (const node of engine.topology.nodes.values()) {
      const p = layout.nodes.get(node.id);
      if (!p) continue;
      const [sx, sy] = view.toScreen(p.x, p.y);
      const rps = node.requests.rate(now, 10);
      const err = rps > 0 ? node.errors.rate(now, 10) / rps : 0;
      const alert = engine.alerts.has(node.id);
      let c = err > 0.01 ? mix(serviceColor(node.id), healthColor(err), 0.8) : serviceColor(node.id);
      if (alert) c = mix(c, WARNING, 0.6);
      const pulse = this.reducedMotion ? 0 : (alert ? 0.35 : err > 0.05 ? 0.2 : 0) * (0.5 + 0.5 * Math.sin(time * 4.2));
      const dim = sel !== null && sel !== node.id ? 0.4 : 1;
      const halo = Math.min(0.75, 0.22 + rps * 0.025 + pulse);
      const r = p.radius * view.zoom * dpr;
      this.pushQuad(sx * dpr, sy * dpr, r / BODY, c, dim, 1, halo);
    }
    this.flushQuads();
  }

  private drawFlares(engine: Engine, layout: ForceLayout, view: View, now: number, dpr: number): void {
    const dimOthers = engine.selectedService !== null || this.highlightTrace !== null;
    for (const p of engine.particles) {
      if (p.arriveAt > now) continue;
      const progress = (now - p.arriveAt) / FLARE_MS;
      if (progress >= 1) continue;
      const dest = layout.nodes.get(p.backward ? p.edge.source : p.edge.target);
      if (!dest) continue;
      const [sx, sy] = view.toScreen(dest.x, dest.y);
      const dim = dimOthers && !this.isHighlighted(engine, p) ? 0.2 : 1;
      const strength = p.status === 'error' ? 0.8 : p.status === 'slow' ? 0.45 : 0.14;
      const c = p.status === 'ok' ? mix(this.particleColor(p), WHITE, 0.2) : this.particleColor(p);
      const r = dest.radius * view.zoom * dpr * (p.status === 'error' ? 2.6 : 1.9);
      this.pushQuad(sx * dpr, sy * dpr, r, c, strength * dim, 2, progress);
    }
    this.flushQuads();
  }

  // --------------------------------------------------------------- globe
  private drawGlobe(globe: GlobeView, dpr: number): void {
    const gl = this.gl;
    this.pushQuad(globe.cx * dpr, globe.cy * dpr, globe.r * GLOBE_SCALE * dpr, WHITE, 1, 0, 0);
    const p = this.programs.globe;
    gl.useProgram(p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.land);
    gl.uniform1i(this.u(p, 'uLand'), 0);
    gl.uniform2f(this.u(p, 'uRot'), (globe.lon0 * Math.PI) / 180, (globe.lat0 * Math.PI) / 180);
    gl.uniform1f(this.u(p, 'uScale'), GLOBE_SCALE);
    // Keep dots a few pixels apart whatever the globe's size.
    gl.uniform1f(this.u(p, 'uDots'), Math.max(1.1, Math.min(3, 520 / globe.r)));
    this.flushQuads(p);
  }

  /** Arc from a node on the map up and over to a point on the globe (screen px in, device px out). */
  private arc(from: [number, number], to: [number, number, number], dpr: number): Curve {
    const c = this.curve;
    const dist = Math.hypot(to[0] - from[0], to[1] - from[1]);
    c.ax = from[0] * dpr; c.ay = from[1] * dpr;
    c.bx = to[0] * dpr; c.by = to[1] * dpr;
    c.cx = ((from[0] + to[0]) / 2) * dpr; c.cy = ((from[1] + to[1]) / 2 - dist * 0.32) * dpr;
    return c;
  }

  private geoColor(e: GeoEvent): RGB {
    return e.flagged ? ERROR_PARTICLE : mix(OK_PARTICLE, serviceColor(e.editor), 0.45);
  }

  private drawGeo(globe: GlobeView, layout: ForceLayout, view: View, now: number, dpr: number): void {
    const events = this.geo;
    for (const [lat, lon, n, f] of this.cells) {
      globe.project(lat, lon, this.g3);
      if (this.g3[2] <= 0) continue;
      const facing = Math.min(1, this.g3[2] * 2.2);
      const c = mix([120, 200, 255], ERROR_PARTICLE, f / Math.max(1, n));
      this.pushQuad(this.g3[0] * dpr, this.g3[1] * dpr, (2.2 + Math.log2(1 + n) * 0.9) * dpr, c, Math.min(0.6, 0.12 + Math.log10(1 + n) * 0.2) * facing, 3, 0);
    }
    this.flushQuads();
    const g = this.g3;
    const hd = this.h3;
    // Arcs and their comet trails.
    if (!this.reducedMotion) {
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i]!;
        if (now - e.at > GEO_ARC_MS) break;
        if (e.at > now) continue;
        const from = layout.nodes.get(e.node);
        globe.project(e.lat, e.lon, g);
        if (!from || g[2] <= 0.05) continue;
        const c = this.arc(view.toScreen(from.x, from.y), g, dpr);
        const t = (now - e.at) / GEO_ARC_MS;
        const color = this.geoColor(e);
        let count = 0;
        for (let k = 0; k < TRAIL_POINTS; k++) {
          const tt = t - (k / (TRAIL_POINTS - 1)) * 0.22;
          if (tt < 0) break;
          const f = k / (TRAIL_POINTS - 1);
          pointOn(c, ease(tt), this.pt);
          this.px[count] = this.pt[0];
          this.py[count] = this.pt[1];
          this.pw[count] = 9 * dpr * (1 - f * 0.85);
          this.pa[count] = (1 - f) ** 1.6 * 0.85;
          this.setPointColor(count, color);
          count++;
        }
        this.pushRibbon(count, 0);
      }
    }
    // Light pillars rising from fresh landings.
    if (!this.reducedMotion) {
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i]!;
        const age = now - e.at - GEO_ARC_MS;
        if (age > GEO_PULSE_MS) break;
        if (age < 0) continue;
        globe.project(e.lat, e.lon, g);
        if (g[2] <= 0) continue;
        const k = 1 - age / GEO_PULSE_MS;
        globe.project(e.lat, e.lon, hd, 1 + 0.16 * k);
        const color = this.geoColor(e);
        for (let j = 0; j < 2; j++) {
          this.px[j] = (j === 0 ? g[0] : hd[0]) * dpr;
          this.py[j] = (j === 0 ? g[1] : hd[1]) * dpr;
          this.pw[j] = (j === 0 ? 7 : 2) * dpr;
          this.pa[j] = (j === 0 ? 1 : 0.15) * k * g[2];
          this.setPointColor(j, color);
        }
        this.pushRibbon(2, 0);
      }
    }
    this.flushRibbons(dpr);

    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      const age = now - e.at;
      if (age > GEO_LINGER_MS) break;
      if (age < 0) continue;
      if (!this.reducedMotion && age < GEO_ARC_MS) {
        const from = layout.nodes.get(e.node);
        globe.project(e.lat, e.lon, g);
        if (!from || g[2] <= 0.05) continue;
        const c = this.arc(view.toScreen(from.x, from.y), g, dpr);
        pointOn(c, ease(age / GEO_ARC_MS), this.pt);
        this.pushQuad(this.pt[0], this.pt[1], 9 * dpr, this.geoColor(e), 1, 0, 1);
        continue;
      }
      globe.project(e.lat, e.lon, g);
      if (g[2] <= 0) continue;
      const facing = Math.min(1, g[2] * 2.5);
      const landed = age - (this.reducedMotion ? 0 : GEO_ARC_MS);
      const color = this.geoColor(e);
      if (!this.reducedMotion && landed < GEO_PULSE_MS) {
        const k = landed / GEO_PULSE_MS;
        this.pushQuad(g[0] * dpr, g[1] * dpr, globe.r * 0.16 * dpr, color, (e.flagged ? 1 : 0.7) * facing, 2, k);
        this.pushQuad(g[0] * dpr, g[1] * dpr, 10 * dpr, color, (1 - k) * facing, 0, 1);
      }
      const fade = Math.pow(1 - age / GEO_LINGER_MS, 0.8);
      this.pushQuad(g[0] * dpr, g[1] * dpr, (e.flagged ? 7 : 6) * dpr, color, (0.45 + 0.55 * fade) * facing, 0, 1);
    }
    this.flushQuads();
  }

  // --------------------------------------------------------- post-process
  private bloomPasses(): void {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.emptyVao);
    const down = this.programs.down;
    gl.useProgram(down);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.u(down, 'uTex'), 0);
    let src = this.scene!;
    for (const dst of this.bloom) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.viewport(0, 0, dst.w, dst.h);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform2f(this.u(down, 'uTexel'), 1 / src.w, 1 / src.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      src = dst;
    }
    const up = this.programs.up;
    gl.useProgram(up);
    gl.uniform1i(this.u(up, 'uTex'), 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = this.bloom.length - 1; i > 0; i--) {
      const from = this.bloom[i]!;
      const to = this.bloom[i - 1]!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, to.fbo);
      gl.viewport(0, 0, to.w, to.h);
      gl.bindTexture(gl.TEXTURE_2D, from.tex);
      gl.uniform2f(this.u(up, 'uTexel'), 1 / from.w, 1 / from.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.disable(gl.BLEND);
  }

  private composite(view: View, dpr: number): void {
    const gl = this.gl;
    const p = this.programs.composite;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(p);
    gl.bindVertexArray(this.emptyVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.scene!.tex);
    gl.uniform1i(this.u(p, 'uScene'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.bloom[0]!.tex);
    gl.uniform1i(this.u(p, 'uBloom'), 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform2f(this.u(p, 'uRes'), this.canvas.width, this.canvas.height);
    gl.uniform1f(this.u(p, 'uDpr'), dpr);
    gl.uniform2f(this.u(p, 'uCenter'), view.centerX, view.centerY);
    gl.uniform1f(this.u(p, 'uZoom'), view.zoom);
    gl.uniform1f(this.u(p, 'uBloomGain'), 0.2);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
