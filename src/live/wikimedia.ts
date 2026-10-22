import type { AttributeValue, Span } from '../model/span';

/**
 * Wikimedia's public EventStreams service: every edit, page creation and log
 * action on every Wikimedia wiki, as server-sent events. Keyless and
 * CORS-enabled, so a static page can read it directly.
 */
export const RECENT_CHANGES_URL = 'https://stream.wikimedia.org/v2/stream/recentchange';

export type EditorKind = 'registered' | 'anonymous' | 'bots';
export const EDITOR_NODES: readonly EditorKind[] = ['registered', 'anonymous', 'bots'];
export const STREAM_NODE = 'EventStreams';
export const OTHER_WIKIS = 'other wikis';

export interface WikiChange {
  id: string;
  /** Event time from `meta.dt`, ms since the epoch on Wikimedia's clock. */
  dt: number;
  host: string;
  type: string;
  title: string;
  titleUrl: string | null;
  diffUrl: string | null;
  user: string;
  editor: EditorKind;
  namespace: number;
  comment: string;
  bytesDelta: number | null;
  minor: boolean;
  logType: string | null;
  logAction: string | null;
  revert: boolean;
  moderation: boolean;
}

type Json = Record<string, unknown>;

const WIKIMEDIA_HOST = /(^|\.)(wikipedia|wikimedia|wikidata|wiktionary|wikisource|wikiquote|wikibooks|wikinews|wikivoyage|wikiversity|wikifunctions|mediawiki)\.org$/;

export const isWikimediaHost = (host: string): boolean => WIKIMEDIA_HOST.test(host);

/** Only https links on Wikimedia's own domains are ever turned into anchors. */
export function safeWikiUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && isWikimediaHost(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6 = /^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7}$/i;

/** Bots carry the bot flag; IP addresses and `~`-prefixed temporary accounts are logged-out editors. */
export function classifyEditor(user: string, bot: boolean): EditorKind {
  if (bot) return 'bots';
  if (user.startsWith('~') || IPV4.test(user) || IPV6.test(user)) return 'anonymous';
  return 'registered';
}

// MediaWiki's default undo/rollback summaries in the busiest languages, plus the common "rv" shorthand.
const REVERT = /\b(revert(ed|ing)?|undid|undo|rollback|rv|rvv)\b|rückgängig|annulation|révocation|revertid[ao]s?|откат|отмена правки|取り消し|回退|撤销/i;

export function isRevert(comment: string): boolean {
  return REVERT.test(comment);
}

const MODERATION_LOGS = new Set(['block', 'delete', 'abusefilter', 'protect', 'suppress']);

/** Parses one EventStreams `message` payload. Returns null for anything that is not a usable change. */
export function parseRecentChange(data: string): WikiChange | null {
  let d: Json;
  try {
    d = JSON.parse(data) as Json;
  } catch {
    return null;
  }
  if (!d || typeof d !== 'object') return null;
  const meta = (d.meta ?? {}) as Json;
  if (meta.domain === 'canary') return null;
  const host = typeof d.server_name === 'string' ? d.server_name : null;
  const type = typeof d.type === 'string' ? d.type : null;
  const id = typeof meta.id === 'string' ? meta.id : null;
  if (!host || !type || !id) return null;

  const user = typeof d.user === 'string' ? d.user : '';
  const comment = typeof d.comment === 'string' ? d.comment : '';
  const length = (d.length ?? null) as Json | null;
  const oldLen = typeof length?.old === 'number' ? length.old : type === 'new' ? 0 : null;
  const newLen = typeof length?.new === 'number' ? length.new : null;
  const logType = typeof d.log_type === 'string' ? d.log_type : null;
  const revert = type !== 'log' && isRevert(comment);

  return {
    id,
    dt: typeof meta.dt === 'string' ? Date.parse(meta.dt) : NaN,
    host,
    type,
    title: typeof d.title === 'string' ? d.title : '(untitled)',
    titleUrl: safeWikiUrl(d.title_url),
    diffUrl: type === 'edit' ? safeWikiUrl(d.notify_url) : null,
    user,
    editor: classifyEditor(user, d.bot === true),
    namespace: typeof d.namespace === 'number' ? d.namespace : 0,
    comment,
    bytesDelta: oldLen !== null && newLen !== null ? newLen - oldLen : null,
    minor: d.minor === true,
    logType,
    logAction: typeof d.log_action === 'string' ? d.log_action : null,
    revert,
    moderation: logType !== null && MODERATION_LOGS.has(logType),
  };
}

/** Categorize events are automatic side effects of edits that are already in the stream. */
export const isDrawable = (c: WikiChange): boolean => c.type !== 'categorize';

export function actionLabel(c: WikiChange): string {
  if (c.type === 'new') return 'new page';
  if (c.type === 'log') return `${c.logType ?? 'log'}/${c.logAction ?? '?'}`;
  return c.revert ? 'revert' : c.type;
}

/** Longest delivery delay we believe; anything beyond is a clock problem, not a measurement. */
const MAX_LAG_MS = 60_000;

/**
 * Maps one change onto the span model as an asynchronous three-hop trace:
 *
 *   editor kind ──► wiki host ──► EventStreams
 *
 * The first two spans are instants at the event time; the last one runs from
 * the event time to the moment this browser received it, so its duration is
 * the measured delivery lag. Times are expressed on the local clock: the event
 * time is reconstructed as `receivedAt - lag`, which keeps every span in the
 * past even when this device's clock is behind Wikimedia's.
 */
export function changeToSpans(c: WikiChange, receivedAt: number, hostNode: string): Span[] {
  const rawLag = receivedAt - c.dt;
  const lag = Number.isFinite(rawLag) ? Math.max(0, Math.min(MAX_LAG_MS, rawLag)) : 0;
  const at = receivedAt - lag;
  const traceId = c.id.replace(/-/g, '').toLowerCase();
  const sid = (n: number) => `${traceId.slice(0, 14)}0${n}`;
  const flagged = c.revert || c.moderation;
  const attributes: Record<string, AttributeValue> = {
    'wiki.title': c.title,
    'wiki.host': c.host,
    'wiki.type': c.type,
    'wiki.action': actionLabel(c),
    'wiki.user': c.user,
    'wiki.editor': c.editor,
    'wiki.namespace': c.namespace,
  };
  if (c.comment) attributes['wiki.comment'] = c.comment;
  if (c.bytesDelta !== null) attributes['wiki.bytes_delta'] = c.bytesDelta;
  if (c.minor) attributes['wiki.minor'] = true;
  if (c.revert) attributes['wiki.revert'] = true;
  if (c.moderation) attributes['wiki.moderation'] = true;
  if (c.titleUrl) attributes['wiki.url'] = c.titleUrl;
  if (c.diffUrl) attributes['wiki.diff_url'] = c.diffUrl;

  return [
    {
      traceId, spanId: sid(1), parentSpanId: null, service: c.editor, name: actionLabel(c), kind: 'producer',
      start: at, end: at, status: flagged ? 'error' : 'ok', attributes,
    },
    {
      traceId, spanId: sid(2), parentSpanId: sid(1), service: hostNode, name: c.title, kind: 'consumer',
      start: at, end: at, status: flagged ? 'error' : 'ok', attributes: { 'wiki.host': c.host },
    },
    {
      traceId, spanId: sid(3), parentSpanId: sid(2), service: STREAM_NODE, name: 'deliver to this browser', kind: 'consumer',
      start: at, end: receivedAt, status: 'ok',
      attributes: { 'delivery.lag_ms': Math.round(lag), 'event.time': Number.isFinite(c.dt) ? new Date(c.dt).toISOString() : 'unknown' },
    },
  ];
}

/**
 * Gives the busiest hosts a node of their own and folds the long tail into
 * "other wikis". Scores are exponentially decayed event counts; a newcomer
 * takes the weakest slot only once it is clearly busier, so nodes don't flicker.
 */
export class HostSlots {
  private readonly scores = new Map<string, { score: number; at: number }>();
  readonly slots = new Set<string>();

  constructor(readonly capacity = 12, readonly halfLifeMs = 60_000, readonly minScore = 3) {}

  private decayed(host: string, now: number): number {
    const s = this.scores.get(host);
    if (!s) return 0;
    return s.score * Math.pow(2, -(now - s.at) / this.halfLifeMs);
  }

  assign(host: string, now: number): string {
    const score = this.decayed(host, now) + 1;
    this.scores.set(host, { score, at: now });
    if (this.slots.has(host)) return host;
    if (score >= this.minScore) {
      if (this.slots.size < this.capacity) {
        this.slots.add(host);
        return host;
      }
      let weakest: string | null = null;
      let weakestScore = Infinity;
      for (const h of this.slots) {
        const s = this.decayed(h, now);
        if (s < weakestScore) { weakestScore = s; weakest = h; }
      }
      if (weakest && score > weakestScore * 2) {
        this.slots.delete(weakest);
        this.slots.add(host);
        return host;
      }
    }
    if (this.scores.size > 2000) this.prune(now);
    return OTHER_WIKIS;
  }

  private prune(now: number): void {
    for (const [h] of this.scores) if (!this.slots.has(h) && this.decayed(h, now) < 0.05) this.scores.delete(h);
  }
}
