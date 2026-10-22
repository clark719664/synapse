import { describe, expect, it } from 'vitest';
import { layeredTargets } from '../src/layout/layered';

const crossings = (pos: Map<string, { x: number; y: number }>, edges: { source: string; target: string }[]) => {
  let n = 0;
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const a = edges[i]!, b = edges[j]!;
      const [a1, a2, b1, b2] = [pos.get(a.source)!, pos.get(a.target)!, pos.get(b.source)!, pos.get(b.target)!];
      if (a1.x !== b1.x || a2.x !== b2.x) continue;
      if ((a1.y - b1.y) * (a2.y - b2.y) < 0) n++;
    }
  }
  return n;
};

describe('layeredTargets', () => {
  it('puts each depth in its own column, left to right, centred on the origin', () => {
    const pos = layeredTargets(
      [{ id: 'a', depth: 0 }, { id: 'b', depth: 1 }, { id: 'c', depth: 2 }],
      [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }],
      () => 1,
    );
    expect(pos.get('a')!.x).toBeLessThan(pos.get('b')!.x);
    expect(pos.get('b')!.x).toBeLessThan(pos.get('c')!.x);
    expect(pos.get('a')!.x + pos.get('c')!.x).toBeCloseTo(0);
  });

  it('orders a column to undo crossings', () => {
    const nodes = [{ id: 'top', depth: 0 }, { id: 'bottom', depth: 0 }, { id: 'x', depth: 1 }, { id: 'y', depth: 1 }];
    const edges = [{ source: 'top', target: 'y' }, { source: 'bottom', target: 'x' }];
    // Weights alone would put x above y and cross the edges.
    const pos = layeredTargets(nodes, edges, (id) => ({ top: 2, bottom: 1, x: 2, y: 1 })[id] ?? 0);
    expect(crossings(pos, edges)).toBe(0);
  });

  it('wraps a tall column into staggered sub-columns with no two nodes in the same spot', () => {
    const nodes = [{ id: 'src', depth: 0 }, ...Array.from({ length: 17 }, (_, i) => ({ id: `w${i}`, depth: 1 }))];
    const pos = layeredTargets(nodes, nodes.slice(1).map((n) => ({ source: 'src', target: n.id })), () => 1, { maxRows: 8, rowGap: 100, subColumnGap: 200 });
    const xs = new Set(nodes.slice(1).map((n) => pos.get(n.id)!.x));
    expect(xs.size).toBe(3);
    const ys = nodes.slice(1).map((n) => pos.get(n.id)!.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThanOrEqual(6 * 100 + 100);
    const keys = new Set([...pos.values()].map((p) => `${Math.round(p.x)},${Math.round(p.y)}`));
    expect(keys.size).toBe(nodes.length);
  });

  it('is deterministic', () => {
    const nodes = Array.from({ length: 9 }, (_, i) => ({ id: `n${i}`, depth: i % 3 }));
    const edges = [{ source: 'n0', target: 'n4' }, { source: 'n3', target: 'n1' }, { source: 'n1', target: 'n5' }];
    const a = layeredTargets(nodes, edges, (id) => id.length);
    const b = layeredTargets([...nodes].reverse(), [...edges].reverse(), (id) => id.length);
    expect([...b.entries()].sort()).toEqual([...a.entries()].sort());
  });
});
