import { css, healthColor, serviceColor, WARNING } from '../app/palette';
import type { Engine } from '../app/engine';
import type { GlobeView } from '../geo/globe';
import type { ForceLayout } from '../layout/force';
import type { GeoEvent } from '../live/geo';
import { formatMs } from '../model/stats';
import { distanceTo, edgeCurve, type Curve } from './curve';
import { GEO_ARC_MS } from './gl';
import { drawGlyph, glyphFor } from './glyphs';
import type { View } from './view';

type Box = [number, number, number, number];
const overlaps = (a: Box, b: Box): boolean => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];

export type Hit = { kind: 'node'; id: string } | { kind: 'edge'; id: string } | null;

export const rateText = (n: number, unit: string): string => `${n.toFixed(1)}${unit.startsWith('/') ? '' : ' '}${unit}`;

export const SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const HALO = 'rgba(3, 7, 17, 0.88)';

/** Canvas 2D layer: crisp rings, glyphs, labels, alert tags and hit-testing. Sits above the WebGL canvas. */
export class Overlay {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly curve: Curve = { ax: 0, ay: 0, cx: 0, cy: 0, bx: 0, by: 0 };
  hover: Hit = null;
  reducedMotion = false;
  globe: GlobeView | null = null;
  geo: readonly GeoEvent[] = [];
  private readonly g3: [number, number, number] = [0, 0, 0];

  constructor(readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is required.');
    this.ctx = ctx;
  }

  resize(width: number, height: number, dpr: number): void {
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
  }

  private label(text: string, x: number, y: number, font: string, fill: string): void {
    const ctx = this.ctx;
    ctx.font = font;
    ctx.lineWidth = 4;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = HALO;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
  }

  render(engine: Engine, layout: ForceLayout, view: View, now: number, dpr: number, timeSec: number): void {
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, view.width, view.height);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';

    const z = view.zoom;
    const showLabels = z > 0.42;
    const selected = engine.selectedService;
    const rate = (n: number) => rateText(n, engine.vocab.unit);

    const labels: { id: string; meta: string; x: number; top: number; fs: number; alpha: number; metaColor: string; priority: number }[] = [];
    const obstacles: { id: string; box: Box }[] = [];
    for (const node of engine.topology.nodes.values()) {
      const p = layout.nodes.get(node.id);
      if (!p) continue;
      const [sx, sy] = view.toScreen(p.x, p.y);
      const rps = node.requests.rate(now, 10);
      const err = rps > 0 ? node.errors.rate(now, 10) / rps : 0;
      const r = p.radius * z;
      const color = serviceColor(node.id);
      const health = healthColor(err);
      const isHover = this.hover?.kind === 'node' && this.hover.id === node.id;
      const isSelected = selected === node.id;
      const lw = Math.min(1.4, Math.max(0.7, z));
      ctx.globalAlpha = selected !== null && !isSelected ? 0.45 : 1;

      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.lineWidth = (isHover || isSelected ? 2.4 : 1.3) * lw;
      ctx.strokeStyle = css(color, isHover || isSelected ? 1 : 0.8);
      ctx.stroke();

      // Error gauge: the share of failing calls, clockwise from the top.
      if (err > 0.005) {
        ctx.beginPath();
        ctx.arc(sx, sy, r + 3.5 * lw, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, Math.max(0.04, err)));
        ctx.lineWidth = 2.6 * lw;
        ctx.lineCap = 'round';
        ctx.strokeStyle = css(health);
        ctx.stroke();
        ctx.lineCap = 'butt';
      }

      const alert = engine.alerts.get(node.id);
      if (alert) {
        const spin = this.reducedMotion ? 0 : timeSec * 0.8;
        ctx.save();
        ctx.setLineDash([5 * lw, 5 * lw]);
        ctx.lineDashOffset = -spin * 20;
        ctx.beginPath();
        ctx.arc(sx, sy, r + 9 * lw, 0, Math.PI * 2);
        ctx.lineWidth = 1.6 * lw;
        ctx.strokeStyle = css(WARNING, 0.9);
        ctx.stroke();
        ctx.restore();
      }

      ctx.strokeStyle = css(color, 0.9);
      ctx.fillStyle = css(color, 0.9);
      ctx.lineWidth = 1.4 * lw;
      drawGlyph(ctx, glyphFor(node.id), sx, sy, r);

      obstacles.push({ id: node.id, box: [sx - r, sy - r, 2 * r, 2 * r] });
      if (showLabels) {
        const fs = Math.max(11, Math.min(14, 12.5 * z));
        const meta = rps >= 0.05 ? `${rate(rps)}${err > 0.005 ? `, ${(err * 100).toFixed(0)}% ${engine.vocab.error}` : ''}` : 'idle';
        labels.push({
          id: node.id, meta, x: sx, top: sy + r + (alert ? 12 : 8) * lw + fs * 0.6, fs, alpha: ctx.globalAlpha,
          metaColor: err > 0.01 ? css(health) : 'rgba(142, 156, 182, 0.95)',
          priority: isHover || isSelected ? Infinity : rps,
        });
      }
      if (alert) this.tag(alert.label, sx, sy - r - 12 * lw - 10);
      ctx.globalAlpha = 1;
    }

    // Busiest first; a label that would collide with a placed label or another node loses its rate line, then itself.
    const placed: Box[] = [];
    const hits = (b: Box, id: string) => placed.some((o) => overlaps(o, b)) || obstacles.some((o) => o.id !== id && overlaps(o.box, b));
    for (const l of labels.sort((a, b) => b.priority - a.priority)) {
      ctx.font = `600 ${l.fs}px ${SANS}`;
      const nameW = ctx.measureText(l.id).width + 6;
      ctx.font = `500 ${l.fs * 0.86}px ${SANS}`;
      const metaW = ctx.measureText(l.meta).width + 6;
      const name: Box = [l.x - nameW / 2, l.top - l.fs * 0.6, nameW, l.fs * 1.2];
      const both: Box = [l.x - Math.max(nameW, metaW) / 2, name[1], Math.max(nameW, metaW), l.fs * 2.4];
      const full = l.priority === Infinity || !hits(both, l.id);
      if (!full && hits(name, l.id)) continue;
      placed.push(full ? both : name);
      ctx.globalAlpha = l.alpha;
      this.label(l.id, l.x, l.top, `600 ${l.fs}px ${SANS}`, 'rgba(232, 238, 248, 0.96)');
      if (full) this.label(l.meta, l.x, l.top + l.fs * 1.25, `500 ${l.fs * 0.86}px ${SANS}`, l.metaColor);
      ctx.globalAlpha = 1;
    }

    this.geoLabels(now, view.width);

    if (this.hover?.kind === 'edge') {
      const e = engine.topology.edges.get(this.hover.id);
      const a = e && layout.nodes.get(e.source);
      const b = e && layout.nodes.get(e.target);
      if (e && a && b) {
        const [ax, ay] = view.toScreen(a.x, a.y);
        const [bx, by] = view.toScreen(b.x, b.y);
        edgeCurve(ax, ay, bx, by, this.curve);
        const rps = e.requests.rate(now, 10);
        const err = rps > 0 ? e.errors.rate(now, 10) / rps : 0;
        const p50 = e.latency.percentile(0.5);
        const latency = p50 > 0 ? `, ${engine.vocab.latency ? `${engine.vocab.latency.toLowerCase()} ` : ''}p50 ${formatMs(p50)}, p95 ${formatMs(e.latency.percentile(0.95))}` : '';
        this.tooltip(this.curve.cx, this.curve.cy - 16, `${e.source} → ${e.target}`, `${rate(rps)}${latency}, ${(err * 100).toFixed(1)}% ${engine.vocab.error}`, view.width);
      }
    }
  }

  /** Names the last few places to light up on the globe, without letting labels collide. */
  private geoLabels(now: number, width: number): void {
    const globe = this.globe;
    if (!globe?.visible) return;
    const ctx = this.ctx;
    const boxes: Box[] = [];
    const delay = this.reducedMotion ? 0 : GEO_ARC_MS;
    for (let i = this.geo.length - 1; i >= 0 && boxes.length < 3; i--) {
      const e = this.geo[i]!;
      const age = now - e.at - delay;
      if (age > 3600) break;
      if (age < 0) continue;
      const [x, y, z] = globe.project(e.lat, e.lon, this.g3);
      if (z < 0.3) continue;
      const title = e.title.length > 34 ? `${e.title.slice(0, 33)}…` : e.title;
      ctx.font = `600 12px ${SANS}`;
      const w = Math.max(ctx.measureText(title).width, 80) + 8;
      const cx = Math.max(w / 2 + 8, Math.min(width - w / 2 - 8, x));
      const box: Box = [cx - w / 2, y - 44, w, 34];
      if (boxes.some((b) => overlaps(b, box))) continue;
      boxes.push(box);
      ctx.globalAlpha = this.reducedMotion ? 1 : Math.min(1, age / 250, (3600 - age) / 600);
      this.label(title, cx, y - 34, `600 12px ${SANS}`, 'rgba(236, 242, 252, 0.98)');
      this.label(e.host, cx, y - 19, `500 11px ${SANS}`, e.flagged ? css([255, 96, 128]) : 'rgba(142, 166, 205, 0.95)');
      ctx.globalAlpha = 1;
    }
  }

  private tag(text: string, x: number, y: number): void {
    const ctx = this.ctx;
    ctx.font = `600 11px ${SANS}`;
    const w = ctx.measureText(text).width + 14;
    ctx.fillStyle = 'rgba(60, 38, 4, 0.92)';
    ctx.strokeStyle = css(WARNING, 0.7);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - 10, w, 20, 10);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = css(WARNING);
    ctx.fillText(text, x, y + 0.5);
  }

  private tooltip(x: number, y: number, title: string, body: string, maxX: number): void {
    const ctx = this.ctx;
    ctx.font = `600 12px ${SANS}`;
    const tw = ctx.measureText(title).width;
    ctx.font = `12px ${SANS}`;
    const bw = ctx.measureText(body).width;
    const w = Math.max(tw, bw) + 24;
    const h = 46;
    const left = Math.max(8, Math.min(maxX - w - 8, x - w / 2));
    ctx.fillStyle = 'rgba(9, 14, 28, 0.94)';
    ctx.strokeStyle = 'rgba(150, 180, 255, 0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(left, y - h, w, h, 10);
    ctx.fill();
    ctx.stroke();
    ctx.textAlign = 'left';
    ctx.font = `600 12px ${SANS}`;
    ctx.fillStyle = '#e8eef8';
    ctx.fillText(title, left + 12, y - h + 15);
    ctx.font = `12px ${SANS}`;
    ctx.fillStyle = 'rgba(160, 174, 200, 0.95)';
    ctx.fillText(body, left + 12, y - h + 32);
    ctx.textAlign = 'center';
  }

  /** Finds the node or edge under a screen point. Nodes win. */
  hitTest(engine: Engine, layout: ForceLayout, view: View, sx: number, sy: number): Hit {
    for (const node of engine.topology.nodes.values()) {
      const p = layout.nodes.get(node.id);
      if (!p) continue;
      const [x, y] = view.toScreen(p.x, p.y);
      if (Math.hypot(sx - x, sy - y) <= p.radius * view.zoom + 6) return { kind: 'node', id: node.id };
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
