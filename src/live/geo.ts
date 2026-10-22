import { isWikimediaHost, type EditorKind, type WikiChange } from './wikimedia';

export interface Coords {
  lat: number;
  lon: number;
}

/** A change whose page has coordinates. `at` is the playout time its arc leaves the wiki's node. */
export interface GeoEvent extends Coords {
  at: number;
  traceId: string;
  node: string;
  host: string;
  title: string;
  editor: EditorKind;
  flagged: boolean;
}

/**
 * Only pages that can carry a primary coordinate are worth asking about:
 * articles on Wikipedia and Wikivoyage, Wikidata items and Commons files.
 */
export function geoEligible(c: WikiChange): boolean {
  if (c.type !== 'edit' && c.type !== 'new') return false;
  if (/\.(wikipedia|wikivoyage)\.org$/.test(c.host)) return c.namespace === 0;
  if (c.host === 'www.wikidata.org') return c.namespace === 0;
  if (c.host === 'commons.wikimedia.org') return c.namespace === 6;
  return false;
}

type Json = Record<string, unknown>;

/**
 * Reads a `prop=coordinates` (formatversion=2) response into title → coords,
 * keyed by the titles as they were requested (undoing the API's normalisation).
 * Pages without an Earth coordinate map to null.
 */
export function parseCoordinates(body: unknown): Map<string, Coords | null> {
  const out = new Map<string, Coords | null>();
  const query = (body as Json | null)?.query as Json | undefined;
  if (!query) return out;
  const from = new Map<string, string>();
  for (const n of (query.normalized as Json[] | undefined) ?? []) {
    if (typeof n.from === 'string' && typeof n.to === 'string') from.set(n.to, n.from);
  }
  for (const p of (query.pages as Json[] | undefined) ?? []) {
    if (typeof p.title !== 'string') continue;
    const c = ((p.coordinates as Json[] | undefined) ?? []).find((x) => (x.globe ?? 'earth') === 'earth');
    const lat = Number(c?.lat);
    const lon = Number(c?.lon);
    const coords = c && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
    out.set(p.title, coords);
    const original = from.get(p.title);
    if (original) out.set(original, coords);
  }
  return out;
}

interface Pending {
  title: string;
  at: number;
  callbacks: ((c: Coords) => void)[];
}

export interface GeoLookupOptions {
  fetch?: (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  now?: () => number;
  /** At most one request per this many ms, one at a time. */
  minIntervalMs?: number;
  maxBatch?: number;
  /** Titles still waiting after this long are dropped; their moment has passed. */
  maxAgeMs?: number;
  cacheSize?: number;
}

const MAX_TITLE_CHARS = 5000;

/**
 * Looks up page coordinates through each wiki's public API, politely: requests
 * are serial, batched per wiki (up to 50 titles) and rate-limited, results are
 * cached, and the `maxlag` convention is honoured.
 */
export class GeoLookup {
  private readonly cache = new Map<string, Coords | null>();
  private readonly pending = new Map<string, Map<string, Pending>>();
  private inFlight = false;
  private nextAt = 0;
  private readonly fetchFn: NonNullable<GeoLookupOptions['fetch']>;
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  private readonly maxBatch: number;
  private readonly maxAgeMs: number;
  private readonly cacheSize: number;
  readonly stats = { requests: 0, asked: 0, located: 0, errors: 0, dropped: 0 };
  lastError: string | null = null;

  constructor(options: GeoLookupOptions = {}) {
    this.fetchFn = options.fetch ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? (() => Date.now());
    this.minIntervalMs = options.minIntervalMs ?? 1000;
    this.maxBatch = options.maxBatch ?? 50;
    this.maxAgeMs = options.maxAgeMs ?? 15_000;
    this.cacheSize = options.cacheSize ?? 5000;
  }

  /** Calls back with coordinates if the page has them; never calls back otherwise. */
  request(host: string, title: string, onFound: (c: Coords) => void): void {
    if (!isWikimediaHost(host)) return;
    const key = `${host}|${title}`;
    if (this.cache.has(key)) {
      const c = this.cache.get(key)!;
      if (c) onFound(c);
      return;
    }
    let queue = this.pending.get(host);
    if (!queue) this.pending.set(host, (queue = new Map()));
    const p = queue.get(title);
    if (p) p.callbacks.push(onFound);
    else queue.set(title, { title, at: this.now(), callbacks: [onFound] });
  }

  get queued(): number {
    let n = 0;
    for (const q of this.pending.values()) n += q.size;
    return n;
  }

  /** Starts the next batch if the rate limit allows. Call often; it is cheap when idle. */
  pump(): void {
    const t = this.now();
    for (const [host, q] of this.pending) {
      for (const [title, p] of q) if (t - p.at > this.maxAgeMs) { q.delete(title); this.stats.dropped++; }
      if (q.size === 0) this.pending.delete(host);
    }
    if (this.inFlight || t < this.nextAt || this.pending.size === 0) return;

    // Serve the wiki whose oldest title has waited longest.
    let host = '';
    let oldest = Infinity;
    for (const [h, q] of this.pending) {
      const first = q.values().next().value as Pending;
      if (first.at < oldest) { oldest = first.at; host = h; }
    }
    const q = this.pending.get(host)!;
    const batch: Pending[] = [];
    let chars = 0;
    for (const p of q.values()) {
      const len = encodeURIComponent(p.title).length + 3;
      if (batch.length >= this.maxBatch || (batch.length > 0 && chars + len > MAX_TITLE_CHARS)) break;
      batch.push(p);
      chars += len;
    }
    for (const p of batch) q.delete(p.title);
    if (q.size === 0) this.pending.delete(host);
    void this.send(host, batch);
  }

  private async send(host: string, batch: Pending[]): Promise<void> {
    this.inFlight = true;
    this.stats.requests++;
    this.stats.asked += batch.length;
    this.nextAt = this.now() + this.minIntervalMs;
    const url = `https://${host}/w/api.php?action=query&prop=coordinates&coprimary=primary&format=json&formatversion=2&origin=*&maxlag=5&titles=${encodeURIComponent(batch.map((p) => p.title).join('|'))}`;
    try {
      const res = await this.fetchFn(url, { headers: { 'Api-User-Agent': 'Synapse (https://github.com/clark719664/synapse)' } });
      const body = res.ok ? await res.json() : null;
      const err = (body as Json | null)?.error as Json | undefined;
      if (!res.ok || err) {
        this.fail(err?.code === 'maxlag' ? 'Wikimedia asked clients to slow down (maxlag)' : `HTTP ${res.status}`);
        return;
      }
      const found = parseCoordinates(body);
      this.lastError = null;
      for (const p of batch) {
        const c = found.get(p.title) ?? null;
        this.remember(`${host}|${p.title}`, c);
        if (c) {
          this.stats.located++;
          for (const cb of p.callbacks) cb(c);
        }
      }
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e));
    } finally {
      this.inFlight = false;
    }
  }

  private fail(message: string): void {
    this.stats.errors++;
    this.lastError = message;
    this.nextAt = this.now() + 10_000;
  }

  private remember(key: string, c: Coords | null): void {
    this.cache.set(key, c);
    if (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value as string);
  }
}

/** The most recent located changes, oldest first. */
export class GeoLayer {
  readonly events: GeoEvent[] = [];
  /** Located changes since the last clear, including ones that have scrolled out. */
  added = 0;
  constructor(readonly limit = 600) {}

  add(e: GeoEvent): void {
    this.added++;
    let i = this.events.length;
    while (i > 0 && this.events[i - 1]!.at > e.at) i--;
    this.events.splice(i, 0, e);
    if (this.events.length > this.limit) this.events.splice(0, this.events.length - this.limit);
  }

  clear(): void {
    this.events.length = 0;
    this.added = 0;
  }
}
