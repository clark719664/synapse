export interface Burst {
  key: string;
  since: number;
  /** The key's usual rate (events/s) when the burst began; held fixed while it lasts. */
  baseline: number;
  /** Current events/s over the short window. */
  rate: number;
  peakRate: number;
  endedAt: number | null;
}

export interface BurstOptions {
  /** Seconds in the short "current rate" window. */
  windowS: number;
  /** Time constant of the baseline EWMA, in seconds. */
  tauS: number;
  /** No bursts are declared until the detector has watched this long, so baselines can settle. */
  warmupS: number;
  startRatio: number;
  endRatio: number;
  /** A burst also needs at least this many events/s, so a quiet wiki going 0.1 → 0.4 isn't one. */
  minRate: number;
  /** Baselines never count as lower than this, so a key that appears from nowhere has a finite ratio. */
  floor: number;
  /** A burst that lasts this long is the new normal: the baseline adopts the current rate. */
  maxBurstS: number;
}

const DEFAULTS: BurstOptions = { windowS: 10, tauS: 180, warmupS: 60, startRatio: 3, endRatio: 1.5, minRate: 1, floor: 0.2, maxBurstS: 300 };

interface KeyState {
  counts: Float64Array;
  /** The second currently being counted into `counts`. */
  sec: number;
  baseline: number;
  /** Seconds folded into the baseline so far; drives the warm-up running mean. */
  observed: number;
  lastEventAt: number;
  burst: Burst | null;
}

/**
 * Per-key rate anomaly detector: a key is bursting while its short-window
 * rate is several times its own slow-moving baseline. Time is always passed
 * in, so it is deterministic and testable.
 */
export class BurstDetector {
  readonly options: BurstOptions;
  private readonly keys = new Map<string, KeyState>();
  private startedAt: number | null = null;
  /** Most recent bursts first, including finished ones. */
  readonly history: Burst[] = [];

  constructor(options: Partial<BurstOptions> = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  isWarm(timeMs: number): boolean {
    return this.startedAt !== null && timeMs - this.startedAt >= this.options.warmupS * 1000;
  }

  add(key: string, timeMs: number): void {
    const w = this.options.windowS;
    if (this.startedAt === null) this.startedAt = timeMs;
    const sec = Math.floor(timeMs / 1000);
    let s = this.keys.get(key);
    if (!s) {
      // Keys first seen after warm-up start from the floor, so genuinely new activity can register.
      const warm = this.isWarm(timeMs);
      s = { counts: new Float64Array(w), sec, baseline: warm ? this.options.floor : 0, observed: warm ? this.options.warmupS : 0, lastEventAt: timeMs, burst: null };
      this.keys.set(key, s);
    }
    this.advance(s, sec, timeMs);
    s.lastEventAt = Math.max(s.lastEventAt, timeMs);
    if (sec > s.sec - w) s.counts[sec % w]! += 1;
  }

  private fold(s: KeyState, v: number, timeMs: number): void {
    if (s.burst) return;
    s.observed++;
    if (this.isWarm(timeMs)) s.baseline += (v - s.baseline) * (1 - Math.exp(-1 / this.options.tauS));
    else s.baseline += (v - s.baseline) / s.observed;
  }

  /** Folds every completed second into the baseline and recycles its bucket. */
  private advance(s: KeyState, sec: number, timeMs: number): void {
    const w = this.options.windowS;
    const steps = sec - s.sec;
    if (steps <= 0) return;
    const walk = Math.min(steps, w);
    for (let i = 0; i < walk; i++) {
      const done = s.sec + i;
      this.fold(s, s.counts[done % w]!, timeMs);
      s.counts[(done + 1) % w] = 0;
    }
    // The rest of a long silence, in closed form rather than one step per second.
    const zeros = steps - walk;
    if (zeros > 0 && !s.burst) {
      if (this.isWarm(timeMs)) s.baseline *= Math.exp(-zeros / this.options.tauS);
      else s.baseline = (s.baseline * s.observed) / (s.observed + zeros);
      s.observed += zeros;
    }
    if (walk === w) s.counts.fill(0);
    s.sec = sec;
  }

  rate(key: string, timeMs: number): number {
    const s = this.keys.get(key);
    if (!s) return 0;
    this.advance(s, Math.floor(timeMs / 1000), timeMs);
    let total = 0;
    for (const c of s.counts) total += c;
    return total / this.options.windowS;
  }

  /** Re-evaluates every key at `timeMs`; returns bursts that started or ended. */
  tick(timeMs: number): { started: Burst[]; ended: Burst[] } {
    const o = this.options;
    const started: Burst[] = [];
    const ended: Burst[] = [];
    for (const [key, s] of this.keys) {
      const r = this.rate(key, timeMs);
      if (s.burst) {
        const b = s.burst;
        b.rate = r;
        b.peakRate = Math.max(b.peakRate, r);
        const overLong = timeMs - b.since >= o.maxBurstS * 1000;
        if (r < o.endRatio * b.baseline || r < o.minRate * 0.5 || overLong) {
          b.endedAt = timeMs;
          if (overLong) s.baseline = r;
          ended.push(b);
          s.burst = null;
        }
      } else if (this.isWarm(timeMs) && r >= o.minRate && r >= o.startRatio * Math.max(o.floor, s.baseline)) {
        s.burst = { key, since: timeMs, baseline: Math.max(o.floor, s.baseline), rate: r, peakRate: r, endedAt: null };
        started.push(s.burst);
        this.history.unshift(s.burst);
        if (this.history.length > 20) this.history.pop();
      }
      if (!s.burst && timeMs - s.lastEventAt > o.tauS * 4000) this.keys.delete(key);
    }
    return { started, ended };
  }

  /** Active bursts, strongest first. */
  active(): Burst[] {
    const out: Burst[] = [];
    for (const s of this.keys.values()) if (s.burst) out.push(s.burst);
    return out.sort((a, b) => b.rate / b.baseline - a.rate / a.baseline);
  }

  /**
   * Starts from someone else's measurements (the collector's): per-key baselines,
   * the burst log, and any burst still running, so there is no warm-up.
   */
  seed(baselines: Record<string, number>, log: readonly Omit<Burst, 'rate'>[], timeMs: number): void {
    const w = this.options.windowS;
    this.startedAt = Math.min(this.startedAt ?? timeMs, timeMs - this.options.warmupS * 1000);
    const state = (key: string, baseline: number): KeyState => {
      const s: KeyState = { counts: new Float64Array(w), sec: Math.floor(timeMs / 1000), baseline, observed: this.options.warmupS, lastEventAt: timeMs, burst: null };
      this.keys.set(key, s);
      return s;
    };
    for (const [key, baseline] of Object.entries(baselines)) state(key, baseline);
    for (const b of [...log].reverse()) {
      const burst: Burst = { ...b, rate: b.peakRate };
      this.history.unshift(burst);
      if (burst.endedAt === null) (this.keys.get(burst.key) ?? state(burst.key, burst.baseline)).burst = burst;
    }
    if (this.history.length > 20) this.history.length = 20;
  }

  baseline(key: string): number {
    return this.keys.get(key)?.baseline ?? 0;
  }
}
