import { describe, expect, it } from 'vitest';
import { EWMA, formatMs, LatencyWindow, RateCounter } from '../src/model/stats';

describe('RateCounter', () => {
  it('averages events over a trailing window', () => {
    const c = new RateCounter(10);
    for (let s = 0; s < 5; s++) for (let i = 0; i < 4; i++) c.add(s * 1000 + i * 100);
    expect(c.rate(4999, 5)).toBe(4);
    expect(c.rate(4999, 10)).toBe(2);
    // Events keep landing in the right bucket even when time advances by several seconds at once.
    c.add(9500);
    expect(c.series(9999, 10)).toEqual([4, 4, 4, 4, 4, 0, 0, 0, 0, 1]);
  });

  it('ignores events older than the ring', () => {
    const c = new RateCounter(3);
    c.add(10_000);
    c.add(1_000); // far in the past relative to the head
    expect(c.rate(10_000, 3)).toBeCloseTo(1 / 3);
  });
});

describe('LatencyWindow', () => {
  it('computes nearest-rank percentiles and prunes by time', () => {
    const w = new LatencyWindow(1000);
    [50, 10, 30, 20, 40].forEach((v, i) => w.add(i * 10, v));
    expect(w.percentile(0.5)).toBe(30);
    expect(w.percentile(1)).toBe(50);
    expect(w.percentile(0)).toBe(10);
    w.prune(1015); // drops samples at t=0 and t=10
    expect(w.count).toBe(3);
    expect(w.percentile(0)).toBe(20);
    w.prune(5000);
    expect(w.percentile(0.5)).toBeNaN();
  });

  it('caps the number of samples', () => {
    const w = new LatencyWindow(1e9, 3);
    for (let i = 0; i < 10; i++) w.add(i, i);
    expect(w.count).toBe(3);
    expect(w.percentile(0)).toBe(7);
  });
});

describe('EWMA and formatting', () => {
  it('smooths', () => {
    const e = new EWMA(0.5);
    expect(e.push(10)).toBe(10);
    expect(e.push(0)).toBe(5);
  });
  it('formats durations', () => {
    expect(formatMs(0.25)).toBe('250µs');
    expect(formatMs(5.25)).toBe('5.3ms');
    expect(formatMs(120)).toBe('120ms');
    expect(formatMs(2500)).toBe('2.50s');
    expect(formatMs(NaN)).toBe('–');
  });
});
