import { LatencyWindow, RateCounter } from '../model/stats';
import { assembleTraces, duration, type Span, type Trace } from '../model/span';
import { Topology, type ServiceEdge, type Transfer } from '../model/topology';
import { TrafficGenerator } from '../sim/generator';
import { combine, SCENARIOS, type Scenario } from '../sim/scenarios';
import { VirtualClock } from './clock';

export type ParticleStatus = 'ok' | 'error' | 'slow';

/** One data transfer in flight along an edge. Positions are derived from the clock, never stored. */
export interface Particle {
  edge: ServiceEdge;
  /** Virtual time the particle leaves its origin. */
  departAt: number;
  arriveAt: number;
  /** false: source→target (request); true: target→source (response). */
  backward: boolean;
  /** True for the single particle of an asynchronous (consumer) hop. */
  oneWay: boolean;
  status: ParticleStatus;
  traceId: string;
  span: Span;
}

export type SourceMode = 'sim' | 'feed' | 'replay';

export interface Kpis {
  rps: number;
  errorRate: number;
  p50: number;
  p95: number;
  inFlight: number;
  tracesSeen: number;
}

/** What the UI calls things, so the same panels can describe HTTP traffic or wiki edits. */
export interface Vocabulary {
  rate: string;
  unit: string;
  errors: string;
  latency: string;
  nodes: string;
  stream: string;
  request: string;
  slow: string;
  error: string;
}

export const TRACE_VOCAB: Vocabulary = {
  rate: 'Requests / s', unit: 'rps', errors: 'Error rate', latency: '', nodes: 'Services', stream: 'Trace stream',
  request: 'request', slow: 'slow response', error: 'error',
};

/** An anomaly the data source has detected on a node (e.g. an edit burst on one wiki). */
export interface Alert {
  node: string;
  since: number;
  label: string;
  detail: string;
}

export interface EngineEvents {
  onStructureChange?: () => void;
  onTrace?: (trace: Trace) => void;
}

/** Visual travel time of a particle, in virtual milliseconds. */
export const TRAVEL_MS = 550;
/** How long a landed particle is kept so the renderer can draw its arrival flare. */
export const FLARE_MS = 420;
/** A span slower than this many times the edge's running p50 is drawn amber. */
const SLOW_FACTOR = 3;
const RECENT_LIMIT = 1000;
const NODE_TTL_MS = 90_000;
const FEED_NODE_TTL_MS = 45_000;
const PENDING_LIMIT = 5000;

/**
 * Owns all mutable application state: the clock, the active data source, the
 * derived topology, in-flight particles and rolling KPIs. The renderer and UI
 * only read from it.
 */
export class Engine {
  readonly clock = new VirtualClock();
  readonly topology = new Topology();
  readonly particles: Particle[] = [];
  readonly recentTraces: Trace[] = [];
  readonly rootLatency = new LatencyWindow(30_000);
  readonly traceCount = new RateCounter();
  readonly errorCount = new RateCounter();
  readonly alerts = new Map<string, Alert>();

  mode: SourceMode = 'sim';
  vocab: Vocabulary = TRACE_VOCAB;
  generator: TrafficGenerator;
  readonly activeScenarios = new Set<string>();

  /** Replay dataset, sorted by start. */
  private replayTraces: Trace[] = [];
  private replayCursor = 0;
  replayLoop = true;

  /** Live-feed traces waiting for the playout clock to reach them, sorted by start. */
  private pending: Trace[] = [];
  /** How far the feed's playout clock runs behind wall time. */
  playoutMs = 0;
  /** Feed traces that arrived after their slot and were presented late. */
  lateTraces = 0;

  selectedTrace: Trace | null = null;
  selectedService: string | null = null;
  tracesSeen = 0;
  private lastStructureVersion = -1;
  private lastExpire = 0;

  constructor(private readonly events: EngineEvents = {}) {
    this.generator = new TrafficGenerator({ seed: Date.now() & 0xffff, rps: 14, startTime: this.clock.now() });
  }

  // ----------------------------------------------------------------- sources
  setRps(rps: number): void {
    this.generator.rps = rps;
  }

  toggleScenario(id: string): void {
    if (this.activeScenarios.has(id)) this.activeScenarios.delete(id);
    else this.activeScenarios.add(id);
    this.applyScenarios();
  }

  private applyScenarios(): void {
    const active: Scenario[] = SCENARIOS.filter((s) => this.activeScenarios.has(s.id));
    const c = combine(active);
    this.generator.trafficMultiplier = c.trafficMultiplier;
    this.generator.modifier = c.modifier;
  }

  /** Switches to replaying a set of parsed spans. Returns the dataset's time range. */
  loadReplay(spans: readonly Span[]): { start: number; end: number; traces: number } {
    const traces = assembleTraces(spans);
    if (traces.length === 0) throw new Error('No traces found in that file.');
    this.replayTraces = traces;
    this.replayCursor = 0;
    this.mode = 'replay';
    this.vocab = TRACE_VOCAB;
    this.resetDerivedState();
    const start = traces[0]!.start;
    const end = Math.max(...traces.map((t) => t.end));
    this.clock.resume();
    this.clock.seek(start - 500);
    return { start, end, traces: traces.length };
  }

  get replayRange(): { start: number; end: number } | null {
    if (this.replayTraces.length === 0) return null;
    return { start: this.replayTraces[0]!.start, end: Math.max(...this.replayTraces.map((t) => t.end)) };
  }

  /** Back to the live simulation. */
  goSim(): void {
    this.mode = 'sim';
    this.vocab = TRACE_VOCAB;
    this.resetDerivedState();
    this.restartWallClock(0);
    this.generator = new TrafficGenerator({ seed: Date.now() & 0xffff, rps: this.generator.rps, startTime: this.clock.now() });
    this.applyScenarios();
  }

  /**
   * Switches to an external live feed. The clock runs `playoutMs` behind wall
   * time, like a broadcast delay, so events can be placed at their real times
   * even though each one reaches the browser a little after it happened.
   */
  goFeed(vocab: Vocabulary, playoutMs: number): void {
    this.mode = 'feed';
    this.vocab = vocab;
    this.playoutMs = playoutMs;
    this.resetDerivedState();
    this.restartWallClock(playoutMs);
  }

  /** Drops queued feed traffic and re-syncs the playout clock, e.g. after the tab was hidden. */
  resyncFeed(): void {
    this.pending.length = 0;
    this.particles.length = 0;
    this.restartWallClock(this.playoutMs);
  }

  /** Queues spans from a live feed; they are released when the playout clock reaches them. */
  enqueue(spans: readonly Span[]): void {
    if (this.mode !== 'feed') return;
    const now = this.clock.now();
    for (const t of assembleTraces(spans)) {
      if (t.start < now) {
        // Arrived after its slot: present it now rather than drop it, keeping its internal timing.
        const shift = now - t.start;
        for (const s of t.spans) { s.start += shift; s.end += shift; }
        t.start += shift;
        t.end += shift;
        this.lateTraces++;
      }
      let i = this.pending.length;
      while (i > 0 && this.pending[i - 1]!.start > t.start) i--;
      this.pending.splice(i, 0, t);
    }
    if (this.pending.length > PENDING_LIMIT) this.pending.splice(0, this.pending.length - PENDING_LIMIT);
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  private restartWallClock(behindMs: number): void {
    this.clock.speed = 1;
    this.clock.resume();
    this.clock.seek(Date.now() - behindMs);
  }

  seek(virtualMs: number): void {
    this.clock.seek(virtualMs);
    this.particles.length = 0;
    // Re-arm the replay cursor at the first trace starting after the new time.
    this.replayCursor = this.replayTraces.findIndex((t) => t.start >= virtualMs);
    if (this.replayCursor < 0) this.replayCursor = this.replayTraces.length;
  }

  private resetDerivedState(): void {
    this.particles.length = 0;
    this.recentTraces.length = 0;
    this.pending.length = 0;
    this.alerts.clear();
    this.lateTraces = 0;
    this.selectedTrace = null;
    this.selectedService = null;
    this.topology.nodes.clear();
    this.topology.edges.clear();
    this.tracesSeen = 0;
    this.lastStructureVersion = -1;
    this.events.onStructureChange?.();
  }

  // ------------------------------------------------------------------ update
  /** Advances the active source to the clock's current time. Call once per frame. */
  update(): number {
    const now = this.clock.now();

    if (this.mode === 'sim') {
      for (const t of this.generator.tick(now)) this.ingest(t);
    } else if (this.mode === 'feed') {
      let n = 0;
      while (n < this.pending.length && this.pending[n]!.start <= now) this.ingest(this.pending[n++]!);
      if (n) this.pending.splice(0, n);
    } else {
      while (this.replayCursor < this.replayTraces.length && this.replayTraces[this.replayCursor]!.start <= now) {
        this.ingest(this.replayTraces[this.replayCursor++]!);
      }
      if (this.replayLoop && this.replayCursor >= this.replayTraces.length && this.replayTraces.length > 0) {
        const range = this.replayRange!;
        if (now > range.end + 1500) this.seek(range.start - 500);
      }
    }

    // Keep landed particles briefly for their arrival flare.
    let w = 0;
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i]!;
      if (p.arriveAt + FLARE_MS >= now && p.departAt <= now + 60_000) this.particles[w++] = p;
    }
    this.particles.length = w;

    if (now - this.lastExpire > 5000) {
      this.lastExpire = now;
      this.rootLatency.prune(now);
      for (const n of this.topology.nodes.values()) n.latency.prune(now);
      for (const e of this.topology.edges.values()) e.latency.prune(now);
      if (this.mode !== 'replay') this.topology.expire(now, this.mode === 'feed' ? FEED_NODE_TTL_MS : NODE_TTL_MS);
    }

    if (this.topology.structureVersion !== this.lastStructureVersion) {
      this.lastStructureVersion = this.topology.structureVersion;
      this.events.onStructureChange?.();
    }
    return now;
  }

  private ingest(trace: Trace): void {
    const transfers = this.topology.ingest(trace);
    this.tracesSeen++;
    this.traceCount.add(trace.start);
    if (trace.hasError) this.errorCount.add(trace.start);
    this.rootLatency.add(trace.start, trace.end - trace.start);
    this.recentTraces.push(trace);
    if (this.recentTraces.length > RECENT_LIMIT) this.recentTraces.shift();
    const arrivals = new Map<string, number>();
    for (const t of transfers) this.schedule(t, arrivals);
    this.events.onTrace?.(trace);
  }

  private schedule(t: Transfer, arrivals: Map<string, number>): void {
    const edge = this.topology.edges.get(t.edgeId)!;
    const p50 = edge.latency.percentile(0.5);
    const d = duration(t.span);
    const status: ParticleStatus = t.span.status === 'error' ? 'error' : Number.isFinite(p50) && d > p50 * SLOW_FACTOR && d > 20 ? 'slow' : 'ok';
    const base = { edge, traceId: t.traceId, span: t.span };
    if (t.span.kind === 'consumer') {
      // A message has no response. Chain hops visually: it leaves once the previous hop has landed.
      const upstream = t.span.parentSpanId ? arrivals.get(t.span.parentSpanId) : undefined;
      const departAt = Math.max(t.span.start, upstream ?? -Infinity);
      arrivals.set(t.span.spanId, departAt + TRAVEL_MS);
      this.particles.push({ ...base, departAt, arriveAt: departAt + TRAVEL_MS, backward: false, oneWay: true, status });
      return;
    }
    arrivals.set(t.span.spanId, t.span.start + TRAVEL_MS);
    this.particles.push({ ...base, departAt: t.span.start, arriveAt: t.span.start + TRAVEL_MS, backward: false, oneWay: false, status: 'ok' });
    this.particles.push({ ...base, departAt: t.span.end, arriveAt: t.span.end + TRAVEL_MS, backward: true, oneWay: false, status });
  }

  // ------------------------------------------------------------------- stats
  kpis(now: number): Kpis {
    let inFlight = 0;
    for (const p of this.particles) if (p.departAt <= now && p.arriveAt > now) inFlight++;
    const rate = this.traceCount.rate(now, 10);
    return {
      rps: rate,
      errorRate: rate > 0 ? this.errorCount.rate(now, 10) / rate : 0,
      p50: this.rootLatency.percentile(0.5),
      p95: this.rootLatency.percentile(0.95),
      inFlight,
      tracesSeen: this.tracesSeen,
    };
  }

  selectTrace(trace: Trace | null): void {
    this.selectedTrace = trace;
  }

  selectService(id: string | null): void {
    this.selectedService = id;
  }

  /** Recent traces, newest first, optionally filtered to a service. */
  stream(limit = 60): Trace[] {
    const out: Trace[] = [];
    for (let i = this.recentTraces.length - 1; i >= 0 && out.length < limit; i--) {
      const t = this.recentTraces[i]!;
      if (this.selectedService && !t.services.includes(this.selectedService)) continue;
      out.push(t);
    }
    return out;
  }
}
