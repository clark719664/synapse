import { describe, expect, it } from 'vitest';
import { Engine, TRACE_VOCAB, TRAVEL_MS } from '../src/app/engine';
import type { Span } from '../src/model/span';

const span = (over: Partial<Span>): Span => ({
  traceId: 't', spanId: 's', parentSpanId: null, service: 'svc', name: 'op', kind: 'server', start: 0, end: 0, status: 'ok', attributes: {}, ...over,
});

/** editor → wiki → stream, all asynchronous, like a live Wikipedia change. */
const chain = (traceId: string, at: number, lag: number): Span[] => [
  span({ traceId, spanId: `${traceId}1`, service: 'bots', kind: 'producer', start: at, end: at }),
  span({ traceId, spanId: `${traceId}2`, parentSpanId: `${traceId}1`, service: 'en.wikipedia.org', kind: 'consumer', start: at, end: at }),
  span({ traceId, spanId: `${traceId}3`, parentSpanId: `${traceId}2`, service: 'EventStreams', kind: 'consumer', start: at, end: at + lag }),
];

describe('Engine feed mode', () => {
  it('holds feed traces until the playout clock reaches them', () => {
    const engine = new Engine();
    engine.goFeed(TRACE_VOCAB, 3000);
    engine.enqueue(chain('a', Date.now() - 1000, 900));
    engine.update();
    expect(engine.tracesSeen).toBe(0);
    expect(engine.pendingCount).toBe(1);
    engine.clock.seek(Date.now());
    engine.update();
    expect(engine.tracesSeen).toBe(1);
    expect(engine.pendingCount).toBe(0);
  });

  it('presents a trace that arrives after its slot immediately, keeping its internal timing', () => {
    const engine = new Engine();
    engine.goFeed(TRACE_VOCAB, 1000);
    const spans = chain('b', Date.now() - 60_000, 900);
    engine.enqueue(spans);
    expect(engine.lateTraces).toBe(1);
    engine.update();
    expect(engine.tracesSeen).toBe(1);
    const t = engine.recentTraces[0]!;
    expect(t.end - t.start).toBe(900);
    expect(t.start).toBeGreaterThan(Date.now() - 2000);
  });

  it('gives asynchronous hops one particle each, chained so the next leaves when the last lands', () => {
    const engine = new Engine();
    engine.goFeed(TRACE_VOCAB, 0);
    const at = Date.now() - 10;
    engine.enqueue(chain('c', at, 900));
    engine.update();
    const [hop1, hop2, ...rest] = [...engine.particles].sort((x, y) => x.departAt - y.departAt);
    expect(rest).toHaveLength(0);
    expect(hop1!.oneWay && hop2!.oneWay).toBe(true);
    expect(hop1!.edge.id).toBe('bots→en.wikipedia.org');
    expect(hop2!.edge.id).toBe('en.wikipedia.org→EventStreams');
    expect(hop2!.departAt).toBe(hop1!.arriveAt);
    expect(hop1!.arriveAt - hop1!.departAt).toBe(TRAVEL_MS);
  });

  it('keeps request/response pairs for synchronous calls', () => {
    const engine = new Engine();
    engine.goFeed(TRACE_VOCAB, 0);
    const at = Date.now() - 10;
    engine.enqueue([
      span({ traceId: 'd', spanId: 'd1', service: 'gateway', start: at, end: at + 50 }),
      span({ traceId: 'd', spanId: 'd2', parentSpanId: 'd1', service: 'api', start: at + 5, end: at + 40 }),
    ]);
    engine.update();
    expect(engine.particles.map((p) => p.backward).sort()).toEqual([false, true]);
    expect(engine.particles.every((p) => !p.oneWay)).toBe(true);
  });

  it('ignores feed traffic once it has switched to another source', () => {
    const engine = new Engine();
    engine.goFeed(TRACE_VOCAB, 0);
    engine.goSim();
    engine.enqueue(chain('e', Date.now(), 100));
    expect(engine.pendingCount).toBe(0);
  });
});
