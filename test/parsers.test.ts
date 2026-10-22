import { describe, expect, it } from 'vitest';
import { detectFormat, nanosToMs, parseTraces } from '../src/model/parsers';
import { assembleTraces } from '../src/model/span';

const otlp = {
  resourceSpans: [
    {
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'gateway' } }] },
      scopeSpans: [
        {
          spans: [
            { traceId: 'aa', spanId: '01', name: 'GET /', kind: 2, startTimeUnixNano: '1700000000000000123', endTimeUnixNano: '1700000000050000000', status: { code: 1 }, attributes: [{ key: 'http.status_code', value: { intValue: '200' } }] },
            { traceId: 'aa', spanId: '02', parentSpanId: '01', name: 'call auth', kind: 'SPAN_KIND_CLIENT', startTimeUnixNano: '1700000000010000000', endTimeUnixNano: '1700000000020000000', status: { code: 'STATUS_CODE_ERROR' } },
            { traceId: 'aa', name: 'broken' },
          ],
        },
      ],
    },
    {
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'auth' } }] },
      scopeSpans: [{ spans: [{ traceId: 'aa', spanId: '03', parentSpanId: '02', name: 'verify', kind: 2, startTimeUnixNano: '1700000000011000000', endTimeUnixNano: '1700000000019000000' }] }],
    },
  ],
};

const jaeger = {
  data: [
    {
      traceID: 'bb',
      spans: [
        { traceID: 'bb', spanID: 'x1', operationName: 'root', startTime: 1700000000000000, duration: 40000, processID: 'p1', references: [], tags: [{ key: 'span.kind', type: 'string', value: 'server' }] },
        { traceID: 'bb', spanID: 'x2', operationName: 'child', startTime: 1700000000005000, duration: 3000, processID: 'p2', references: [{ refType: 'CHILD_OF', spanID: 'x1' }], tags: [{ key: 'error', type: 'bool', value: true }] },
      ],
      processes: { p1: { serviceName: 'web' }, p2: { serviceName: 'db' } },
    },
  ],
};

const zipkin = [
  { traceId: 'cc', id: 'z1', name: 'get', kind: 'SERVER', timestamp: 1700000000000000, duration: 12000, localEndpoint: { serviceName: 'api' } },
  { traceId: 'cc', id: 'z2', parentId: 'z1', name: 'query', kind: 'CLIENT', timestamp: 1700000000002000, duration: 5000, localEndpoint: { serviceName: 'api' }, tags: { error: 'timeout' } },
];

describe('detectFormat', () => {
  it('identifies the three formats and rejects others', () => {
    expect(detectFormat(otlp)).toBe('otlp');
    expect(detectFormat(jaeger)).toBe('jaeger');
    expect(detectFormat(zipkin)).toBe('zipkin');
    expect(detectFormat({ foo: 1 })).toBeNull();
    expect(detectFormat([{ nope: true }])).toBeNull();
    expect(detectFormat(42)).toBeNull();
  });
});

describe('nanosToMs', () => {
  it('keeps sub-millisecond precision beyond 2^53', () => {
    // A double at epoch-millisecond scale resolves ~0.24µs; we only need to beat 1µs.
    expect(Math.abs(nanosToMs('1700000000000000123') - (1700000000000 + 0.000123))).toBeLessThan(0.0005);
    expect(nanosToMs('5000')).toBeCloseTo(0.005);
    expect(nanosToMs(2_000_000)).toBe(2);
    expect(nanosToMs('abc')).toBeNaN();
  });
});

describe('parseTraces', () => {
  it('parses OTLP with services from resources, kinds, statuses and attributes', () => {
    const r = parseTraces(JSON.stringify(otlp));
    expect(r.format).toBe('otlp');
    expect(r.skipped).toBe(1);
    expect(r.spans).toHaveLength(3);
    const [root, client, server] = r.spans;
    expect(root!.service).toBe('gateway');
    expect(root!.kind).toBe('server');
    expect(root!.status).toBe('ok');
    expect(root!.parentSpanId).toBeNull();
    expect(root!.attributes['http.status_code']).toBe(200);
    expect(client!.kind).toBe('client');
    expect(client!.status).toBe('error');
    expect(server!.service).toBe('auth');
    expect(server!.parentSpanId).toBe('02');
    expect(server!.end - server!.start).toBeCloseTo(8);
  });

  it('parses Jaeger with process lookup, references and error tags', () => {
    const r = parseTraces(JSON.stringify(jaeger));
    expect(r.format).toBe('jaeger');
    expect(r.spans[0]!.service).toBe('web');
    expect(r.spans[0]!.kind).toBe('server');
    expect(r.spans[0]!.end - r.spans[0]!.start).toBeCloseTo(40);
    expect(r.spans[1]!.service).toBe('db');
    expect(r.spans[1]!.parentSpanId).toBe('x1');
    expect(r.spans[1]!.status).toBe('error');
  });

  it('parses Zipkin v2', () => {
    const r = parseTraces(JSON.stringify(zipkin));
    expect(r.format).toBe('zipkin');
    expect(r.spans[0]!.service).toBe('api');
    expect(r.spans[0]!.kind).toBe('server');
    expect(r.spans[1]!.parentSpanId).toBe('z1');
    expect(r.spans[1]!.status).toBe('error');
    expect(r.spans[1]!.end - r.spans[1]!.start).toBeCloseTo(5);
  });

  it('throws on unknown documents', () => {
    expect(() => parseTraces('{"hello":"world"}')).toThrow(/Unrecognised/);
  });
});

describe('assembleTraces', () => {
  it('groups spans, finds the root and summarises', () => {
    const spans = parseTraces(JSON.stringify(otlp)).spans;
    const traces = assembleTraces(spans);
    expect(traces).toHaveLength(1);
    const t = traces[0]!;
    expect(t.root.spanId).toBe('01');
    expect(t.services.sort()).toEqual(['auth', 'gateway']);
    expect(t.hasError).toBe(true);
    expect(t.end - t.start).toBeCloseTo(50, 3);
  });

  it('falls back to the earliest span when the root is missing', () => {
    const spans = parseTraces(JSON.stringify(zipkin)).spans.filter((s) => s.spanId === 'z2');
    const t = assembleTraces(spans)[0]!;
    expect(t.root.spanId).toBe('z2');
  });
});
