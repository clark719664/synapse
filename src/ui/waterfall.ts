import { css, serviceColor } from '../app/palette';
import { safeWikiUrl } from '../live/wikimedia';
import { formatMs } from '../model/stats';
import { childrenIndex, duration, traceLabel, type Span, type Trace } from '../model/span';
import { h } from './dom';

export interface WaterfallEvents {
  onClose: () => void;
  onHoverSpan: (span: Span | null) => void;
}

const HIDDEN_ATTRS = new Set(['wiki.url', 'wiki.diff_url', 'wiki.title', 'wiki.comment']);

/** Gantt view of a single trace, one row per span indented by depth, with the selected span's details beside it. */
export class Waterfall {
  readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly details: HTMLElement;
  private readonly title: HTMLElement;
  private readonly meta: HTMLElement;
  private current: Trace | null = null;
  private rows = new Map<Span, HTMLElement>();

  constructor(private readonly events: WaterfallEvents) {
    this.title = h('h2', { class: 'wf-title' });
    this.meta = h('div', { class: 'wf-meta' });
    this.body = h('div', { class: 'wf-body' });
    this.details = h('aside', { class: 'wf-details' });
    this.root = h('section', { class: 'waterfall hidden', 'aria-label': 'Trace waterfall' },
      h('header', { class: 'wf-header' },
        h('div', { class: 'wf-heading' }, this.title, this.meta),
        h('button', { class: 'btn btn-ghost btn-icon', onClick: () => events.onClose(), title: 'Close (Esc)', 'aria-label': 'Close waterfall' }, '✕'),
      ),
      h('div', { class: 'wf-main' }, this.body, this.details),
    );
  }

  show(trace: Trace): void {
    this.current = trace;
    this.root.classList.remove('hidden');
    const total = trace.end - trace.start;
    const scale = Math.max(0.001, total);
    this.title.textContent = traceLabel(trace);
    this.title.title = traceLabel(trace);
    this.meta.replaceChildren(
      h('span', { class: trace.hasError ? 'pill pill-error' : 'pill pill-ok' }, trace.hasError ? 'Flagged' : 'OK'),
      h('span', { class: 'num' }, formatMs(total)),
      h('span', {}, `${trace.spans.length} spans`),
      h('span', {}, `${trace.services.length} services`),
      h('code', { class: 'trace-id', title: trace.traceId }, trace.traceId.slice(0, 16)),
    );

    const children = childrenIndex(trace);
    const rows: HTMLElement[] = [];
    this.rows.clear();
    const walk = (span: Span, depth: number) => {
      const left = ((span.start - trace.start) / scale) * 100;
      const instant = duration(span) <= 0;
      const width = instant ? 0 : Math.max(0.4, (duration(span) / scale) * 100);
      const color = serviceColor(span.service);
      const mark = instant
        ? h('div', { class: 'wf-instant', style: `left:${left}%;background:${css(color)}`, title: 'Instant event' })
        : h('div', { class: 'wf-bar', style: `left:${left}%;width:${width}%;background:linear-gradient(90deg, ${css(color, 0.95)}, ${css(color, 0.6)})` });
      const durLabel = h('span', { class: 'wf-dur num', style: `left:calc(${Math.min(left + width, 100)}% + ${instant ? 10 : 6}px)` }, instant ? 'instant' : formatMs(duration(span)));
      const row = h('button', {
        class: `wf-row${span.status === 'error' ? ' is-error' : ''}`,
        onMouseenter: () => this.events.onHoverSpan(span),
        onMouseleave: () => this.events.onHoverSpan(null),
        onClick: () => this.select(span),
      },
        h('span', { class: 'wf-label', style: `padding-left:${8 + depth * 14}px` },
          h('span', { class: 'wf-dot', style: `background:${css(color)}` }),
          h('span', { class: 'wf-service' }, span.service),
          h('span', { class: 'wf-name', title: span.name }, span.name),
        ),
        h('span', { class: 'wf-track' }, mark, durLabel),
      );
      this.rows.set(span, row);
      rows.push(row);
      for (const c of children.get(span.spanId) ?? []) walk(c, depth + 1);
    };
    walk(trace.root, 0);
    // Orphans whose parent is missing from the export still deserve a row.
    const placed = new Set<Span>();
    const collect = (s: Span) => { placed.add(s); for (const c of children.get(s.spanId) ?? []) collect(c); };
    collect(trace.root);
    for (const s of trace.spans) if (!placed.has(s)) walk(s, 1);

    const ticks = h('div', { class: 'wf-ticks', 'aria-hidden': 'true' }, ...[0, 0.25, 0.5, 0.75, 1].map((f) =>
      h('span', { style: `left:${f * 100}%` }, f === 0 ? '0' : formatMs(total * f)),
    ));
    this.body.replaceChildren(ticks, ...rows);
    this.select(trace.root);
  }

  private select(span: Span): void {
    for (const [s, row] of this.rows) row.classList.toggle('is-selected', s === span);
    const a = span.attributes;
    const out: HTMLElement[] = [];
    const title = a['wiki.title'];
    if (title !== undefined) {
      const page = safeWikiUrl(a['wiki.url']);
      const diff = safeWikiUrl(a['wiki.diff_url']);
      out.push(h('p', { class: 'wd-title' }, String(title)));
      if (a['wiki.comment']) out.push(h('p', { class: 'wd-comment' }, String(a['wiki.comment'])));
      const delta = a['wiki.bytes_delta'];
      if (typeof delta === 'number') out.push(h('p', { class: `wd-delta num ${delta > 0 ? 'is-add' : delta < 0 ? 'is-remove' : ''}` }, `${delta > 0 ? '+' : ''}${delta.toLocaleString()} bytes`));
      const links = [
        page ? h('a', { href: page, target: '_blank', rel: 'noopener noreferrer' }, 'Open page') : null,
        diff ? h('a', { href: diff, target: '_blank', rel: 'noopener noreferrer' }, 'View the diff') : null,
      ].filter((x): x is HTMLAnchorElement => x !== null);
      if (links.length) out.push(h('p', { class: 'wd-links' }, ...links));
    } else {
      out.push(h('p', { class: 'wd-title' }, span.name), h('p', { class: 'wd-comment' }, `${span.service}, ${span.kind} span, ${formatMs(duration(span))}`));
    }
    const entries = Object.entries(a).filter(([k]) => !HIDDEN_ATTRS.has(k)).slice(0, 16);
    if (entries.length) {
      out.push(h('dl', { class: 'wd-attrs' }, ...entries.flatMap(([k, v]) => [
        h('dt', {}, k),
        h('dd', { title: String(v) }, String(v)),
      ])));
    }
    this.details.replaceChildren(...out);
  }

  hide(): void {
    this.current = null;
    this.root.classList.add('hidden');
  }

  get trace(): Trace | null {
    return this.current;
  }
}
