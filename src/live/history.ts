import type { EditorKind } from './wikimedia';

export const SNAPSHOT_URLS = [
  // The contents API is not CDN-cached, so it is current to the collector's last push (once a minute).
  'https://api.github.com/repos/clark719664/synapse/contents/snapshot.json?ref=data',
  // Fallback when the API's per-visitor rate limit is spent; may be up to five minutes older. Replay closes the gap either way.
  'https://raw.githubusercontent.com/clark719664/synapse/data/snapshot.json',
];

export const KINDS = ['total', 'flagged', 'bots', 'anonymous', 'automatic'] as const;
export type Kind = (typeof KINDS)[number];
export type Rows = Record<Kind, number[]>;

export interface SnapshotBurst {
  key: string;
  since: number;
  endedAt: number | null;
  baseline: number;
  peakRate: number;
}

/** A pin from the collector: [eventTime, lat, lon, editor index, flagged 0/1, host, title]. */
export type SnapshotPin = [number, number, number, number, number, string, string];

export interface Snapshot {
  generatedAt: number;
  /** Every change before this instant is in the snapshot; nothing at or after it is. */
  boundary: number;
  coverage: [number, number][];
  seconds: { start: number } & Rows;
  minutes: { start: number } & Rows;
  baselines: Record<string, number>;
  bursts: SnapshotBurst[];
  /** [lat, lon, count, flagged] per 1° cell over the last 24 h. */
  cells: [number, number, number, number][];
  recentPins: SnapshotPin[];
  lookups: Record<string, number>;
}

export const EDITOR_ORDER: readonly EditorKind[] = ['registered', 'anonymous', 'bots'];

type Json = Record<string, unknown>;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown, max = 300): string | null => (typeof v === 'string' ? v.slice(0, max) : null);

function rows(v: unknown, length: number): ({ start: number } & Rows) | null {
  const o = v as Json | null;
  if (!o || !num(o.start)) return null;
  const out = { start: o.start } as { start: number } & Rows;
  for (const k of KINDS) {
    const a = o[k];
    if (!Array.isArray(a) || a.length !== length || !a.every((x) => num(x) && x >= 0)) return null;
    out[k] = a as number[];
  }
  return out;
}

/** Validates a collector snapshot. Anything malformed is rejected whole rather than half-trusted. */
export function parseSnapshot(body: unknown, secondsKept = 3600, minutesKept = 1440): Snapshot | null {
  const o = body as Json | null;
  if (!o || o.v !== 2 || !num(o.generatedAt) || !num(o.boundary) || o.boundary % 1000 !== 0) return null;
  const seconds = rows(o.seconds, secondsKept);
  const minutes = rows(o.minutes, minutesKept);
  if (!seconds || !minutes || seconds.start + secondsKept * 1000 !== o.boundary) return null;
  const coverage = (Array.isArray(o.coverage) ? o.coverage : []).filter((iv): iv is [number, number] => Array.isArray(iv) && num(iv[0]) && num(iv[1]) && iv[0] <= iv[1]);
  const baselines: Record<string, number> = {};
  for (const [k, v] of Object.entries((o.baselines as Json | undefined) ?? {})) if (num(v) && v >= 0) baselines[k.slice(0, 120)] = v;
  const bursts: SnapshotBurst[] = [];
  for (const b of (Array.isArray(o.bursts) ? o.bursts : []) as Json[]) {
    const key = str(b?.key, 120);
    if (key && num(b.since) && num(b.baseline) && num(b.peakRate) && (b.endedAt === null || num(b.endedAt))) {
      bursts.push({ key, since: b.since, endedAt: b.endedAt as number | null, baseline: b.baseline, peakRate: b.peakRate });
    }
  }
  const cells = (Array.isArray(o.cells) ? o.cells : []).filter((c): c is [number, number, number, number] =>
    Array.isArray(c) && c.length === 4 && c.every(num) && Math.abs(c[0] as number) <= 90 && Math.abs(c[1] as number) <= 180);
  const recentPins: SnapshotPin[] = [];
  for (const p of (Array.isArray(o.recentPins) ? o.recentPins : []) as unknown[][]) {
    if (!Array.isArray(p) || p.length !== 7) continue;
    const [t, lat, lon, ed, fl] = p;
    const host = str(p[5], 120);
    const title = str(p[6], 200);
    if (num(t) && num(lat) && num(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && num(ed) && ed >= 0 && ed <= 2 && num(fl) && host !== null && title !== null) {
      recentPins.push([t, lat, lon, ed, fl, host, title]);
    }
  }
  const lookups: Record<string, number> = {};
  for (const [k, v] of Object.entries((o.lookups as Json | undefined) ?? {})) if (num(v)) lookups[k] = v;
  return { generatedAt: o.generatedAt, boundary: o.boundary, coverage, seconds, minutes, baselines, bursts, cells, recentPins, lookups };
}

/** Fixed ring of time buckets for every kind; a slot remembers which bucket it holds. */
class Ring {
  private readonly owner: Float64Array;
  private readonly data: Record<Kind, Int32Array>;

  constructor(readonly size: number, readonly unitMs: number) {
    this.owner = new Float64Array(size).fill(-1);
    this.data = Object.fromEntries(KINDS.map((k) => [k, new Int32Array(size)])) as Record<Kind, Int32Array>;
  }

  private slot(bucket: number, claim: boolean): number {
    const i = ((bucket % this.size) + this.size) % this.size;
    if (this.owner[i] !== bucket) {
      if (!claim) return -1;
      this.owner[i] = bucket;
      for (const k of KINDS) this.data[k][i] = 0;
    }
    return i;
  }

  add(bucket: number, kind: Kind, n = 1): void {
    this.data[kind][this.slot(bucket, true)]! += n;
  }

  get(bucket: number, kind: Kind): number {
    const i = this.slot(bucket, false);
    return i < 0 ? 0 : this.data[kind][i]!;
  }
}

export interface Window {
  start: number;
  unitMs: number;
  /** null where nobody was watching: a gap, not a zero. */
  values: Record<Kind, (number | null)[]>;
  /** Time inside the window (up to now) that nobody covered. */
  missingMs: number;
}

/**
 * Exact rolling counts: the collector's snapshot up to its boundary, then
 * every change this page has received since. Buckets nobody covered are gaps.
 */
export class RollingHistory {
  private readonly sec = new Ring(3600, 1000);
  private readonly min = new Ring(1440, 60_000);
  /** Changes before this came from the snapshot; this page counts everything at or after it. */
  boundary: number;
  coverage: [number, number][] = [];
  private seen = new Map<string, number>();
  newest = 0;
  fromSnapshot = false;

  /** `start` is 0 unless a snapshot will be loaded: without one, every change the stream delivers is counted. */
  constructor(start = 0) {
    this.boundary = Math.floor(start / 1000) * 1000;
  }

  load(s: Snapshot): void {
    this.boundary = s.boundary;
    this.fromSnapshot = true;
    this.coverage = s.coverage.map(([a, b]) => [a, b]);
    const firstSecond = s.seconds.start / 1000;
    for (let i = 0; i < 3600; i++) for (const k of KINDS) if (s.seconds[k][i]) this.sec.add(firstSecond + i, k, s.seconds[k][i]);
    const firstMinute = s.minutes.start / 60_000;
    for (let i = 0; i < 1440; i++) for (const k of KINDS) if (s.minutes[k][i]) this.min.add(firstMinute + i, k, s.minutes[k][i]);
    // The minute holding the boundary is only partly in `minutes`; its earlier seconds are in `seconds`.
    const bm = Math.floor(s.boundary / 60_000);
    for (let t = bm * 60; t < s.boundary / 1000; t++) for (const k of KINDS) {
      const v = this.sec.get(t, k);
      if (v) this.min.add(bm, k, v);
    }
  }

  /** Counts one change. Returns false if it was already counted (before the boundary, or a replayed duplicate). */
  record(id: string, dt: number, editor: EditorKind, flagged: boolean, automatic: boolean): boolean {
    if (dt < this.boundary || this.seen.has(id)) return false;
    this.seen.set(id, dt);
    if (this.seen.size > 20_000) {
      const cutoff = this.newest - 180_000;
      for (const [k, v] of this.seen) if (v < cutoff) this.seen.delete(k);
    }
    this.newest = Math.max(this.newest, dt);
    const s = Math.floor(dt / 1000);
    const m = Math.floor(dt / 60_000);
    const add = (kind: Kind) => { this.sec.add(s, kind); this.min.add(m, kind); };
    if (automatic) { add('automatic'); return true; }
    add('total');
    if (flagged) add('flagged');
    if (editor === 'bots') add('bots');
    if (editor === 'anonymous') add('anonymous');
    return true;
  }

  /** Extends coverage: this page has every change between `from` and `to`. */
  cover(from: number, to: number): void {
    const last = this.coverage[this.coverage.length - 1];
    if (last && from <= last[1] + 1000) last[1] = Math.max(last[1], to);
    else this.coverage.push([from, to]);
  }

  /** How much of [a, b) is covered. */
  private coveredMs(a: number, b: number): number {
    let ms = 0;
    for (const [s, e] of this.coverage) ms += Math.max(0, Math.min(b, e) - Math.max(a, s));
    return ms;
  }

  window(resolution: 'second' | 'minute', count: number, now: number): Window {
    const ring = resolution === 'second' ? this.sec : this.min;
    const unit = ring.unitMs;
    const end = Math.floor(now / unit);
    const start = end - count + 1;
    const values = Object.fromEntries(KINDS.map((k) => [k, [] as (number | null)[]])) as Window['values'];
    let missingMs = 0;
    for (let b = start; b <= end; b++) {
      const from = b * unit;
      const to = Math.min((b + 1) * unit, now);
      const covered = this.coveredMs(from, to);
      // A bucket shows its exact count for whatever part of it was covered; only a wholly unwatched bucket is a gap.
      // The current second is still arriving, so it never counts as missing.
      if (b < end) missingMs += Math.max(0, to - from - covered);
      for (const k of KINDS) values[k].push(covered > 0 ? ring.get(b, k) : null);
    }
    return { start: start * unit, unitMs: unit, values, missingMs };
  }
}
