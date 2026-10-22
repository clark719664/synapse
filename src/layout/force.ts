import { mulberry32 } from '../sim/rng';

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Column hint from the topology; nodes are pulled towards `depth * columnGap`. */
  depth: number;
  /** Pinned position while dragging. */
  fx: number | null;
  fy: number | null;
  radius: number;
}

export interface LayoutEdge {
  source: string;
  target: string;
}

export interface ForceOptions {
  columnGap: number;
  repulsion: number;
  spring: number;
  restLength: number;
  columnPull: number;
  /** Width of the band around each column inside which nodes feel no column pull (0 = a hard line). */
  columnBand: number;
  centerPull: number;
  damping: number;
}

const DEFAULTS: ForceOptions = {
  columnGap: 190,
  repulsion: 26000,
  spring: 0.02,
  restLength: 150,
  columnPull: 0.04,
  columnBand: 0,
  centerPull: 0.004,
  damping: 0.82,
};

/**
 * A small force-directed layout with a left-to-right flow bias: every node is
 * attracted to the column matching its depth, so entry points land on the left
 * and data stores on the right without hand-placing anything.
 *
 * Deterministic for a given seed and insertion order, which keeps tests stable
 * and makes reloading the page produce the same picture.
 */
export class ForceLayout {
  readonly nodes = new Map<string, LayoutNode>();
  private edges: LayoutEdge[] = [];
  readonly options: ForceOptions;
  private readonly rand: () => number;
  /** Simulation "temperature"; decays to a floor and is bumped on structural change. */
  alpha = 1;
  /** When set, nodes glide to these positions instead of following the forces (the tidy layout). */
  targets: Map<string, { x: number; y: number }> | null = null;

  constructor(options: Partial<ForceOptions> = {}, seed = 7) {
    this.options = { ...DEFAULTS, ...options };
    this.rand = mulberry32(seed);
  }

  /** Synchronises with a topology: adds missing nodes near their column, removes stale ones. */
  sync(nodes: Iterable<{ id: string; depth: number }>, edges: Iterable<LayoutEdge>): void {
    const seen = new Set<string>();
    let changed = false;
    for (const n of nodes) {
      seen.add(n.id);
      const existing = this.nodes.get(n.id);
      if (existing) {
        if (existing.depth !== n.depth) { existing.depth = n.depth; changed = true; }
        continue;
      }
      this.nodes.set(n.id, {
        id: n.id,
        x: n.depth * this.options.columnGap + (this.rand() - 0.5) * 40,
        y: (this.rand() - 0.5) * 300,
        vx: 0,
        vy: 0,
        depth: n.depth,
        fx: null,
        fy: null,
        radius: 18,
      });
      changed = true;
    }
    for (const id of [...this.nodes.keys()]) {
      if (!seen.has(id)) { this.nodes.delete(id); changed = true; }
    }
    const next = [...edges].filter((e) => this.nodes.has(e.source) && this.nodes.has(e.target));
    if (next.length !== this.edges.length) changed = true;
    this.edges = next;
    if (changed) this.alpha = Math.max(this.alpha, 0.8);
  }

  /** Advances the simulation one step. Cheap enough to run every frame for a few hundred nodes. */
  step(): void {
    const o = this.options;
    const list = [...this.nodes.values()];
    const n = list.length;
    if (n === 0) return;
    if (this.targets) {
      for (const p of list) {
        if (p.fx !== null && p.fy !== null) { p.x = p.fx; p.y = p.fy; p.vx = 0; p.vy = 0; continue; }
        const t = this.targets.get(p.id);
        if (!t) continue;
        p.vx = (t.x - p.x) * 0.1;
        p.vy = (t.y - p.y) * 0.1;
        p.x += p.vx;
        p.y += p.vy;
      }
      return;
    }
    const a = this.alpha;

    // Pairwise repulsion (O(n²); fine for service graphs).
    for (let i = 0; i < n; i++) {
      const p = list[i]!;
      for (let j = i + 1; j < n; j++) {
        const q = list[j]!;
        let dx = q.x - p.x;
        let dy = q.y - p.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = (this.rand() - 0.5) || 0.1; dy = (this.rand() - 0.5) || 0.1; d2 = dx * dx + dy * dy; }
        const d = Math.sqrt(d2);
        const minDist = p.radius + q.radius + 30;
        let f = (o.repulsion / d2) * a;
        if (d < minDist) f += (minDist - d) * 0.5; // hard-ish collision
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        p.vx -= fx; p.vy -= fy;
        q.vx += fx; q.vy += fy;
      }
    }

    // Springs along edges.
    for (const e of this.edges) {
      const p = this.nodes.get(e.source)!;
      const q = this.nodes.get(e.target)!;
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const d = Math.max(1, Math.hypot(dx, dy));
      const f = (d - o.restLength) * o.spring * a;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      p.vx += fx; p.vy += fy;
      q.vx -= fx; q.vy -= fy;
    }

    // Column attraction and gentle vertical centering.
    let cy = 0;
    for (const p of list) cy += p.y;
    cy /= n;
    for (const p of list) {
      const off = p.x - p.depth * o.columnGap;
      const excess = Math.sign(off) * Math.max(0, Math.abs(off) - o.columnBand / 2);
      p.vx -= excess * o.columnPull * a;
      p.vy += (cy - p.y) * o.centerPull * a;
    }

    // Integrate.
    for (const p of list) {
      if (p.fx !== null && p.fy !== null) { p.x = p.fx; p.y = p.fy; p.vx = 0; p.vy = 0; continue; }
      p.vx *= o.damping;
      p.vy *= o.damping;
      const speed = Math.hypot(p.vx, p.vy);
      const cap = 40;
      if (speed > cap) { p.vx *= cap / speed; p.vy *= cap / speed; }
      p.x += p.vx;
      p.y += p.vy;
    }

    this.alpha = Math.max(0.02, this.alpha * 0.985);
  }

  /** Total kinetic energy; useful to know when the picture has settled. */
  energy(): number {
    let e = 0;
    for (const p of this.nodes.values()) e += p.vx * p.vx + p.vy * p.vy;
    return e;
  }

  bounds(): { minX: number; minY: number; maxX: number; maxY: number } {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of this.nodes.values()) {
      minX = Math.min(minX, p.x - p.radius);
      minY = Math.min(minY, p.y - p.radius);
      maxX = Math.max(maxX, p.x + p.radius);
      maxY = Math.max(maxY, p.y + p.radius);
    }
    if (!Number.isFinite(minX)) return { minX: -100, minY: -100, maxX: 100, maxY: 100 };
    return { minX, minY, maxX, maxY };
  }
}
