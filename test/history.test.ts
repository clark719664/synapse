import { describe, expect, it } from 'vitest';
import { BurstDetector } from '../src/live/bursts';
import { KINDS, parseSnapshot, RollingHistory, type Snapshot } from '../src/live/history';

const B = Date.UTC(2026, 9, 22, 3, 30, 15); // boundary, on a whole second

function snapshot(over: Record<string, unknown> = {}) {
  const zeros = (n: number) => Object.fromEntries(KINDS.map((k) => [k, new Array(n).fill(0)]));
  const seconds = { start: B - 3600_000, ...zeros(3600) } as unknown as { total: number[] };
  const minutes = { start: (Math.floor(B / 60_000) - 1440) * 60_000, ...zeros(1440) } as unknown as { total: number[] };
  seconds.total[3599] = 7;  // the second just before the boundary
  seconds.total[3590] = 3;
  minutes.total[1439] = 40; // the last whole minute before the boundary's minute
  return {
    v: 2, generatedAt: B + 61_000, boundary: B, coverage: [[B - 7200_000, B]], seconds, minutes,
    baselines: { 'en.wikipedia.org': 2.5 }, bursts: [], cells: [[35.5, 135.5, 4, 1]],
    recentPins: [[B - 5000, 35.01, 135.76, 2, 0, 'en.wikipedia.org', 'Kyoto']], lookups: { asked: 10, located: 4 },
    ...over,
  };
}

describe('parseSnapshot', () => {
  it('accepts a well-formed snapshot', () => {
    const s = parseSnapshot(snapshot())!;
    expect(s.boundary).toBe(B);
    expect(s.seconds.total).toHaveLength(3600);
    expect(s.recentPins[0]![6]).toBe('Kyoto');
  });

  it('rejects the wrong version, wrong lengths and a boundary that does not end the seconds', () => {
    expect(parseSnapshot(snapshot({ v: 1 }))).toBeNull();
    expect(parseSnapshot(snapshot({ boundary: B + 1000 }))).toBeNull();
    const short = snapshot();
    (short.seconds as { total: number[] }).total.pop();
    expect(parseSnapshot(short)).toBeNull();
    expect(parseSnapshot(null)).toBeNull();
  });

  it('drops malformed pins and cells instead of trusting them', () => {
    const s = parseSnapshot(snapshot({ cells: [[95, 0, 1, 0], [10.5, 20.5, 2, 0]], recentPins: [[1, 2, 3], [B, 10, 20, 9, 0, 'h', 't']] }))!;
    expect(s.cells).toEqual([[10.5, 20.5, 2, 0]]);
    expect(s.recentPins).toEqual([]);
  });
});

describe('RollingHistory', () => {
  const loaded = () => {
    const h = new RollingHistory(B);
    h.load(parseSnapshot(snapshot()) as Snapshot);
    return h;
  };

  it('counts only what the snapshot does not already have, each change once', () => {
    const h = loaded();
    expect(h.record('old', B - 1, 'registered', false, false)).toBe(false);
    expect(h.record('a', B + 10, 'bots', true, false)).toBe(true);
    expect(h.record('a', B + 10, 'bots', true, false)).toBe(false);
    h.cover(B, B + 1500);
    const w = h.window('second', 20, B + 1500);
    const last = w.values.total.slice(-2);
    expect(last).toEqual([1, 0]);
    expect(w.values.total.at(-3)).toBe(7);
    expect(w.values.flagged.at(-2)).toBe(1);
    expect(w.values.bots.at(-2)).toBe(1);
  });

  it('keeps automatic category updates out of the change total', () => {
    const h = loaded();
    h.record('c', B + 10, 'bots', false, true);
    h.cover(B, B + 900);
    const w = h.window('second', 1, B + 900);
    expect(w.values.total).toEqual([0]);
    expect(w.values.automatic).toEqual([1]);
  });

  it('rebuilds the minute holding the boundary from the snapshot seconds', () => {
    const h = loaded();
    h.cover(B, B + 1000);
    const w = h.window('minute', 2, B + 1000);
    expect(w.values.total).toEqual([40, 10]);
  });

  it('never reports a longer window with fewer changes than a shorter one inside it', () => {
    const h = new RollingHistory(B);
    h.cover(B + 30_500, B + 30_500);
    for (let i = 0; i < 200; i++) {
      const dt = B + 30_500 + i * 997;
      h.record(`e${i}`, dt, 'registered', false, false);
      h.cover(B, dt);
    }
    const now = B + 30_500 + 200 * 997;
    const sum = (v: (number | null)[]) => v.reduce<number>((a, x) => a + (x ?? 0), 0);
    const hour = sum(h.window('second', 3600, now).values.total);
    const day = sum(h.window('minute', 1440, now).values.total);
    expect(hour).toBe(200);
    expect(day).toBeGreaterThanOrEqual(hour);
  });

  it('shows unwatched time as gaps and says how much is missing', () => {
    const h = new RollingHistory(B);
    h.cover(B + 5000, B + 9000);
    const w = h.window('second', 10, B + 9500);
    expect(w.values.total.slice(0, 5)).toEqual([null, null, null, null, null]);
    expect(w.values.total[6]).toBe(0);
    expect(w.missingMs).toBe(5000);
  });
});

describe('BurstDetector.seed', () => {
  it('starts warm from the collector\'s baselines and carries a running burst on', () => {
    const d = new BurstDetector();
    d.seed({ 'en.wikipedia.org': 2 }, [{ key: 'zh.wikisource.org', since: B - 30_000, endedAt: null, baseline: 0.5, peakRate: 9 }], B);
    expect(d.isWarm(B)).toBe(true);
    expect(d.baseline('en.wikipedia.org')).toBe(2);
    expect(d.active().map((b) => b.key)).toEqual(['zh.wikisource.org']);
    for (let s = 0; s < 15; s++) for (let i = 0; i < 12; i++) d.add('en.wikipedia.org', B + s * 1000 + i * 80);
    expect(d.tick(B + 15_000).started.map((b) => b.key)).toEqual(['en.wikipedia.org']);
  });
});
