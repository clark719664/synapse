import { ERROR_PARTICLE, OK_PARTICLE, SLOW_PARTICLE, healthColor, mix, serviceColor, type RGB } from '../app/palette';
import { TRAVEL_MS, type Engine } from '../app/engine';
import type { ForceLayout } from '../layout/force';
import { edgeCurve, ease, pointOn, type Curve } from './curve';
import type { View } from './view';

const SPRITE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aCorner;      // unit quad corner in [-1, 1]
layout(location=1) in vec3 aCenterSize;  // screen x, y, radius (px)
layout(location=2) in vec4 aColor;       // rgba
uniform vec2 uViewport;
out vec2 vUv;
out vec4 vColor;
void main() {
  vec2 px = aCenterSize.xy + aCorner * aCenterSize.z;
  vec2 clip = (px / uViewport) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  vUv = aCorner;
  vColor = aColor;
}`;

const SPRITE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
in vec4 vColor;
uniform float uCore; // 0 = pure soft glow, 1 = hard core + glow
out vec4 o;
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float glow = exp(-r * r * 4.0);
  float core = 1.0 - smoothstep(0.18, 0.32, r);
  float a = glow * 0.55 + core * uCore;
  o = vec4(vColor.rgb * a * vColor.a, 0.0); // premultiplied, additive
}`;

const LINE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
layout(location=1) in vec4 aColor;
uniform vec2 uViewport;
out vec4 vColor;
void main() {
  vec2 clip = (aPos / uViewport) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  vColor = aColor;
}`;

const LINE_FS = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 o;
void main() { o = vec4(vColor.rgb * vColor.a, vColor.a); }`;

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

const TRAIL = 5;
const EDGE_SEGMENTS = 24;

/**
 * Draws everything that benefits from additive blending: edge ribbons, node
 * halos and the particles with their trails. Crisp text and rings are left to
 * the Canvas 2D overlay stacked on top.
 */
export class GlRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly sprite: WebGLProgram;
  private readonly line: WebGLProgram;
  private readonly spriteVao: WebGLVertexArrayObject;
  private readonly lineVao: WebGLVertexArrayObject;
  private readonly instanceBuf: WebGLBuffer;
  private readonly lineBuf: WebGLBuffer;
  private instances = new Float32Array(7 * 4096);
  private lineVerts = new Float32Array(6 * 4096);
  private readonly curve: Curve = { ax: 0, ay: 0, cx: 0, cy: 0, bx: 0, by: 0 };
  private readonly pt: [number, number] = [0, 0];
  /** Trace id whose path is highlighted (selected in the waterfall). */
  highlightTrace: string | null = null;
  hoverEdge: string | null = null;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { alpha: true, antialias: true, premultipliedAlpha: true });
    if (!gl) throw new Error('WebGL2 is required.');
    this.gl = gl;
    this.sprite = compile(gl, SPRITE_VS, SPRITE_FS);
    this.line = compile(gl, LINE_VS, LINE_FS);

    // Sprite VAO: static unit quad + per-instance (x, y, r, rgba).
    const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    const quadBuf = gl.createBuffer()!;
    this.instanceBuf = gl.createBuffer()!;
    this.spriteVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.spriteVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 28, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 28, 12);
    gl.vertexAttribDivisor(2, 1);

    // Line VAO: triangles with (x, y, rgba).
    this.lineBuf = gl.createBuffer()!;
    this.lineVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, 8);
    gl.bindVertexArray(null);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  resize(width: number, height: number, dpr: number): void {
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
  }

  render(engine: Engine, layout: ForceLayout, view: View, now: number, dpr: number): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    this.drawEdges(engine, layout, view, now, dpr);
    this.drawHalos(engine, layout, view, now, dpr);
    this.drawParticles(engine, layout, view, now, dpr);
  }

  // ---------------------------------------------------------------- edges
  private drawEdges(engine: Engine, layout: ForceLayout, view: View, now: number, dpr: number): void {
    const gl = this.gl;
    let n = 0;
    const need = engine.topology.edges.size * EDGE_SEGMENTS * 6 * 6;
    if (this.lineVerts.length < need) this.lineVerts = new Float32Array(need * 2);
    const v = this.lineVerts;
    const litEdges = this.litEdges(engine);

    for (const e of engine.topology.edges.values()) {
      const a = layout.nodes.get(e.source);
      const b = layout.nodes.get(e.target);
      if (!a || !b) continue;
      const [ax, ay] = view.toScreen(a.x, a.y);
      const [bx, by] = view.toScreen(b.x, b.y);
      edgeCurve(ax * dpr, ay * dpr, bx * dpr, by * dpr, this.curve);

      const rps = e.requests.rate(now, 10);
      const err = rps > 0 ? e.errors.rate(now, 10) / rps : 0;
      const lit = litEdges.has(e.id) || this.hoverEdge === e.id;
      const base = mix(OK_PARTICLE, healthColor(err), err > 0.01 ? 0.9 : 0);
      const alpha = lit ? 0.85 : Math.min(0.45, 0.08 + rps * 0.02);
      const width = (lit ? 2.4 : 1.2 + Math.min(2.2, rps * 0.12)) * dpr;

      // Build a thin ribbon along the curve.
      let px = 0, py = 0;
      for (let i = 0; i <= EDGE_SEGMENTS; i++) {
        const t = i / EDGE_SEGMENTS;
        pointOn(this.curve, t, this.pt);
        const [x, y] = this.pt;
        if (i > 0) {
          const dx = x - px, dy = y - py;
          const len = Math.hypot(dx, dy) || 1;
          const nx = (-dy / len) * width * 0.5;
          const ny = (dx / len) * width * 0.5;
          // Fade the ribbon out towards the target so the arrow of flow reads naturally.
          const fade = 0.6 + 0.4 * t;
          const a0 = alpha * fade;
          const put = (qx: number, qy: number) => {
            v[n++] = qx; v[n++] = qy; v[n++] = base[0] / 255; v[n++] = base[1] / 255; v[n++] = base[2] / 255; v[n++] = a0;
          };
          put(px + nx, py + ny); put(px - nx, py - ny); put(x + nx, y + ny);
          put(px - nx, py - ny); put(x - nx, y - ny); put(x + nx, y + ny);
        }
        px = x; py = y;
      }
    }
    if (n === 0) return;
    gl.useProgram(this.line);
    gl.uniform2f(gl.getUniformLocation(this.line, 'uViewport'), this.canvas.width, this.canvas.height);
    gl.bindVertexArray(this.lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, v.subarray(0, n), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, n / 6);
  }

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

  // ---------------------------------------------------------------- halos
  private drawHalos(engine: Engine, layout: ForceLayout, view: View, now: number, dpr: number): void {
    let n = 0;
    const inst = this.instances;
    for (const node of engine.topology.nodes.values()) {
      const p = layout.nodes.get(node.id);
      if (!p) continue;
      const [sx, sy] = view.toScreen(p.x, p.y);
      const rps = node.requests.rate(now, 10);
      const err = rps > 0 ? node.errors.rate(now, 10) / rps : 0;
      const c = err > 0.01 ? healthColor(err) : serviceColor(node.id);
      const pulse = err > 0.05 ? 0.15 * Math.sin(now / 180) : 0;
      const radius = (p.radius * 2.6 + Math.min(30, rps * 0.6)) * view.zoom * dpr;
      const alpha = (0.22 + pulse + Math.min(0.3, rps * 0.01)) * (engine.selectedService && engine.selectedService !== node.id ? 0.4 : 1);
      n = this.pushInstance(inst, n, sx * dpr, sy * dpr, radius, c, alpha);
    }
    this.flushSprites(n, 0);
  }

  // ------------------------------------------------------------ particles
  private drawParticles(engine: Engine, layout: ForceLayout, view: View, now: number, dpr: number): void {
    const need = engine.particles.length * (TRAIL + 1) * 7;
    if (this.instances.length < need) this.instances = new Float32Array(need * 2);
    const inst = this.instances;
    let n = 0;
    const dimOthers = engine.selectedService !== null || this.highlightTrace !== null;

    for (const p of engine.particles) {
      if (p.departAt > now) continue;
      const a = layout.nodes.get(p.edge.source);
      const b = layout.nodes.get(p.edge.target);
      if (!a || !b) continue;
      const [ax, ay] = view.toScreen(a.x, a.y);
      const [bx, by] = view.toScreen(b.x, b.y);
      if (p.backward) edgeCurve(bx * dpr, by * dpr, ax * dpr, ay * dpr, this.curve);
      else edgeCurve(ax * dpr, ay * dpr, bx * dpr, by * dpr, this.curve);

      const color: RGB = p.status === 'error' ? ERROR_PARTICLE : p.status === 'slow' ? SLOW_PARTICLE : p.backward ? mix(OK_PARTICLE, serviceColor(p.edge.target), 0.5) : OK_PARTICLE;
      const highlighted = this.highlightTrace === p.traceId || (engine.selectedService !== null && (p.edge.source === engine.selectedService || p.edge.target === engine.selectedService));
      const dim = dimOthers && !highlighted ? 0.25 : 1;
      const size = (p.status === 'ok' ? 5.5 : 7) * (highlighted ? 1.5 : 1) * Math.sqrt(view.zoom) * dpr;

      const t = (now - p.departAt) / TRAVEL_MS;
      for (let k = 0; k <= TRAIL; k++) {
        const tt = t - k * 0.035;
        if (tt < 0) break;
        pointOn(this.curve, ease(Math.min(1, tt)), this.pt);
        const fade = k === 0 ? 1 : 0.5 * (1 - k / (TRAIL + 1));
        n = this.pushInstance(inst, n, this.pt[0], this.pt[1], size * (k === 0 ? 1 : 0.8), color, fade * dim);
      }
    }
    this.flushSprites(n, 1);
  }

  private pushInstance(inst: Float32Array, n: number, x: number, y: number, r: number, c: RGB, a: number): number {
    if (n + 7 > inst.length) return n;
    inst[n++] = x; inst[n++] = y; inst[n++] = r;
    inst[n++] = c[0] / 255; inst[n++] = c[1] / 255; inst[n++] = c[2] / 255; inst[n++] = a;
    return n;
  }

  private flushSprites(n: number, core: number): void {
    if (n === 0) return;
    const gl = this.gl;
    gl.useProgram(this.sprite);
    gl.uniform2f(gl.getUniformLocation(this.sprite, 'uViewport'), this.canvas.width, this.canvas.height);
    gl.uniform1f(gl.getUniformLocation(this.sprite, 'uCore'), core);
    gl.bindVertexArray(this.spriteVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.instances.subarray(0, n), gl.DYNAMIC_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n / 7);
  }
}
