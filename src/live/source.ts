import { TRAVEL_MS, type Engine, type Vocabulary } from '../app/engine';
import { BurstDetector, type Burst } from './bursts';
import { SseFeed, type FeedOptions, type FeedStatus } from './feed';
import { GeoLayer, GeoLookup, geoEligible } from './geo';
import { EDITOR_ORDER, parseSnapshot, RollingHistory, SNAPSHOT_URLS, type Snapshot } from './history';
import { changeToSpans, HostSlots, isDrawable, OTHER_WIKIS, parseRecentChange, RECENT_CHANGES_URL } from './wikimedia';

export const WIKI_VOCAB: Vocabulary = {
  rate: 'Changes / s', unit: '/s', errors: 'Reverts & blocks', latency: 'Lag', nodes: 'Wikis and editors', stream: 'Recent changes',
  request: 'change', slow: 'late delivery', error: 'flagged',
};

/** Changes are drawn the moment they reach the browser: no buffering, no catch-up animation. */
export const PLAYOUT_MS = 0;
/** How far before the resume point each (re)connection asks Wikimedia to start, so nothing at the seam is missed. */
const OVERLAP_MS = 15_000;

export type HistoryState = 'loading' | 'loaded' | 'unavailable';

/** One 1° cell of the globe: [lat, lon, edits, flagged]. */
export type Cell = [number, number, number, number];

const isoTime = (ms: number) => new Date(ms).toISOString();

export async function fetchSnapshot(fetchFn: typeof fetch = fetch, timeoutMs = 8000): Promise<Snapshot | null> {
  for (const url of SNAPSHOT_URLS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchFn(url, { signal: ctrl.signal, headers: { Accept: 'application/vnd.github.raw+json' }, cache: 'no-store' });
      if (!res.ok) continue;
      const snap = parseSnapshot(await res.json());
      if (snap) return snap;
    } catch {
      // try the next source
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/**
 * Wires Wikimedia's recent-changes stream into the engine. History comes from
 * the always-on collector's snapshot; the stream is then replayed from the
 * snapshot's boundary, so the counts are exact up to the current second, and
 * every reconnect resumes from the newest change already counted.
 */
export class WikipediaSource {
  readonly feed: SseFeed;
  readonly slots = new HostSlots();
  bursts = new BurstDetector();
  readonly geo = new GeoLookup({ minIntervalMs: 1000, maxAgeMs: 120_000 });
  /** Individual located changes (the collector's last ten minutes, then everything since). */
  readonly located = new GeoLayer(4000);
  /** Edits to geotagged pages per 1° cell over the history window. */
  readonly cells = new Map<number, Cell>();
  history = new RollingHistory(0);
  historyState: HistoryState = 'loading';
  snapshot: Snapshot | null = null;
  /** Drawable changes animated live, for the share that could be placed on the globe. */
  drawn = 0;
  malformed = 0;
  private lastTick = 0;
  private session = 0;
  /** While a connection is still replaying history, event time runs far ahead of the wall clock. */
  private catchingUp = true;
  private probe = { wall: 0, dt: 0 };

  constructor(private readonly engine: Engine, private readonly onBurst: (b: Burst) => void = () => undefined, options: FeedOptions = {}) {
    this.feed = new SseFeed(() => this.streamUrl(), (data, at, fresh) => this.onMessage(data, at, fresh), options);
  }

  private streamUrl(): string {
    const from = this.history.newest || (this.history.fromSnapshot ? this.history.boundary : 0);
    return from ? `${RECENT_CHANGES_URL}?since=${encodeURIComponent(isoTime(from - OVERLAP_MS))}` : RECENT_CHANGES_URL;
  }

  start(): void {
    const session = ++this.session;
    this.engine.goFeed(WIKI_VOCAB, PLAYOUT_MS);
    this.located.clear();
    this.cells.clear();
    this.drawn = 0;
    this.history = new RollingHistory(0);
    this.bursts = new BurstDetector();
    this.historyState = 'loading';
    this.snapshot = null;
    void fetchSnapshot().then((snap) => {
      if (session !== this.session) return;
      if (snap) this.load(snap);
      this.historyState = snap ? 'loaded' : 'unavailable';
      this.feed.start();
    });
  }

  private load(snap: Snapshot): void {
    this.snapshot = snap;
    this.history.load(snap);
    this.bursts.seed(snap.baselines, snap.bursts, snap.boundary);
    for (const [lat, lon, n, f] of snap.cells) this.cells.set(cellIndex(lat, lon), [lat, lon, n, f]);
    for (const [t, lat, lon, ed, fl, host, title] of snap.recentPins) {
      this.located.add({ at: t, lat, lon, traceId: '', node: host, host, title, editor: EDITOR_ORDER[ed] ?? 'registered', flagged: fl === 1 });
    }
  }

  stop(): void {
    this.session++;
    this.feed.stop();
  }

  pause(): void {
    this.feed.pause();
  }

  resume(): void {
    this.engine.resyncFeed();
    this.feed.start();
  }

  status(): FeedStatus {
    return this.feed.status();
  }

  private onMessage(data: string, receivedAt: number, fresh: boolean): void {
    const change = parseRecentChange(data);
    if (!change) { this.malformed++; return; }
    const dt = Number.isFinite(change.dt) ? change.dt : receivedAt;
    const prevNewest = this.history.newest;
    if (fresh) { this.catchingUp = true; this.probe = { wall: receivedAt, dt }; }
    if (this.catchingUp && receivedAt - this.probe.wall >= 1000) {
      // Replay runs at hundreds of times real speed; once event time keeps pace with the clock we are live.
      // Comparing rates rather than timestamps keeps this right even when this device's clock is off.
      if ((dt - this.probe.dt) / (receivedAt - this.probe.wall) < 3) this.catchingUp = false;
      this.probe = { wall: receivedAt, dt };
    }
    if (!this.history.record(change.id, dt, change.editor, change.revert || change.moderation, !isDrawable(change))) return;
    // Coverage: contiguous while replay can bridge the gap; a hole Wikimedia could not replay stays a hole.
    const startFrom = this.history.fromSnapshot ? this.history.boundary : dt;
    if (fresh && prevNewest && dt > prevNewest + OVERLAP_MS * 2) this.history.cover(dt, dt);
    else this.history.cover(prevNewest || startFrom, this.history.newest);
    if (!isDrawable(change)) return;

    this.bursts.add(change.host, dt);
    const backlog = this.catchingUp;
    const node = this.slots.assign(change.host, receivedAt);
    let leaves = dt;
    let traceId = '';
    if (!backlog) {
      const spans = changeToSpans(change, receivedAt, node);
      this.engine.enqueue(spans);
      this.drawn++;
      leaves = spans[0]!.start + TRAVEL_MS;
      traceId = spans[0]!.traceId;
    }
    if (geoEligible(change)) {
      const session = this.session;
      this.geo.request(change.host, change.title, (c) => {
        if (session !== this.session || this.engine.mode !== 'feed') return;
        const flagged = change.revert || change.moderation;
        this.located.add({
          ...c, at: backlog ? dt : Math.max(leaves, this.engine.clock.now()), traceId, node, host: change.host, title: change.title,
          editor: change.editor, flagged,
        });
        const key = cellIndex(c.lat, c.lon);
        const cell = this.cells.get(key) ?? [Math.floor(c.lat) + 0.5, Math.floor(c.lon) + 0.5, 0, 0];
        cell[2]++;
        if (flagged) cell[3]++;
        this.cells.set(key, cell);
      });
    }
  }

  /** Re-evaluates bursts and mirrors them onto the map. Call a few times a second. */
  tick(now: number): void {
    this.geo.pump();
    if (now - this.lastTick < 1000) return;
    this.lastTick = now;
    const { started } = this.bursts.tick(now);
    for (const b of started) this.onBurst(b);
    this.engine.alerts.clear();
    for (const b of this.bursts.active()) {
      const node = this.slots.slots.has(b.key) ? b.key : OTHER_WIKIS;
      if (this.engine.alerts.has(node)) continue;
      this.engine.alerts.set(node, {
        node,
        since: b.since,
        label: `Burst ${formatRatio(b.rate / b.baseline)}`,
        detail: `${b.key}: ${b.rate.toFixed(1)} changes/s, usually ${b.baseline.toFixed(1)}`,
      });
    }
  }
}

export const cellIndex = (lat: number, lon: number): number => (Math.floor(lat) + 90) * 360 + (Math.floor(lon) + 180);

export const formatRatio = (r: number): string => `${r >= 10 ? r.toFixed(0) : r.toFixed(1)}×`;
