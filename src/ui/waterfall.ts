import { css, serviceColor } from '../app/palette';
import { formatMs } from '../model/stats';
import { childrenIndex, duration, type Span, type Trace } from '../model/span';
import { h } from './dom';

export interface WaterfallEvents {
  onClose: () => void;
  onHoverSpan: (span: Span | null) => void;
}

/** Gantt view of a single trace: one row per span, indented by depth. */
export class Waterfall {
  readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly title: HTMLElement;
  private readonly meta: HTMLElement;
  private current: Trace | null = null;

  constructor(private readonly events: WaterfallEvents) {
    this.title = h('span', { class: 'wf-title' });
    this.meta = h('span', { class: 'wf-meta' });
    this.body = h('div', { class: 'wf-body' });
    this.root = h('section', { class: 'waterfall hidden' },
      h('header', { class: 'wf-header' },
        h('div', { class: 'wf-heading' }, this.title, this.meta),
        h('button', { class: 'btn btn-ghost', onClick: () => events.onClose(), title: 'Close (Esc)' }, '✕'),
      ),
      this.body,
    );
  }

  show(trace: Trace): void {
    this.current = trace;
    this.root.classList.remove('hidden');
    const total = Math.max(0.001, trace.end - trace.start);
    const route = String(trace.root.attributes['http.route'] ?? trace.root.name);
    this.title.textContent = route;
    this.meta.replaceChildren(
      h('span', { class: trace.hasError ? 'pill pill-error' : 'pill pill-ok' }, trace.hasError ? 'ERROR' : 'OK'),
      h('span', {}, `${formatMs(total)} · ${trace.spans.length} spans · ${trace.services.length} services · `),
      h('code', { class: 'trace-id', title: trace.traceId }, trace.traceId.slice(0, 16)),
    );

    const children = childrenIndex(trace);
    const rows: HTMLElement[] = [];
    const walk = (span: Span, depth: number) => {
      const left = ((span.start - trace.start) / total) * 100;
      const width = Math.max(0.3, (duration(span) / total) * 100);
      const color = serviceColor(span.service);
      const row = h('div', {
        class: `wf-row${span.status === 'error' ? ' is-error' : ''}`,
        onMouseenter: () => this.events.onHoverSpan(span),
        onMouseleave: () => this.events.onHoverSpan(null),
      },
        h('div', { class: 'wf-label', style: `padding-left:${8 + depth * 14}px` },
          h('span', { class: 'wf-dot', style: `background:${css(color)}` }),
          h('span', { class: 'wf-service' }, span.service),
          h('span', { class: 'wf-name', title: span.name }, span.name),
        ),
        h('div', { class: 'wf-track' },
          h('div', { class: 'wf-bar', style: `left:${left}%;width:${width}%;background:${css(color, span.status === 'error' ? 0.55 : 0.85)}` },
            h('span', { class: 'wf-dur' }, formatMs(duration(span))),
          ),
        ),
      );
      rows.push(row);
      for (const c of children.get(span.spanId) ?? []) walk(c, depth + 1);
    };
    walk(trace.root, 0);
    // Orphans whose parent is missing from the export still deserve a row.
    const placed = new Set<Span>();
    const collect = (s: Span) => { placed.add(s); for (const c of children.get(s.spanId) ?? []) collect(c); };
    collect(trace.root);
    for (const s of trace.spans) if (!placed.has(s)) walk(s, 1);

    const ticks = h('div', { class: 'wf-ticks' }, ...[0, 0.25, 0.5, 0.75, 1].map((f) =>
      h('span', { style: `left:${f * 100}%` }, formatMs(total * f)),
    ));
    this.body.replaceChildren(ticks, ...rows);
  }

  hide(): void {
    this.current = null;
    this.root.classList.add('hidden');
  }

  get trace(): Trace | null {
    return this.current;
  }
}
