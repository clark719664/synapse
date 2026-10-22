import { describe, expect, it } from 'vitest';
import { BurstDetector } from '../src/live/bursts';

/** Feeds `perSecond` events per second for `seconds` seconds starting at `from` (ms), ticking once a second. */
function run(d: BurstDetector, key: string, from: number, seconds: number, perSecond: number) {
  const started: string[] = [];
  const ended: string[] = [];
  for (let s = 0; s < seconds; s++) {
    const t0 = from + s * 1000;
    for (let i = 0; i < perSecond; i++) d.add(key, t0 + (i * 1000) / perSecond);
    const r = d.tick(t0 + 999);
    started.push(...r.started.map((b) => b.key));
    ended.push(...r.ended.map((b) => b.key));
  }
  return { started, ended };
}

describe('BurstDetector', () => {
  it('learns a steady baseline during warm-up and stays quiet', () => {
    const d = new BurstDetector();
    const { started } = run(d, 'en', 0, 120, 4);
    expect(started).toEqual([]);
    expect(d.baseline('en')).toBeCloseTo(4, 0);
    expect(d.rate('en', 119_999)).toBeCloseTo(4, 1);
  });

  it('does not flag anything before warm-up, however busy', () => {
    const d = new BurstDetector({ warmupS: 60 });
    expect(run(d, 'zh', 0, 50, 30).started).toEqual([]);
  });

  it('flags a jump to several times the usual rate and reports the pre-burst baseline', () => {
    const d = new BurstDetector();
    run(d, 'en', 0, 90, 2);
    const { started } = run(d, 'en', 90_000, 15, 12);
    expect(started).toEqual(['en']);
    const [b] = d.active();
    expect(b!.baseline).toBeCloseTo(2, 0);
    expect(b!.rate).toBeGreaterThan(6);
    expect(d.history[0]).toBe(b);
  });

  it('ends the burst when the rate falls back', () => {
    const d = new BurstDetector();
    run(d, 'en', 0, 90, 2);
    run(d, 'en', 90_000, 20, 12);
    const { ended } = run(d, 'en', 110_000, 20, 2);
    expect(ended).toEqual(['en']);
    expect(d.active()).toEqual([]);
    expect(d.history[0]!.endedAt).not.toBeNull();
    expect(d.history[0]!.peakRate).toBeGreaterThanOrEqual(10);
  });

  it('flags a key that appears from nowhere after warm-up, but not a trickle', () => {
    const d = new BurstDetector();
    run(d, 'en', 0, 70, 2);
    for (let s = 0; s < 20; s++) {
      if (s % 2 === 0) d.add('tiny', 70_000 + s * 1000);
      expect(d.tick(70_000 + s * 1000 + 999).started).toEqual([]);
    }
    const busy = new BurstDetector();
    run(busy, 'en', 0, 70, 2);
    expect(run(busy, 'zh.wikisource.org', 70_000, 12, 8).started).toEqual(['zh.wikisource.org']);
  });

  it('adopts a sustained burst as the new normal', () => {
    const d = new BurstDetector({ maxBurstS: 60 });
    run(d, 'en', 0, 90, 2);
    run(d, 'en', 90_000, 15, 12);
    const { ended } = run(d, 'en', 105_000, 60, 12);
    expect(ended).toEqual(['en']);
    expect(d.baseline('en')).toBeGreaterThan(10);
    expect(run(d, 'en', 165_000, 20, 12).started).toEqual([]);
  });

  it('decays the baseline across a long silence without looping forever', () => {
    const d = new BurstDetector();
    run(d, 'en', 0, 90, 5);
    d.add('en', 90_000 + 3_600_000);
    expect(d.baseline('en')).toBeLessThan(0.01);
  });
});
