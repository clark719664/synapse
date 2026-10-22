import { describe, expect, it } from 'vitest';
import { GlobeView } from '../src/geo/globe';
import { LAND_H, LAND_W, landMask } from '../src/geo/land';
import { GeoLayer, GeoLookup, geoEligible, parseCoordinates, type GeoEvent } from '../src/live/geo';
import { parseRecentChange, type WikiChange } from '../src/live/wikimedia';

const change = (host: string, namespace: number, type = 'edit'): WikiChange => parseRecentChange(JSON.stringify({
  meta: { id: 'x', dt: '2026-10-22T00:00:00Z' }, server_name: host, type, namespace, title: 'T', user: 'U',
}))!;

describe('geoEligible', () => {
  it('asks only about pages that can carry coordinates', () => {
    expect(geoEligible(change('en.wikipedia.org', 0))).toBe(true);
    expect(geoEligible(change('de.wikivoyage.org', 0))).toBe(true);
    expect(geoEligible(change('www.wikidata.org', 0))).toBe(true);
    expect(geoEligible(change('commons.wikimedia.org', 6))).toBe(true);
    expect(geoEligible(change('en.wikipedia.org', 1))).toBe(false);
    expect(geoEligible(change('commons.wikimedia.org', 14))).toBe(false);
    expect(geoEligible(change('zh.wikisource.org', 0))).toBe(false);
    expect(geoEligible(change('en.wikipedia.org', 0, 'log'))).toBe(false);
  });
});

describe('parseCoordinates', () => {
  it('maps requested titles to their primary Earth coordinate, undoing normalisation', () => {
    const got = parseCoordinates({
      query: {
        normalized: [{ from: 'Eiffel_Tower', to: 'Eiffel Tower' }],
        pages: [
          { title: 'Eiffel Tower', coordinates: [{ lat: 48.858, lon: 2.2945, primary: true, globe: 'earth' }] },
          { title: 'Ada Lovelace' },
          { title: 'Olympus Mons', coordinates: [{ lat: 18.65, lon: -133.8, globe: 'mars' }] },
          { title: 'Broken', coordinates: [{ lat: 200, lon: 0, globe: 'earth' }] },
          { title: 'Missing', missing: true },
        ],
      },
    });
    expect(got.get('Eiffel_Tower')).toEqual({ lat: 48.858, lon: 2.2945 });
    expect(got.get('Eiffel Tower')).toEqual({ lat: 48.858, lon: 2.2945 });
    expect(got.get('Ada Lovelace')).toBeNull();
    expect(got.get('Olympus Mons')).toBeNull();
    expect(got.get('Broken')).toBeNull();
    expect(got.get('Missing')).toBeNull();
  });

  it('survives bodies that are not query results', () => {
    expect(parseCoordinates(null).size).toBe(0);
    expect(parseCoordinates({ error: { code: 'maxlag' } }).size).toBe(0);
  });
});

function harness(respond: (url: string) => unknown) {
  let now = 0;
  const urls: string[] = [];
  const resolvers: (() => void)[] = [];
  const lookup = new GeoLookup({
    now: () => now,
    minIntervalMs: 1000,
    maxAgeMs: 15_000,
    fetch: (url) => {
      urls.push(url);
      return new Promise((resolve) => resolvers.push(() => resolve({ ok: true, status: 200, json: async () => respond(url) })));
    },
  });
  const settle = async () => {
    while (resolvers.length) resolvers.shift()!();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { lookup, urls, settle, advance: (ms: number) => { now += ms; } };
}

const titlesOf = (url: string) => new URL(url).searchParams.get('titles')!.split('|');

describe('GeoLookup', () => {
  it('batches titles per wiki, one request at a time, at most once a second', async () => {
    const h = harness((url) => ({ query: { pages: titlesOf(url).map((t) => ({ title: t, coordinates: t === 'Kyoto' ? [{ lat: 35, lon: 135.7 }] : undefined })) } }));
    const found: string[] = [];
    h.lookup.request('en.wikipedia.org', 'Kyoto', () => found.push('Kyoto'));
    h.lookup.request('en.wikipedia.org', 'Ada Lovelace', () => found.push('Ada'));
    h.lookup.request('www.wikidata.org', 'Q90', () => found.push('Q90'));
    h.lookup.pump();
    h.lookup.pump();
    expect(h.urls).toHaveLength(1);
    expect(new URL(h.urls[0]!).host).toBe('en.wikipedia.org');
    expect(titlesOf(h.urls[0]!)).toEqual(['Kyoto', 'Ada Lovelace']);
    expect(h.urls[0]).toContain('origin=*');
    expect(h.urls[0]).toContain('maxlag=5');
    await h.settle();
    expect(found).toEqual(['Kyoto']);
    h.lookup.pump();
    expect(h.urls).toHaveLength(1);
    h.advance(1000);
    h.lookup.pump();
    expect(h.urls).toHaveLength(2);
    expect(new URL(h.urls[1]!).host).toBe('www.wikidata.org');
  });

  it('answers repeat questions from its cache without another request', async () => {
    const h = harness(() => ({ query: { pages: [{ title: 'Kyoto', coordinates: [{ lat: 35, lon: 135.7 }] }] } }));
    h.lookup.request('en.wikipedia.org', 'Kyoto', () => undefined);
    h.lookup.pump();
    await h.settle();
    let hit: unknown = null;
    h.lookup.request('en.wikipedia.org', 'Kyoto', (c) => (hit = c));
    expect(hit).toEqual({ lat: 35, lon: 135.7 });
    h.advance(5000);
    h.lookup.pump();
    expect(h.urls).toHaveLength(1);
  });

  it('never contacts a host outside Wikimedia', () => {
    const h = harness(() => ({}));
    h.lookup.request('evil.example', 'Kyoto', () => undefined);
    h.lookup.request('en.wikipedia.org.evil.example', 'Kyoto', () => undefined);
    h.lookup.pump();
    expect(h.urls).toHaveLength(0);
    expect(h.lookup.queued).toBe(0);
  });

  it('drops titles that waited too long', () => {
    const h = harness(() => ({}));
    h.lookup.request('en.wikipedia.org', 'Old', () => undefined);
    h.advance(16_000);
    h.lookup.pump();
    expect(h.urls).toHaveLength(0);
    expect(h.lookup.stats.dropped).toBe(1);
  });

  it('backs off for ten seconds when Wikimedia says maxlag', async () => {
    const h = harness(() => ({ error: { code: 'maxlag', info: 'Waiting for a database server' } }));
    h.lookup.request('en.wikipedia.org', 'A', () => undefined);
    h.lookup.pump();
    await h.settle();
    expect(h.lookup.lastError).toMatch(/maxlag/);
    h.lookup.request('en.wikipedia.org', 'B', () => undefined);
    h.advance(5000);
    h.lookup.pump();
    expect(h.urls).toHaveLength(1);
    h.advance(5000);
    h.lookup.pump();
    expect(h.urls).toHaveLength(2);
  });
});

describe('GeoLayer', () => {
  it('keeps events in time order and counts every one it saw', () => {
    const layer = new GeoLayer(2);
    const ev = (at: number) => ({ at, lat: 0, lon: 0 }) as GeoEvent;
    layer.add(ev(30));
    layer.add(ev(10));
    layer.add(ev(20));
    expect(layer.events.map((e) => e.at)).toEqual([20, 30]);
    expect(layer.added).toBe(3);
  });
});

describe('GlobeView', () => {
  const g = Object.assign(new GlobeView(), { cx: 500, cy: 300, r: 100, lon0: 10, lat0: 30 });

  it('puts the facing point at the centre and points 90° away on the rim', () => {
    const [x, y, z] = g.project(30, 10);
    expect(x).toBeCloseTo(500);
    expect(y).toBeCloseTo(300);
    expect(z).toBeCloseTo(1);
    const east = g.project(0, 100);
    expect(Math.hypot(east[0] - 500, east[1] - 300)).toBeCloseTo(100, 0);
    expect(east[2]).toBeCloseTo(0);
  });

  it('puts north up and hides the far side', () => {
    expect(g.project(60, 10)[1]).toBeLessThan(300);
    expect(g.project(-30, -170)[2]).toBeLessThan(0);
  });

  it('only auto-rotates when allowed and not just after a drag', () => {
    const v = new GlobeView();
    const lon = v.lon0;
    v.advance(1000, 0, false);
    expect(v.lon0).toBe(lon);
    v.drag(10, 0, 0);
    const dragged = v.lon0;
    v.advance(1000, 1000, true);
    expect(v.lon0).toBe(dragged);
    v.advance(1000, 10_000, true);
    expect(v.lon0).not.toBe(dragged);
  });
});

describe('land mask', () => {
  it('decodes to a full equirectangular grid with land where land is', () => {
    const m = landMask();
    expect(m.length).toBe(LAND_W * LAND_H);
    const at = (lat: number, lon: number) => m[Math.floor(((90 - lat) / 180) * LAND_H) * LAND_W + Math.floor(((lon + 180) / 360) * LAND_W)];
    expect(at(48.86, 2.29)).toBe(255);
    expect(at(-23.5, 133.9)).toBe(255);
    expect(at(0, -140)).toBe(0);
    expect(at(30, -40)).toBe(0);
    const share = m.reduce((n, v) => n + (v ? 1 : 0), 0) / m.length;
    expect(share).toBeGreaterThan(0.25);
    expect(share).toBeLessThan(0.4);
  });
});
