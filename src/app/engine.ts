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
  status: ParticleStatus;
  traceId: string;
  span: Span;
}

export type SourceMode = 'live' | 'replay';

export interface Kpis {
  rps: number;
  errorRate: number;
  p50: number;
  p95: number;
  inFlight: number;
  tracesSeen: number;
}

export interface EngineEvents {
  onStructureChange?: () => void;
  onTrace?: (trace: Trace) => void;
}

/** Visual travel time of a particle, in virtual milliseconds. */
export const TRAVEL_MS = 550;
/** A span slower than this many times the edge's running p50 is drawn amber. */
const SLOW_FACTOR = 3;
const RECENT_LIMIT = 250;
const NODE_TTL_MS = 90_000;

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

  mode: SourceMode = 'live';
  generator: TrafficGenerator;
  readonly activeScenarios = new Set<string>();

  /** Replay dataset, sorted by start. */
  private replayTraces: Trace[] = [];
  private replayCursor = 0;
  replayLoop = true;

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
  goLive(): void {
    this.mode = 'live';
    this.resetDerivedState();
    this.clock.speed = 1;
    this.clock.resume();
    this.clock.seek(Date.now());
    this.generator = new TrafficGenerator({ seed: Date.now() & 0xffff, rps: this.generator.rps, startTime: this.clock.now() });
    this.toggleScenario(''); // re-applies active scenarios to the fresh generator
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
    this.selectedTrace = null;
    this.topology.nodes.clear();
    this.topology.edges.clear();
    this.tracesSeen = 0;
    this.lastStructureVersion = -1;
    this.events.onStructureChange?.();
  }

  // ------------------------------------------------------------------ update
  /** Advances the simulation/replay to the clock's current time. Call once per frame. */
  update(): number {
    const now = this.clock.now();

    if (this.mode === 'live') {
      for (const t of this.generator.tick(now)) this.ingest(t);
    } else {
      while (this.replayCursor < this.replayTraces.length && this.replayTraces[this.replayCursor]!.start <= now) {
        this.ingest(this.replayTraces[this.replayCursor++]!);
      }
      if (this.replayLoop && this.replayCursor >= this.replayTraces.length && this.replayTraces.length > 0) {
        const range = this.replayRange!;
        if (now > range.end + 1500) this.seek(range.start - 500);
      }
    }

    // Drop particles that have landed.
    let w = 0;
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i]!;
      if (p.arriveAt >= now && p.departAt <= now + 60_000) this.particles[w++] = p;
    }
    this.particles.length = w;

    if (now - this.lastExpire > 5000) {
      this.lastExpire = now;
      this.rootLatency.prune(now);
      for (const n of this.topology.nodes.values()) n.latency.prune(now);
      for (const e of this.topology.edges.values()) e.latency.prune(now);
      if (this.mode === 'live') this.topology.expire(now, NODE_TTL_MS);
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
    this.rootLatency.add(trace.start, duration(trace.root));
    this.recentTraces.push(trace);
    if (this.recentTraces.length > RECENT_LIMIT) this.recentTraces.shift();
    for (const t of transfers) this.schedule(t);
    this.events.onTrace?.(trace);
  }

  private schedule(t: Transfer): void {
    const p50 = this.topology.edges.get(t.edgeId)?.latency.percentile(0.5) ?? NaN;
    const d = duration(t.span);
    const status: ParticleStatus = t.span.status === 'error' ? 'error' : Number.isFinite(p50) && d > p50 * SLOW_FACTOR && d > 20 ? 'slow' : 'ok';
    const edge = this.topology.edges.get(t.edgeId)!;
    this.particles.push({ edge, departAt: t.span.start, arriveAt: t.span.start + TRAVEL_MS, backward: false, status: 'ok', traceId: t.traceId, span: t.span });
    this.particles.push({ edge, departAt: t.span.end, arriveAt: t.span.end + TRAVEL_MS, backward: true, status, traceId: t.traceId, span: t.span });
  }

  // ------------------------------------------------------------------- stats
  kpis(now: number): Kpis {
    return {
      rps: this.traceCount.rate(now, 10),
      errorRate: this.traceCount.rate(now, 10) > 0 ? this.errorCount.rate(now, 10) / this.traceCount.rate(now, 10) : 0,
      p50: this.rootLatency.percentile(0.5),
      p95: this.rootLatency.percentile(0.95),
      inFlight: this.particles.length,
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
