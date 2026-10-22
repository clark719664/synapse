import { describe, expect, it } from 'vitest';
import { Engine } from '../src/app/engine';
import type { EventSourceLike } from '../src/live/feed';
import { WIKI_VOCAB, WikipediaSource } from '../src/live/source';

class FakeSource implements EventSourceLike {
  readyState = 1;
  onopen: ((ev: Event) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  close() { this.readyState = 2; }
}

const change = (n: number, dt: number) => JSON.stringify({
  meta: { id: `id-${n}`, dt: new Date(dt).toISOString(), domain: 'en.wikipedia.org' },
  type: 'edit', namespace: 1, title: `Talk:${n}`, user: 'Ada', bot: false, server_name: 'en.wikipedia.org',
});

describe('WikipediaSource', () => {
  it('counts replayed history but only animates changes once the stream has caught up, whatever the device clock says', () => {
    const skew = 7000; // this device's clock runs 7 s ahead of Wikimedia's
    let now = Date.now();
    const sources: FakeSource[] = [];
    const engine = new Engine();
    const wiki = new WikipediaSource(engine, undefined, { connect: () => { const s = new FakeSource(); sources.push(s); return s; }, now: () => now });
    engine.goFeed(WIKI_VOCAB, 0);
    wiki.feed.start();
    const send = (n: number, dt: number) => sources[0]!.onmessage!({ data: change(n, dt) } as MessageEvent);

    // Replay: 90 s of history delivered in under a second.
    const replayStart = now - skew - 90_000;
    for (let i = 0; i < 900; i++) { send(i, replayStart + i * 100); now += 1; }
    expect(engine.pendingCount).toBe(0);

    // Live: one change every 100 ms, arriving at the pace it happens.
    for (let i = 900; i < 940; i++) { now += 100; send(i, now - skew - 900); }
    expect(engine.pendingCount).toBeGreaterThan(20);
    expect(engine.pendingCount).toBeLessThan(40);

    // Everything, replayed or live, is in the history exactly once.
    const w = wiki.history.window('minute', 5, now - skew);
    expect(w.values.total.reduce<number>((a, v) => a + (v ?? 0), 0)).toBe(940);
  });
});
