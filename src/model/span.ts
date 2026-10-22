/**
 * Normalised span model. Every ingest path (OTLP, Jaeger, Zipkin, the
 * built-in simulator) is converted to this shape so the rest of the app has
 * exactly one vocabulary.
 */
export type SpanKind = 'server' | 'client' | 'internal' | 'producer' | 'consumer';
export type SpanStatus = 'ok' | 'error' | 'unset';
export type AttributeValue = string | number | boolean;

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  service: string;
  name: string;
  kind: SpanKind;
  /** Milliseconds since the Unix epoch, fractional for sub-millisecond precision. */
  start: number;
  end: number;
  status: SpanStatus;
  attributes: Record<string, AttributeValue>;
}

export interface Trace {
  traceId: string;
  spans: Span[];
  /** The span without a parent (or the earliest span when the root is missing). */
  root: Span;
  start: number;
  end: number;
  services: string[];
  hasError: boolean;
}

export const duration = (s: { start: number; end: number }): number => s.end - s.start;

/** Groups spans by trace id and derives per-trace summary fields. Spans are sorted by start time. */
export function assembleTraces(spans: readonly Span[]): Trace[] {
  const byTrace = new Map<string, Span[]>();
  for (const s of spans) {
    let list = byTrace.get(s.traceId);
    if (!list) byTrace.set(s.traceId, (list = []));
    list.push(s);
  }
  const traces: Trace[] = [];
  for (const [traceId, list] of byTrace) {
    list.sort((a, b) => a.start - b.start);
    const ids = new Set(list.map((s) => s.spanId));
    const root = list.find((s) => s.parentSpanId === null || !ids.has(s.parentSpanId)) ?? list[0]!;
    traces.push({
      traceId,
      spans: list,
      root,
      start: list[0]!.start,
      end: Math.max(...list.map((s) => s.end)),
      services: [...new Set(list.map((s) => s.service))],
      hasError: list.some((s) => s.status === 'error'),
    });
  }
  traces.sort((a, b) => a.start - b.start);
  return traces;
}

/** Children lookup used by the waterfall and the topology builder. */
export function childrenIndex(trace: Trace): Map<string | null, Span[]> {
  const idx = new Map<string | null, Span[]>();
  for (const s of trace.spans) {
    const key = s.parentSpanId;
    let list = idx.get(key);
    if (!list) idx.set(key, (list = []));
    list.push(s);
  }
  return idx;
}
