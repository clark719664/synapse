/** The subset of `EventSource` the feed relies on, so tests can drive it with a fake. */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((ev: Event) => unknown) | null;
  onerror: ((ev: Event) => unknown) | null;
  onmessage: ((ev: MessageEvent) => unknown) | null;
  close(): void;
}

export type FeedState = 'connecting' | 'live' | 'stalled' | 'disconnected' | 'paused';

export interface FeedStatus {
  state: FeedState;
  /** When the current state began. */
  since: number;
  /** When the next reconnect attempt fires, while disconnected. */
  retryAt: number | null;
  received: number;
  lastEventAt: number | null;
  attempts: number;
}

export interface FeedOptions {
  connect?: (url: string) => EventSourceLike;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Open but silent for this long counts as stalled. */
  stallMs?: number;
  /** Stalled for this long forces a reconnect. */
  reconnectStalledMs?: number;
  backoffMs?: readonly number[];
}

const CLOSED = 2;

/**
 * Server-sent-events connection with honest states. The browser's own
 * EventSource retry is replaced by an explicit backoff so the UI can say
 * exactly when the next attempt happens.
 */
export class SseFeed {
  private es: EventSourceLike | null = null;
  private timer: unknown = null;
  private state: FeedState = 'disconnected';
  private since: number;
  private retryAt: number | null = null;
  private received = 0;
  private lastEventAt: number | null = null;
  private attempts = 0;
  private openedAt = 0;
  private readonly connect: (url: string) => EventSourceLike;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly stallMs: number;
  private readonly reconnectStalledMs: number;
  private readonly backoffMs: readonly number[];

  constructor(readonly url: string, private readonly onMessage: (data: string, receivedAt: number) => void, options: FeedOptions = {}) {
    this.connect = options.connect ?? ((u) => new EventSource(u));
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as number));
    this.stallMs = options.stallMs ?? 10_000;
    this.reconnectStalledMs = options.reconnectStalledMs ?? 30_000;
    this.backoffMs = options.backoffMs ?? [1000, 2000, 5000, 10_000, 30_000];
    this.since = this.now();
  }

  start(): void {
    this.cancelTimer();
    this.closeSource();
    this.set('connecting');
    this.attempts++;
    let es: EventSourceLike;
    try {
      es = this.connect(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.es = es;
    es.onopen = () => {
      if (this.es !== es) return;
      this.openedAt = this.now();
      this.attempts = 0;
      this.set('live');
    };
    es.onmessage = (ev) => {
      if (this.es !== es) return;
      const t = this.now();
      this.received++;
      this.lastEventAt = t;
      if (this.state !== 'live') { this.attempts = 0; this.set('live'); }
      this.onMessage(String(ev.data), t);
    };
    es.onerror = () => {
      if (this.es !== es) return;
      this.closeSource();
      this.scheduleRetry();
    };
  }

  /** Disconnects without retrying (e.g. while the tab is hidden). */
  pause(): void {
    this.cancelTimer();
    this.closeSource();
    this.set('paused');
  }

  stop(): void {
    this.cancelTimer();
    this.closeSource();
    this.set('disconnected');
    this.retryAt = null;
  }

  /** Current status; also notices a silent connection and recycles it. */
  status(): FeedStatus {
    const t = this.now();
    if ((this.state === 'live' || this.state === 'stalled') && this.es) {
      const quietSince = this.lastEventAt ?? this.openedAt;
      if (t - quietSince > this.stallMs && this.state === 'live') this.set('stalled', quietSince);
      if (this.state === 'stalled' && t - quietSince > this.reconnectStalledMs) this.start();
      if (this.es?.readyState === CLOSED) { this.closeSource(); this.scheduleRetry(); }
    }
    return { state: this.state, since: this.since, retryAt: this.retryAt, received: this.received, lastEventAt: this.lastEventAt, attempts: this.attempts };
  }

  private scheduleRetry(): void {
    const delay = this.backoffMs[Math.min(this.attempts - 1, this.backoffMs.length - 1)] ?? 1000;
    this.retryAt = this.now() + delay;
    this.set('disconnected');
    this.cancelTimer();
    this.timer = this.setTimer(() => { this.timer = null; this.start(); }, delay);
  }

  private set(state: FeedState, since = this.now()): void {
    if (state !== 'disconnected') this.retryAt = null;
    if (this.state === state) return;
    this.state = state;
    this.since = since;
  }

  private closeSource(): void {
    if (!this.es) return;
    this.es.onopen = this.es.onerror = this.es.onmessage = null;
    this.es.close();
    this.es = null;
  }

  private cancelTimer(): void {
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
  }
}
