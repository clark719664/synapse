/**
 * Small, allocation-light statistics used for the live metrics.
 */

/** Fixed-size ring of per-second counters. */
export class RateCounter {
  private readonly buckets: Float64Array;
  private head = 0;
  private headSecond: number | null = null;

  constructor(readonly seconds = 60) {
    this.buckets = new Float64Array(seconds);
  }

  add(timeMs: number, n = 1): void {
    const sec = Math.floor(timeMs / 1000);
    this.advance(sec);
    const head = this.headSecond!;
    if (sec >= head - this.seconds + 1) {
      const idx = (this.head - (head - sec) + this.seconds * 2) % this.seconds;
      this.buckets[idx]! += n;
    }
  }

  /** Average events per second over the trailing `window` seconds ending at `timeMs`. */
  rate(timeMs: number, window = 10): number {
    const sec = Math.floor(timeMs / 1000);
    this.advance(sec);
    let total = 0;
    const w = Math.min(window, this.seconds);
    for (let i = 0; i < w; i++) total += this.buckets[(this.head - i + this.seconds) % this.seconds]!;
    return total / w;
  }

  /** Oldest → newest per-second counts, for sparklines. */
  series(timeMs: number, count = this.seconds): number[] {
    this.advance(Math.floor(timeMs / 1000));
    const out: number[] = [];
    const c = Math.min(count, this.seconds);
    for (let i = c - 1; i >= 0; i--) out.push(this.buckets[(this.head - i + this.seconds) % this.seconds]!);
    return out;
  }

  private advance(sec: number): void {
    if (this.headSecond === null) { this.headSecond = sec; return; }
    while (this.headSecond < sec) {
      this.head = (this.head + 1) % this.seconds;
      this.buckets[this.head] = 0;
      this.headSecond++;
    }
  }
}

/** Keeps recent (time, value) samples and answers percentile queries over a trailing window. */
export class LatencyWindow {
  private times: number[] = [];
  private values: number[] = [];

  constructor(readonly windowMs = 30_000, readonly maxSamples = 4096) {}

  add(timeMs: number, value: number): void {
    this.times.push(timeMs);
    this.values.push(value);
    if (this.times.length > this.maxSamples) this.evict(this.times.length - this.maxSamples);
  }

  prune(nowMs: number): void {
    let drop = 0;
    while (drop < this.times.length && this.times[drop]! < nowMs - this.windowMs) drop++;
    if (drop) this.evict(drop);
  }

  get count(): number {
    return this.values.length;
  }

  /** Nearest-rank percentile; `p` in [0, 1]. Returns NaN with no samples. */
  percentile(p: number): number {
    if (this.values.length === 0) return NaN;
    const sorted = this.values.slice().sort((a, b) => a - b);
    const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return sorted[rank]!;
  }

  private evict(n: number): void {
    this.times.splice(0, n);
    this.values.splice(0, n);
  }
}

/** Exponentially weighted moving average. */
export class EWMA {
  value = NaN;
  constructor(readonly alpha = 0.2) {}
  push(x: number): number {
    this.value = Number.isNaN(this.value) ? x : this.value + this.alpha * (x - this.value);
    return this.value;
  }
}

export const formatMs = (ms: number): string => {
  if (!Number.isFinite(ms)) return '–';
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms < 10 ? ms.toFixed(1) : ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
};
