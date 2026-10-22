import { LatencyWindow, RateCounter } from './stats';
import { duration, type Span, type Trace } from './span';

export interface ServiceNode {
  id: string;
  /** Hops from an entry point (a service that receives traces with no parent). */
  depth: number;
  entry: boolean;
  requests: RateCounter;
  errors: RateCounter;
  latency: LatencyWindow;
  lastSeen: number;
}

export interface ServiceEdge {
  id: string;
  source: string;
  target: string;
  requests: RateCounter;
  errors: RateCounter;
  latency: LatencyWindow;
  lastSeen: number;
}

/** A single inter-service call extracted from a trace; this is what becomes a particle. */
export interface Transfer {
  edgeId: string;
  source: string;
  target: string;
  span: Span;
  traceId: string;
}

/**
 * Service graph derived incrementally from spans. Nodes are services; an edge
 * exists wherever a span's parent lives in a different service.
 */
export class Topology {
  readonly nodes = new Map<string, ServiceNode>();
  readonly edges = new Map<string, ServiceEdge>();
  private version = 0;

  /** Increments whenever a node or edge is added, so layouts know when to re-seed. */
  get structureVersion(): number {
    return this.version;
  }

  static edgeId(source: string, target: string): string {
    return `${source}→${target}`;
  }

  node(id: string, now: number): ServiceNode {
    let n = this.nodes.get(id);
    if (!n) {
      n = { id, depth: 0, entry: false, requests: new RateCounter(), errors: new RateCounter(), latency: new LatencyWindow(), lastSeen: now };
      this.nodes.set(id, n);
      this.version++;
    }
    n.lastSeen = now;
    return n;
  }

  edge(source: string, target: string, now: number): ServiceEdge {
    const id = Topology.edgeId(source, target);
    let e = this.edges.get(id);
    if (!e) {
      e = { id, source, target, requests: new RateCounter(), errors: new RateCounter(), latency: new LatencyWindow(), lastSeen: now };
      this.edges.set(id, e);
      this.version++;
      this.recomputeDepths();
    }
    e.lastSeen = now;
    return e;
  }

  /**
   * Ingests a complete trace: updates node/edge statistics and returns the
   * inter-service transfers it contains, in start order.
   */
  ingest(trace: Trace): Transfer[] {
    const byId = new Map(trace.spans.map((s) => [s.spanId, s]));
    const transfers: Transfer[] = [];
    for (const span of trace.spans) {
      const node = this.node(span.service, span.start);
      // Only count a service's "own" requests once per hop: server/consumer spans,
      // or any span whose parent is in another service (or missing).
      const parent = span.parentSpanId ? byId.get(span.parentSpanId) : undefined;
      const crossesService = !parent || parent.service !== span.service;
      if (!parent) {
        node.entry = true;
        this.recomputeDepths();
      }
      if (crossesService || span.kind === 'server' || span.kind === 'consumer') {
        node.requests.add(span.start);
        if (span.status === 'error') node.errors.add(span.start);
        node.latency.add(span.start, duration(span));
      }
      if (parent && crossesService) {
        const edge = this.edge(parent.service, span.service, span.start);
        edge.requests.add(span.start);
        if (span.status === 'error') edge.errors.add(span.start);
        edge.latency.add(span.start, duration(span));
        transfers.push({ edgeId: edge.id, source: parent.service, target: span.service, span, traceId: trace.traceId });
      }
    }
    transfers.sort((a, b) => a.span.start - b.span.start);
    return transfers;
  }

  /** Drops nodes and edges that have not been seen for `ttlMs`. Returns true if anything changed. */
  expire(now: number, ttlMs: number): boolean {
    let changed = false;
    for (const [id, e] of this.edges) {
      if (now - e.lastSeen > ttlMs) { this.edges.delete(id); changed = true; }
    }
    for (const [id, n] of this.nodes) {
      if (now - n.lastSeen > ttlMs) { this.nodes.delete(id); changed = true; }
    }
    if (changed) { this.version++; this.recomputeDepths(); }
    return changed;
  }

  /** Longest-path depth from any entry node (BFS over DAG; cycles are cut at first visit). */
  private recomputeDepths(): void {
    const out = new Map<string, string[]>();
    for (const e of this.edges.values()) {
      let list = out.get(e.source);
      if (!list) out.set(e.source, (list = []));
      list.push(e.target);
    }
    const incoming = new Set([...this.edges.values()].map((e) => e.target));
    for (const n of this.nodes.values()) n.depth = 0;
    const roots = [...this.nodes.values()].filter((n) => n.entry || !incoming.has(n.id));
    const queue: [string, number][] = roots.map((n) => [n.id, 0]);
    const visited = new Map<string, number>();
    while (queue.length) {
      const [id, d] = queue.shift()!;
      const prev = visited.get(id);
      if (prev !== undefined && prev >= d) continue;
      if (d > this.nodes.size) continue;
      visited.set(id, d);
      const n = this.nodes.get(id);
      if (n) n.depth = d;
      for (const next of out.get(id) ?? []) queue.push([next, d + 1]);
    }
  }
}
