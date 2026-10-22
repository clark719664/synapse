import type { AttributeValue, Span, SpanKind, SpanStatus } from './span';

/**
 * Parsers for the three JSON trace formats people actually have lying around:
 *
 * - OTLP/JSON   (`{ resourceSpans: [...] }`), as emitted by the OpenTelemetry
 *                collector's file exporter or `curl`'d from an OTLP/HTTP endpoint
 * - Jaeger UI    (`{ data: [{ spans, processes }] }`), the "Download JSON" button
 * - Zipkin v2    (`[{ traceId, id, ... }]`)
 *
 * Each parser is total: malformed records are skipped rather than aborting
 * the import, and the caller gets a count of what was dropped.
 */
export type TraceFormat = 'otlp' | 'jaeger' | 'zipkin';

export interface ParseResult {
  format: TraceFormat;
  spans: Span[];
  skipped: number;
}

type Json = unknown;
const isObj = (v: Json): v is Record<string, Json> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: Json, fallback = ''): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback);
const num = (v: Json, fallback = 0): number => (typeof v === 'number' ? v : typeof v === 'string' && v !== '' && !Number.isNaN(+v) ? +v : fallback);

export function detectFormat(doc: Json): TraceFormat | null {
  if (Array.isArray(doc)) return doc.length === 0 || (isObj(doc[0]) && 'traceId' in doc[0] && 'id' in doc[0]) ? 'zipkin' : null;
  if (!isObj(doc)) return null;
  if (Array.isArray(doc.resourceSpans)) return 'otlp';
  if (Array.isArray(doc.data)) return 'jaeger';
  return null;
}

export function parseTraces(text: string): ParseResult {
  const doc: Json = JSON.parse(text);
  const format = detectFormat(doc);
  if (!format) throw new Error('Unrecognised trace format: expected OTLP/JSON, Jaeger or Zipkin v2.');
  switch (format) {
    case 'otlp':
      return parseOtlp(doc);
    case 'jaeger':
      return parseJaeger(doc);
    case 'zipkin':
      return parseZipkin(doc);
  }
}

// ---------------------------------------------------------------------------
// OTLP / JSON
// ---------------------------------------------------------------------------
function otlpAttrValue(v: Json): AttributeValue | undefined {
  if (!isObj(v)) return undefined;
  if (typeof v.stringValue === 'string') return v.stringValue;
  if (typeof v.boolValue === 'boolean') return v.boolValue;
  if (v.intValue !== undefined) return num(v.intValue);
  if (v.doubleValue !== undefined) return num(v.doubleValue);
  if (Array.isArray(v.arrayValue)) return JSON.stringify(v.arrayValue);
  return undefined;
}

function otlpAttributes(list: Json): Record<string, AttributeValue> {
  const out: Record<string, AttributeValue> = {};
  if (!Array.isArray(list)) return out;
  for (const kv of list) {
    if (!isObj(kv) || typeof kv.key !== 'string') continue;
    const v = otlpAttrValue(kv.value);
    if (v !== undefined) out[kv.key] = v;
  }
  return out;
}

const OTLP_KINDS: Record<string, SpanKind> = {
  '1': 'internal', '2': 'server', '3': 'client', '4': 'producer', '5': 'consumer',
  SPAN_KIND_INTERNAL: 'internal', SPAN_KIND_SERVER: 'server', SPAN_KIND_CLIENT: 'client',
  SPAN_KIND_PRODUCER: 'producer', SPAN_KIND_CONSUMER: 'consumer',
};

function otlpStatus(v: Json): SpanStatus {
  if (!isObj(v)) return 'unset';
  const code = v.code;
  if (code === 2 || code === '2' || code === 'STATUS_CODE_ERROR') return 'error';
  if (code === 1 || code === '1' || code === 'STATUS_CODE_OK') return 'ok';
  return 'unset';
}

/** Nanosecond strings exceed 2^53; split them textually to keep sub-ms precision. */
export function nanosToMs(v: Json): number {
  if (typeof v === 'number') return v / 1e6;
  if (typeof v !== 'string' || !/^\d+$/.test(v)) return NaN;
  const whole = v.length > 6 ? v.slice(0, -6) : '0';
  const frac = v.slice(-6).padStart(6, '0');
  return Number(whole) + Number(frac) / 1e6;
}

export function parseOtlp(doc: Json): ParseResult {
  const spans: Span[] = [];
  let skipped = 0;
  const resourceSpans = isObj(doc) && Array.isArray(doc.resourceSpans) ? doc.resourceSpans : [];
  for (const rs of resourceSpans) {
    if (!isObj(rs)) continue;
    const resource = isObj(rs.resource) ? otlpAttributes(rs.resource.attributes) : {};
    const service = str(resource['service.name'], 'unknown');
    const scopes = Array.isArray(rs.scopeSpans) ? rs.scopeSpans : Array.isArray(rs.instrumentationLibrarySpans) ? rs.instrumentationLibrarySpans : [];
    for (const ss of scopes) {
      if (!isObj(ss) || !Array.isArray(ss.spans)) continue;
      for (const s of ss.spans) {
        if (!isObj(s)) { skipped++; continue; }
        const start = nanosToMs(s.startTimeUnixNano);
        const end = nanosToMs(s.endTimeUnixNano);
        const traceId = str(s.traceId);
        const spanId = str(s.spanId);
        if (!traceId || !spanId || !Number.isFinite(start) || !Number.isFinite(end)) { skipped++; continue; }
        const parent = str(s.parentSpanId);
        spans.push({
          traceId,
          spanId,
          parentSpanId: parent === '' ? null : parent,
          service,
          name: str(s.name, '(unnamed)'),
          kind: OTLP_KINDS[str(s.kind)] ?? 'internal',
          start,
          end: Math.max(start, end),
          status: otlpStatus(s.status),
          attributes: otlpAttributes(s.attributes),
        });
      }
    }
  }
  return { format: 'otlp', spans, skipped };
}

// ---------------------------------------------------------------------------
// Jaeger UI JSON
// ---------------------------------------------------------------------------
export function parseJaeger(doc: Json): ParseResult {
  const spans: Span[] = [];
  let skipped = 0;
  const data = isObj(doc) && Array.isArray(doc.data) ? doc.data : [];
  for (const trace of data) {
    if (!isObj(trace) || !Array.isArray(trace.spans)) continue;
    const processes = isObj(trace.processes) ? trace.processes : {};
    for (const s of trace.spans) {
      if (!isObj(s)) { skipped++; continue; }
      const traceId = str(s.traceID);
      const spanId = str(s.spanID);
      const start = num(s.startTime, NaN) / 1000;
      const dur = num(s.duration, 0) / 1000;
      if (!traceId || !spanId || !Number.isFinite(start)) { skipped++; continue; }
      const proc = processes[str(s.processID)];
      const service = isObj(proc) ? str(proc.serviceName, 'unknown') : 'unknown';
      let parentSpanId: string | null = null;
      if (Array.isArray(s.references)) {
        const ref = s.references.find((r) => isObj(r) && r.refType === 'CHILD_OF') ?? s.references[0];
        if (isObj(ref)) parentSpanId = str(ref.spanID) || null;
      }
      const attributes: Record<string, AttributeValue> = {};
      if (Array.isArray(s.tags)) {
        for (const t of s.tags) {
          if (isObj(t) && typeof t.key === 'string' && (typeof t.value === 'string' || typeof t.value === 'number' || typeof t.value === 'boolean')) {
            attributes[t.key] = t.value;
          }
        }
      }
      const kindTag = str(attributes['span.kind']).toLowerCase();
      const kind: SpanKind = (['server', 'client', 'producer', 'consumer'] as const).find((k) => k === kindTag) ?? 'internal';
      const status: SpanStatus = attributes['error'] === true || attributes['otel.status_code'] === 'ERROR' ? 'error'
        : attributes['otel.status_code'] === 'OK' ? 'ok' : 'unset';
      spans.push({ traceId, spanId, parentSpanId, service, name: str(s.operationName, '(unnamed)'), kind, start, end: start + dur, status, attributes });
    }
  }
  return { format: 'jaeger', spans, skipped };
}

// ---------------------------------------------------------------------------
// Zipkin v2
// ---------------------------------------------------------------------------
export function parseZipkin(doc: Json): ParseResult {
  const spans: Span[] = [];
  let skipped = 0;
  if (!Array.isArray(doc)) return { format: 'zipkin', spans, skipped };
  for (const s of doc) {
    if (!isObj(s)) { skipped++; continue; }
    const traceId = str(s.traceId);
    const spanId = str(s.id);
    const start = num(s.timestamp, NaN) / 1000;
    if (!traceId || !spanId || !Number.isFinite(start)) { skipped++; continue; }
    const ep = isObj(s.localEndpoint) ? s.localEndpoint : {};
    const tags = isObj(s.tags) ? s.tags : {};
    const attributes: Record<string, AttributeValue> = {};
    for (const [k, v] of Object.entries(tags)) if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') attributes[k] = v;
    const kindRaw = str(s.kind).toLowerCase();
    const kind: SpanKind = (['server', 'client', 'producer', 'consumer'] as const).find((k) => k === kindRaw) ?? 'internal';
    spans.push({
      traceId,
      spanId,
      parentSpanId: str(s.parentId) || null,
      service: str(ep.serviceName, 'unknown'),
      name: str(s.name, '(unnamed)'),
      kind,
      start,
      end: start + num(s.duration, 0) / 1000,
      status: 'error' in tags ? 'error' : 'unset',
      attributes,
    });
  }
  return { format: 'zipkin', spans, skipped };
}
