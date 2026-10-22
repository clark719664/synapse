import { assembleTraces, type Span, type Trace } from '../model/span';
import { gaussian, hexId, mulberry32 } from './rng';
import type { ServiceModifier } from './scenarios';
import { DEMO_ROUTES, INFRA_SERVICES, type CallTemplate, type Route } from './topology';

export interface GeneratorOptions {
  seed?: number;
  routes?: Route[];
  /** Baseline requests per second. */
  rps?: number;
  /** Clock value the first tick counts from. Defaults to 0; the app passes `Date.now()`. */
  startTime?: number;
}

/**
 * Produces complete, OpenTelemetry-shaped traces from call-tree templates with
 * Poisson arrivals. Timestamps are absolute (ms), so the same traces can be
 * released live or replayed.
 */
export class TrafficGenerator {
  private readonly rand: () => number;
  private readonly routes: Route[];
  private readonly totalWeight: number;
  rps: number;
  trafficMultiplier = 1;
  modifier: (service: string) => ServiceModifier = () => ({ latencyMultiplier: 1, extraErrorRate: 0 });
  private nextArrival: number;

  constructor(options: GeneratorOptions = {}) {
    this.rand = mulberry32(options.seed ?? 1337);
    this.routes = options.routes ?? DEMO_ROUTES;
    this.totalWeight = this.routes.reduce((s, r) => s + r.weight, 0);
    this.rps = options.rps ?? 12;
    this.nextArrival = options.startTime ?? 0;
  }

  /** Generates every trace that starts in (lastNow, now]. */
  tick(now: number): Trace[] {
    const rate = Math.max(1e-6, this.rps * this.trafficMultiplier) / 1000; // per ms
    const out: Trace[] = [];
    while (this.nextArrival <= now) {
      out.push(this.generate(this.pickRoute(), this.nextArrival));
      // Exponential inter-arrival times → Poisson process.
      this.nextArrival += -Math.log(1 - this.rand()) / rate;
    }
    return out;
  }

  pickRoute(): Route {
    let r = this.rand() * this.totalWeight;
    for (const route of this.routes) {
      r -= route.weight;
      if (r <= 0) return route;
    }
    return this.routes[this.routes.length - 1]!;
  }

  /** Instantiates a route's template into concrete spans starting at `start`. */
  generate(route: Route, start: number): Trace {
    const traceId = hexId(this.rand, 16);
    const spans: Span[] = [];
    this.instantiate(route.root, traceId, null, start, spans, route.name);
    return assembleTraces(spans)[0]!;
  }

  private latency(t: CallTemplate, mod: ServiceModifier): number {
    const sigma = t.jitter ?? 0.3;
    return t.base * mod.latencyMultiplier * Math.exp(sigma * gaussian(this.rand));
  }

  /** Returns the span's end time and whether it (or a child) failed. */
  private instantiate(t: CallTemplate, traceId: string, parentSpanId: string | null, start: number, out: Span[], routeName: string): { end: number; error: boolean } {
    const mod = this.modifier(t.service);
    const self = this.latency(t, mod);
    const spanId = hexId(this.rand, 8);
    // Own work is split: a slice before the children run, the rest after.
    const before = self * (0.2 + 0.4 * this.rand());
    let cursor = start + before;
    let childEnd = cursor;
    let error = this.rand() < 1 - (1 - (t.errorRate ?? 0)) * (1 - mod.extraErrorRate);

    const children = (t.children ?? []).filter((ch) => ch.prob === undefined || this.rand() < ch.prob);
    for (const ch of children) {
      const childStart = t.parallel ? start + before + this.rand() * 0.5 : cursor + this.rand() * 0.3;
      const res = this.instantiate(ch.call, traceId, spanId, childStart, out, routeName);
      // A failed dependency usually fails the caller. Data-store failures are more often
      // handled (fallbacks, cache misses served from origin) than failures of other services.
      const propagate = INFRA_SERVICES.has(ch.call.service) ? 0.35 : 0.8;
      if (res.error && this.rand() < propagate) error = true;
      if (t.parallel) childEnd = Math.max(childEnd, res.end);
      else { cursor = res.end; childEnd = cursor; }
    }
    const end = Math.max(childEnd, cursor) + (self - before);
    out.push({
      traceId,
      spanId,
      parentSpanId,
      service: t.service,
      name: t.name,
      kind: t.kind ?? 'internal',
      start,
      end,
      status: error ? 'error' : 'ok',
      attributes: parentSpanId === null ? { 'http.route': routeName } : {},
    });
    return { end, error };
  }
}
