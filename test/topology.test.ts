import { describe, expect, it } from 'vitest';
import { assembleTraces, type Span } from '../src/model/span';
import { Topology } from '../src/model/topology';

const span = (over: Partial<Span>): Span => ({
  traceId: 't', spanId: 's', parentSpanId: null, service: 'svc', name: 'op', kind: 'server', start: 0, end: 10, status: 'ok', attributes: {}, ...over,
});

const trace = () =>
  assembleTraces([
    span({ spanId: 'a', service: 'gateway', start: 0, end: 100 }),
    span({ spanId: 'b', parentSpanId: 'a', service: 'gateway', kind: 'client', start: 5, end: 60, name: 'call api' }),
    span({ spanId: 'c', parentSpanId: 'b', service: 'api', start: 6, end: 58 }),
    span({ spanId: 'd', parentSpanId: 'c', service: 'db', kind: 'client', start: 10, end: 40, status: 'error' }),
    span({ spanId: 'e', parentSpanId: 'a', service: 'auth', start: 61, end: 90 }),
  ])[0]!;

describe('Topology', () => {
  it('derives edges only across service boundaries and returns transfers in order', () => {
    const topo = new Topology();
    const transfers = topo.ingest(trace());
    expect([...topo.edges.keys()].sort()).toEqual(['api→db', 'gateway→api', 'gateway→auth']);
    expect(transfers.map((t) => t.edgeId)).toEqual(['gateway→api', 'api→db', 'gateway→auth']);
    expect(topo.nodes.get('gateway')!.entry).toBe(true);
    expect(topo.nodes.get('api')!.entry).toBe(false);
  });

  it('assigns depths from entry points', () => {
    const topo = new Topology();
    topo.ingest(trace());
    expect(topo.nodes.get('gateway')!.depth).toBe(0);
    expect(topo.nodes.get('api')!.depth).toBe(1);
    expect(topo.nodes.get('auth')!.depth).toBe(1);
    expect(topo.nodes.get('db')!.depth).toBe(2);
  });

  it('records request, error and latency stats per node and edge', () => {
    const topo = new Topology();
    topo.ingest(trace());
    const db = topo.nodes.get('db')!;
    expect(db.requests.rate(999, 1)).toBe(1);
    expect(db.errors.rate(999, 1)).toBe(1);
    expect(db.latency.percentile(0.5)).toBe(30);
    const edge = topo.edges.get('api→db')!;
    expect(edge.errors.rate(999, 1)).toBe(1);
    // The in-service client span 'b' must not count as a second gateway request.
    expect(topo.nodes.get('gateway')!.requests.rate(999, 1)).toBe(1);
  });

  it('expires stale nodes and edges and bumps the structure version', () => {
    const topo = new Topology();
    topo.ingest(trace());
    const v = topo.structureVersion;
    expect(topo.expire(50_000, 60_000)).toBe(false);
    expect(topo.expire(200_000, 60_000)).toBe(true);
    expect(topo.nodes.size).toBe(0);
    expect(topo.structureVersion).toBeGreaterThan(v);
  });
});
