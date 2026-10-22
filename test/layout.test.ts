import { describe, expect, it } from 'vitest';
import { ForceLayout } from '../src/layout/force';

const nodes = [
  { id: 'gw', depth: 0 }, { id: 'bff', depth: 1 }, { id: 'a', depth: 2 }, { id: 'b', depth: 2 }, { id: 'db', depth: 3 },
];
const edges = [
  { source: 'gw', target: 'bff' }, { source: 'bff', target: 'a' }, { source: 'bff', target: 'b' }, { source: 'a', target: 'db' }, { source: 'b', target: 'db' },
];

describe('ForceLayout', () => {
  it('is deterministic and settles into depth-ordered columns', () => {
    const run = () => {
      const l = new ForceLayout({}, 3);
      l.sync(nodes, edges);
      for (let i = 0; i < 400; i++) l.step();
      return l;
    };
    const a = run();
    const b = run();
    for (const id of a.nodes.keys()) {
      expect(a.nodes.get(id)!.x).toBeCloseTo(b.nodes.get(id)!.x, 6);
      expect(Number.isFinite(a.nodes.get(id)!.y)).toBe(true);
    }
    const x = (id: string) => a.nodes.get(id)!.x;
    expect(x('gw')).toBeLessThan(x('bff'));
    expect(x('bff')).toBeLessThan(x('a'));
    expect(x('a')).toBeLessThan(x('db'));
    expect(a.energy()).toBeLessThan(1);
    // Siblings in the same column spread apart.
    expect(Math.abs(a.nodes.get('a')!.y - a.nodes.get('b')!.y)).toBeGreaterThan(40);
  });

  it('adds and removes nodes on sync and reheats', () => {
    const l = new ForceLayout();
    l.sync(nodes, edges);
    for (let i = 0; i < 300; i++) l.step();
    const cooled = l.alpha;
    l.sync([...nodes, { id: 'new', depth: 1 }], edges);
    expect(l.nodes.has('new')).toBe(true);
    expect(l.alpha).toBeGreaterThan(cooled);
    l.sync(nodes.slice(0, 2), edges);
    expect(l.nodes.size).toBe(2);
  });

  it('honours pinned nodes', () => {
    const l = new ForceLayout();
    l.sync(nodes, edges);
    const gw = l.nodes.get('gw')!;
    gw.fx = -500; gw.fy = 42;
    for (let i = 0; i < 50; i++) l.step();
    expect(gw.x).toBe(-500);
    expect(gw.y).toBe(42);
  });
});
