import { describe, expect, it } from 'vitest';
import { assembleTraces } from '../src/model/span';
import { Topology } from '../src/model/topology';
import {
  changeToSpans, classifyEditor, HostSlots, isDrawable, isRevert, OTHER_WIKIS, parseRecentChange, safeWikiUrl, STREAM_NODE,
} from '../src/live/wikimedia';

/** Shaped like a real `mediawiki.recentchange` event, with made-up people. */
const event = (over: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) => JSON.stringify({
  $schema: '/mediawiki/recentchange/1.0.0',
  meta: { uri: 'https://en.wikipedia.org/wiki/Ada_Lovelace', id: '01d77ace-f0f5-4ceb-b82c-be1a70b11e90', domain: 'en.wikipedia.org', stream: 'mediawiki.recentchange', dt: '2026-10-22T02:07:02.497Z', ...meta },
  id: 3507163947,
  type: 'edit',
  namespace: 0,
  title: 'Ada Lovelace',
  title_url: 'https://en.wikipedia.org/wiki/Ada_Lovelace',
  comment: 'copyedit',
  timestamp: 1792634821,
  user: 'ExampleEditor',
  bot: false,
  notify_url: 'https://en.wikipedia.org/w/index.php?diff=1290117613&oldid=264303178',
  minor: false,
  length: { old: 962, new: 1030 },
  server_name: 'en.wikipedia.org',
  wiki: 'enwiki',
  ...over,
});

describe('parseRecentChange', () => {
  it('extracts the fields the map needs', () => {
    const c = parseRecentChange(event())!;
    expect(c).toMatchObject({
      id: '01d77ace-f0f5-4ceb-b82c-be1a70b11e90',
      dt: Date.parse('2026-10-22T02:07:02.497Z'),
      host: 'en.wikipedia.org',
      type: 'edit',
      title: 'Ada Lovelace',
      editor: 'registered',
      bytesDelta: 68,
      revert: false,
      moderation: false,
      titleUrl: 'https://en.wikipedia.org/wiki/Ada_Lovelace',
      diffUrl: 'https://en.wikipedia.org/w/index.php?diff=1290117613&oldid=264303178',
    });
  });

  it('rejects junk, canaries and events missing a host, type or id', () => {
    expect(parseRecentChange('not json')).toBeNull();
    expect(parseRecentChange('null')).toBeNull();
    expect(parseRecentChange(event({}, { domain: 'canary' }))).toBeNull();
    expect(parseRecentChange(event({ server_name: undefined }))).toBeNull();
    expect(parseRecentChange(event({ type: 42 }))).toBeNull();
    expect(parseRecentChange(event({}, { id: undefined }))).toBeNull();
  });

  it('treats a new page as growing from zero bytes and flags moderation logs', () => {
    expect(parseRecentChange(event({ type: 'new', length: { new: 500 } }))!.bytesDelta).toBe(500);
    const block = parseRecentChange(event({ type: 'log', log_type: 'block', log_action: 'reblock', length: undefined }))!;
    expect(block.moderation).toBe(true);
    expect(block.bytesDelta).toBeNull();
    expect(block.diffUrl).toBeNull();
    expect(parseRecentChange(event({ type: 'log', log_type: 'newusers', log_action: 'create' }))!.moderation).toBe(false);
  });

  it('never trusts a link outside Wikimedia', () => {
    const c = parseRecentChange(event({ title_url: 'javascript:alert(1)', notify_url: 'https://evil.example/wiki' }))!;
    expect(c.titleUrl).toBeNull();
    expect(c.diffUrl).toBeNull();
  });

  it('skips categorize side effects', () => {
    expect(isDrawable(parseRecentChange(event({ type: 'categorize' }))!)).toBe(false);
    expect(isDrawable(parseRecentChange(event())!)).toBe(true);
  });
});

describe('classification', () => {
  it('sorts editors into bots, logged-out and registered', () => {
    expect(classifyEditor('ExampleBot', true)).toBe('bots');
    expect(classifyEditor('203.0.113.7', false)).toBe('anonymous');
    expect(classifyEditor('2001:db8::1', false)).toBe('anonymous');
    expect(classifyEditor('~2026-12345-6', false)).toBe('anonymous');
    expect(classifyEditor('Ada', false)).toBe('registered');
  });

  it('recognises undo and rollback summaries', () => {
    expect(isRevert('Reverted edits by Example (talk) to last version by Other')).toBe(true);
    expect(isRevert('Undid revision 1234 by Example (talk)')).toBe(true);
    expect(isRevert('rv vandalism')).toBe(true);
    expect(isRevert('Откат правок Example')).toBe(true);
    expect(isRevert('added references to the reverberation section')).toBe(false);
    expect(isRevert('copyedit')).toBe(false);
  });

  it('only accepts https Wikimedia hosts', () => {
    expect(safeWikiUrl('https://commons.wikimedia.org/wiki/File:X.jpg')).toBe('https://commons.wikimedia.org/wiki/File:X.jpg');
    expect(safeWikiUrl('http://en.wikipedia.org/wiki/X')).toBeNull();
    expect(safeWikiUrl('https://wikipedia.org.evil.example/')).toBeNull();
    expect(safeWikiUrl(42)).toBeNull();
  });
});

describe('changeToSpans', () => {
  const c = parseRecentChange(event())!;

  it('maps a change onto editor → wiki → EventStreams with the measured lag as the last span', () => {
    const received = c.dt + 850;
    const spans = changeToSpans(c, received, 'en.wikipedia.org');
    expect(spans.map((s) => s.service)).toEqual(['registered', 'en.wikipedia.org', STREAM_NODE]);
    expect(spans.map((s) => s.kind)).toEqual(['producer', 'consumer', 'consumer']);
    expect(spans[1]!.parentSpanId).toBe(spans[0]!.spanId);
    expect(spans[2]!.parentSpanId).toBe(spans[1]!.spanId);
    expect(spans[0]!.start).toBe(c.dt);
    expect(spans[2]!.end - spans[2]!.start).toBe(850);
    expect(spans[2]!.attributes['delivery.lag_ms']).toBe(850);
    expect(new Set(spans.map((s) => s.spanId)).size).toBe(3);
    expect(spans[0]!.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('keeps every span in the past when this clock is behind Wikimedia\'s', () => {
    const spans = changeToSpans(c, c.dt - 4000, 'en.wikipedia.org');
    expect(spans[2]!.end - spans[2]!.start).toBe(0);
    expect(Math.max(...spans.map((s) => s.end))).toBe(c.dt - 4000);
  });

  it('marks reverts and moderation as errors on the first hop only', () => {
    const rv = parseRecentChange(event({ comment: 'Undid revision 1 by Example' }))!;
    const spans = changeToSpans(rv, rv.dt + 900, 'en.wikipedia.org');
    expect(spans.map((s) => s.status)).toEqual(['error', 'error', 'ok']);
    expect(spans[0]!.name).toBe('revert');
  });

  it('produces a graph the topology understands', () => {
    const topo = new Topology();
    const [trace] = assembleTraces(changeToSpans(c, c.dt + 900, 'en.wikipedia.org'));
    const transfers = topo.ingest(trace!);
    expect(transfers.map((t) => t.edgeId)).toEqual([`registered→en.wikipedia.org`, `en.wikipedia.org→${STREAM_NODE}`]);
    expect(topo.nodes.get('registered')!.depth).toBe(0);
    expect(topo.nodes.get(STREAM_NODE)!.depth).toBe(2);
  });
});

describe('HostSlots', () => {
  it('promotes busy hosts and folds the long tail into "other wikis"', () => {
    const slots = new HostSlots(2, 60_000, 3);
    expect(slots.assign('a.org', 0)).toBe(OTHER_WIKIS);
    expect(slots.assign('a.org', 0)).toBe(OTHER_WIKIS);
    expect(slots.assign('a.org', 0)).toBe('a.org');
    for (let i = 0; i < 3; i++) slots.assign('b.org', 30);
    expect(slots.slots).toEqual(new Set(['a.org', 'b.org']));
    for (let i = 0; i < 3; i++) expect(slots.assign('c.org', 40)).toBe(OTHER_WIKIS);
  });

  it('lets a much busier newcomer take the weakest slot once the old one has decayed', () => {
    const slots = new HostSlots(1, 1000, 3);
    for (let i = 0; i < 3; i++) slots.assign('old.org', 0);
    let got = '';
    for (let i = 0; i < 10; i++) got = slots.assign('new.org', 5000 + i);
    expect(got).toBe('new.org');
    expect(slots.slots).toEqual(new Set(['new.org']));
  });
});
