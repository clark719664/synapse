import { TRAVEL_MS, type Engine, type Vocabulary } from '../app/engine';
import { BurstDetector, type Burst } from './bursts';
import { SseFeed, type FeedOptions, type FeedStatus } from './feed';
import { GeoLayer, GeoLookup, geoEligible } from './geo';
import { changeToSpans, HostSlots, isDrawable, OTHER_WIKIS, parseRecentChange, RECENT_CHANGES_URL } from './wikimedia';

export const WIKI_VOCAB: Vocabulary = {
  rate: 'Changes / s', unit: '/s', errors: 'Reverts & blocks', latency: 'Lag', nodes: 'Wikis and editors', stream: 'Recent changes',
  request: 'change', slow: 'late delivery', error: 'flagged',
};

/** Events play out this far behind real time, enough to cover the measured delivery lag (p99 ≈ 1.6 s). */
export const PLAYOUT_MS = 2500;

/**
 * Wires Wikimedia's recent-changes stream into the engine: parses each event,
 * buckets its wiki into a node, queues the spans, and turns edit bursts into
 * alerts on the map.
 */
export class WikipediaSource {
  readonly feed: SseFeed;
  readonly slots = new HostSlots();
  readonly bursts = new BurstDetector();
  readonly geo = new GeoLookup();
  readonly located = new GeoLayer();
  /** Drawable changes seen, for the share that could be placed on the globe. */
  drawn = 0;
  /** Events that could not be parsed, and categorize side effects that are counted but not drawn. */
  malformed = 0;
  sideEffects = 0;
  private lastTick = 0;

  constructor(private readonly engine: Engine, private readonly onBurst: (b: Burst) => void = () => undefined, options: FeedOptions = {}) {
    this.feed = new SseFeed(RECENT_CHANGES_URL, (data, at) => this.onMessage(data, at), options);
  }

  start(): void {
    this.engine.goFeed(WIKI_VOCAB, PLAYOUT_MS);
    this.located.clear();
    this.drawn = 0;
    this.feed.start();
  }

  stop(): void {
    this.feed.stop();
  }

  pause(): void {
    this.feed.pause();
  }

  resume(): void {
    this.engine.resyncFeed();
    this.located.clear();
    this.feed.start();
  }

  status(): FeedStatus {
    return this.feed.status();
  }

  private onMessage(data: string, receivedAt: number): void {
    const change = parseRecentChange(data);
    if (!change) { this.malformed++; return; }
    if (!isDrawable(change)) { this.sideEffects++; return; }
    const node = this.slots.assign(change.host, receivedAt);
    const spans = changeToSpans(change, receivedAt, node);
    this.bursts.add(change.host, spans[0]!.start);
    this.engine.enqueue(spans);
    this.drawn++;
    if (geoEligible(change)) {
      const leaves = spans[0]!.start + TRAVEL_MS;
      const traceId = spans[0]!.traceId;
      this.geo.request(change.host, change.title, (c) => {
        if (this.engine.mode !== 'feed') return;
        this.located.add({
          ...c, at: Math.max(leaves, this.engine.clock.now()), traceId, node, host: change.host, title: change.title,
          editor: change.editor, flagged: change.revert || change.moderation,
        });
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

export const formatRatio = (r: number): string => `${r >= 10 ? r.toFixed(0) : r.toFixed(1)}×`;
