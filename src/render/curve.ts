/**
 * Edges are quadratic Béziers bowed slightly to one side so that A→B and B→A
 * never overlap, and so particles visibly "turn" instead of sliding along a
 * ruler. All functions are pure and allocation-free on the hot path.
 */
export interface Curve {
  ax: number; ay: number;
  cx: number; cy: number;
  bx: number; by: number;
}

const BOW = 0.14;

export function edgeCurve(ax: number, ay: number, bx: number, by: number, out: Curve): Curve {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  // Perpendicular on the right-hand side of travel; the reverse edge bows the other way.
  const nx = -dy / len;
  const ny = dx / len;
  out.ax = ax; out.ay = ay;
  out.bx = bx; out.by = by;
  out.cx = (ax + bx) / 2 + nx * len * BOW;
  out.cy = (ay + by) / 2 + ny * len * BOW;
  return out;
}

export function pointOn(c: Curve, t: number, out: [number, number]): [number, number] {
  const u = 1 - t;
  out[0] = u * u * c.ax + 2 * u * t * c.cx + t * t * c.bx;
  out[1] = u * u * c.ay + 2 * u * t * c.cy + t * t * c.by;
  return out;
}

/** Distance from a point to the curve, sampled; good enough for hover hit-testing. */
export function distanceTo(c: Curve, px: number, py: number, samples = 16): number {
  let best = Infinity;
  const p: [number, number] = [0, 0];
  for (let i = 0; i <= samples; i++) {
    pointOn(c, i / samples, p);
    const d = Math.hypot(p[0] - px, p[1] - py);
    if (d < best) best = d;
  }
  return best;
}

/** Smoothstep-ish easing so particles accelerate out of a node and brake into the next. */
export const ease = (t: number): number => t * t * (3 - 2 * t);
