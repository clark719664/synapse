import { describe, expect, it } from 'vitest';
import { Topology } from '../src/model/topology';
import { TrafficGenerator } from '../src/sim/generator';
import { combine, SCENARIOS } from '../src/sim/scenarios';
import { DEMO_ROUTES } from '../src/sim/topology';

describe('TrafficGenerator', () => {
  it('is deterministic for a seed', () => {
    const a = new TrafficGenerator({ seed: 5, rps: 50 });
    const b = new TrafficGenerator({ seed: 5, rps: 50 });
    const ta = a.tick(1000).map((t) => t.traceId + t.spans.length);
    const tb = b.tick(1000).map((t) => t.traceId + t.spans.length);
    expect(ta).toEqual(tb);
    expect(ta.length).toBeGreaterThan(20);
  });

  it('produces structurally valid traces', () => {
    const g = new TrafficGenerator({ seed: 1, rps: 200 });
    const traces = g.tick(2000);
    expect(traces.length).toBeGreaterThan(200);
    for (const t of traces) {
      const ids = new Set(t.spans.map((s) => s.spanId));
      const byId = new Map(t.spans.map((s) => [s.spanId, s]));
      expect(ids.size).toBe(t.spans.length);
      expect(t.root.parentSpanId).toBeNull();
      expect(t.root.service).toBe('edge-gateway');
      for (const s of t.spans) {
        expect(s.traceId).toBe(t.traceId);
        expect(s.end).toBeGreaterThanOrEqual(s.start);
        if (s.parentSpanId !== null) {
          const p = byId.get(s.parentSpanId)!;
          expect(p).toBeDefined();
          // Children are contained within their parent's interval.
          expect(s.start).toBeGreaterThanOrEqual(p.start - 1e-6);
          expect(s.end).toBeLessThanOrEqual(p.end + 1e-6);
        }
      }
    }
  });

  it('respects Poisson arrival rate on average', () => {
    const g = new TrafficGenerator({ seed: 9, rps: 100 });
    const n = g.tick(20_000).length;
    expect(n).toBeGreaterThan(1600);
    expect(n).toBeLessThan(2400);
  });

  it('scenarios raise error rates where they say they do', () => {
    const base = new TrafficGenerator({ seed: 3, rps: 100 });
    const bad = new TrafficGenerator({ seed: 3, rps: 100 });
    const s = combine([SCENARIOS.find((x) => x.id === 'redis-down')!]);
    bad.modifier = s.modifier;
    const errRate = (g: TrafficGenerator) => {
      const spans = g.tick(10_000).flatMap((t) => t.spans).filter((sp) => sp.service === 'redis');
      return spans.filter((sp) => sp.status === 'error').length / spans.length;
    };
    expect(errRate(base)).toBeLessThan(0.02);
    expect(errRate(bad)).toBeGreaterThan(0.9);
  });

  it('covers every service in the demo topology', () => {
    const g = new TrafficGenerator({ seed: 11, rps: 100 });
    const topo = new Topology();
    for (const t of g.tick(30_000)) topo.ingest(t);
    const expected = new Set<string>();
    const walk = (c: { service: string; children?: { call: { service: string; children?: unknown[] } }[] }) => {
      expected.add(c.service);
      for (const ch of c.children ?? []) walk(ch.call as never);
    };
    for (const r of DEMO_ROUTES) walk(r.root);
    for (const s of expected) expect(topo.nodes.has(s)).toBe(true);
    expect(topo.nodes.get('edge-gateway')!.depth).toBe(0);
    expect(topo.nodes.get('postgres')!.depth).toBeGreaterThanOrEqual(3);
  });
});
