import { describe, expect, it } from 'vitest';
import { SseFeed, type EventSourceLike } from '../src/live/feed';

class FakeSource implements EventSourceLike {
  readyState = 0;
  onopen: ((ev: Event) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  closed = false;
  open() { this.readyState = 1; this.onopen?.(new Event('open')); }
  message(data: string) { this.onmessage?.({ data } as MessageEvent); }
  fail() { this.onerror?.(new Event('error')); }
  close() { this.closed = true; this.readyState = 2; }
}

function harness() {
  let now = 1_000_000;
  const sources: FakeSource[] = [];
  const timers: { fn: () => void; at: number }[] = [];
  const got: [string, number][] = [];
  const feed = new SseFeed('https://example.test/stream', (d, t) => got.push([d, t]), {
    connect: () => { const s = new FakeSource(); sources.push(s); return s; },
    now: () => now,
    setTimer: (fn, ms) => { const t = { fn, at: now + ms }; timers.push(t); return t; },
    clearTimer: (h) => { const i = timers.indexOf(h as never); if (i >= 0) timers.splice(i, 1); },
    stallMs: 10_000,
    reconnectStalledMs: 30_000,
    backoffMs: [1000, 5000],
  });
  const advance = (ms: number) => {
    now += ms;
    for (const t of [...timers]) if (t.at <= now) { timers.splice(timers.indexOf(t), 1); t.fn(); }
  };
  return { feed, sources, got, advance, timers, get now() { return now; } };
}

describe('SseFeed', () => {
  it('goes connecting → live and stamps each message with its arrival time', () => {
    const h = harness();
    h.feed.start();
    expect(h.feed.status().state).toBe('connecting');
    h.sources[0]!.open();
    expect(h.feed.status().state).toBe('live');
    h.advance(250);
    h.sources[0]!.message('{"a":1}');
    expect(h.got).toEqual([['{"a":1}', h.now]]);
    expect(h.feed.status()).toMatchObject({ received: 1, lastEventAt: h.now });
  });

  it('reports a silent connection as stalled, then recycles it', () => {
    const h = harness();
    h.feed.start();
    h.sources[0]!.open();
    h.sources[0]!.message('x');
    h.advance(11_000);
    expect(h.feed.status().state).toBe('stalled');
    h.advance(20_000);
    expect(h.feed.status().state).toBe('connecting');
    expect(h.sources[0]!.closed).toBe(true);
    expect(h.sources).toHaveLength(2);
  });

  it('backs off after errors and says when it will retry', () => {
    const h = harness();
    h.feed.start();
    h.sources[0]!.fail();
    let s = h.feed.status();
    expect(s.state).toBe('disconnected');
    expect(s.retryAt).toBe(h.now + 1000);
    expect(h.sources[0]!.closed).toBe(true);
    h.advance(1000);
    expect(h.feed.status().state).toBe('connecting');
    h.sources[1]!.fail();
    s = h.feed.status();
    expect(s.retryAt).toBe(h.now + 5000);
    h.advance(5000);
    h.sources[2]!.open();
    expect(h.feed.status()).toMatchObject({ state: 'live', retryAt: null, attempts: 0 });
  });

  it('pauses without retrying and ignores events from a closed source', () => {
    const h = harness();
    h.feed.start();
    const first = h.sources[0]!;
    first.open();
    h.feed.pause();
    expect(h.feed.status().state).toBe('paused');
    first.message('late');
    h.advance(60_000);
    expect(h.got).toEqual([]);
    expect(h.sources).toHaveLength(1);
    expect(h.timers).toHaveLength(0);
  });
});
