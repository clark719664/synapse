import { css, healthColor, serviceColor } from '../app/palette';
import type { Engine } from '../app/engine';
import type { ForceLayout } from '../layout/force';
import { formatMs } from '../model/stats';
import { EXTERNAL_SERVICES, INFRA_SERVICES } from '../sim/topology';
import { distanceTo, edgeCurve, type Curve } from './curve';
import type { View } from './view';

export type Hit = { kind: 'node'; id: string } | { kind: 'edge'; id: string } | null;

/** Canvas 2D layer: node rings, labels and hit-testing. Sits above the WebGL canvas. */
export class Overlay {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly curve: Curve = { ax: 0, ay: 0, cx: 0, cy: 0, bx: 0, by: 0 };
  hover: Hit = null;

  constructor(readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is required.');
    this.ctx = ctx;
  }

  resize(width: number, height: number, dpr: number): void {
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
  }

  render(engine: Engine, layout: ForceLayout, view: View, now: number, dpr: number): void {
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, view.width, view.height);
    ctx.textBaseline = 'middle';

    const z = view.zoom;
    const showLabels = z > 0.45;
    const selected = engine.selectedService;

    for (const node of engine.topology.nodes.values()) {
      const p = layout.nodes.get(node.id);
      if (!p) continue;
      const [sx, sy] = view.toScreen(p.x, p.y);
      const rps = node.requests.rate(now, 10);
      const err = rps > 0 ? node.errors.rate(now, 10) / rps : 0;
      const r = (p.radius + Math.min(10, Math.sqrt(rps) * 1.4)) * z;
      p.radius = 18 + Math.min(10, Math.sqrt(rps) * 1.4); // feed collision radius back to the layout
      const color = serviceColor(node.id);
      const health = healthColor(err);
      const isHover = this.hover?.kind === 'node' && this.hover.id === node.id;
      const dim = selected !== null && selected !== node.id ? 0.45 : 1;

      ctx.globalAlpha = dim;
      // Body
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = '#0f1117';
      ctx.fill();
      // Health ring
      ctx.lineWidth = (isHover || selected === node.id ? 3 : 2) * Math.min(1.4, z);
      ctx.strokeStyle = err > 0.01 ? css(health) : css(color, 0.9);
      ctx.stroke();
      // Infra / external glyph
      if (INFRA_SERVICES.has(node.id) || EXTERNAL_SERVICES.has(node.id)) {
        ctx.beginPath();
        if (INFRA_SERVICES.has(node.id)) {
          // cylinder-ish: two ellipses
          ctx.ellipse(sx, sy - r * 0.25, r * 0.4, r * 0.16, 0, 0, Math.PI * 2);
          ctx.moveTo(sx - r * 0.4, sy - r * 0.25);
          ctx.lineTo(sx - r * 0.4, sy + r * 0.3);
          ctx.ellipse(sx, sy + r * 0.3, r * 0.4, r * 0.16, 0, Math.PI, 0, true);
          ctx.lineTo(sx + r * 0.4, sy - r * 0.25);
        } else {
          ctx.moveTo(sx - r * 0.35, sy + r * 0.3);
          ctx.lineTo(sx + r * 0.35, sy - r * 0.3);
          ctx.moveTo(sx, sy - r * 0.3);
          ctx.lineTo(sx + r * 0.35, sy - r * 0.3);
          ctx.lineTo(sx + r * 0.35, sy + r * 0.05);
        }
        ctx.lineWidth = 1.2 * Math.min(1.4, z);
        ctx.strokeStyle = css(color, 0.75);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(sx, sy, r * 0.28, 0, Math.PI * 2);
        ctx.fillStyle = css(color, 0.9);
        ctx.fill();
      }

      if (showLabels) {
        const fs = Math.max(10, Math.min(14, 12 * z));
        ctx.font = `600 ${fs}px Inter, ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(232,233,238,0.95)';
        ctx.fillText(node.id, sx, sy + r + fs * 0.9);
        ctx.font = `${fs * 0.85}px ui-monospace, Menlo, monospace`;
        ctx.fillStyle = err > 0.01 ? css(health) : 'rgba(139,144,160,0.95)';
        const meta = rps >= 0.05 ? `${rps.toFixed(1)} rps${err > 0.005 ? ` · ${(err * 100).toFixed(0)}% err` : ''}` : 'idle';
        ctx.fillText(meta, sx, sy + r + fs * 2);
      }
      ctx.globalAlpha = 1;
    }

    // Edge hover tooltip
    if (this.hover?.kind === 'edge') {
      const e = engine.topology.edges.get(this.hover.id);
      if (e) {
        const a = layout.nodes.get(e.source)!;
        const b = layout.nodes.get(e.target)!;
        const [ax, ay] = view.toScreen(a.x, a.y);
        const [bx, by] = view.toScreen(b.x, b.y);
        edgeCurve(ax, ay, bx, by, this.curve);
        const rps = e.requests.rate(now, 10);
        const err = rps > 0 ? e.errors.rate(now, 10) / rps : 0;
        const label = `${e.source} → ${e.target}   ${rps.toFixed(1)} rps · p50 ${formatMs(e.latency.percentile(0.5))} · p95 ${formatMs(e.latency.percentile(0.95))} · ${(err * 100).toFixed(1)}% err`;
        this.tooltip(this.curve.cx, this.curve.cy - 14, label);
      }
    }
  }

  private tooltip(x: number, y: number, text: string): void {
    const ctx = this.ctx;
    ctx.font = `12px ui-monospace, Menlo, monospace`;
    ctx.textAlign = 'center';
    const w = ctx.measureText(text).width + 16;
    const h = 24;
    ctx.fillStyle = 'rgba(18,20,27,0.92)';
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - h, w, h, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#e8e9ee';
    ctx.fillText(text, x, y - h / 2);
  }

  /** Finds the node or edge under a screen point. Nodes win. */
  hitTest(engine: Engine, layout: ForceLayout, view: View, sx: number, sy: number): Hit {
    for (const node of engine.topology.nodes.values()) {
      const p = layout.nodes.get(node.id);
      if (!p) continue;
      const [x, y] = view.toScreen(p.x, p.y);
      if (Math.hypot(sx - x, sy - y) <= p.radius * view.zoom + 4) return { kind: 'node', id: node.id };
    }
    let best: Hit = null;
    let bestD = 9;
    for (const e of engine.topology.edges.values()) {
      const a = layout.nodes.get(e.source);
      const b = layout.nodes.get(e.target);
      if (!a || !b) continue;
      const [ax, ay] = view.toScreen(a.x, a.y);
      const [bx, by] = view.toScreen(b.x, b.y);
      edgeCurve(ax, ay, bx, by, this.curve);
      const d = distanceTo(this.curve, sx, sy);
      if (d < bestD) { bestD = d; best = { kind: 'edge', id: e.id }; }
    }
    return best;
  }
}
