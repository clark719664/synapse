import type { Engine, Kpis } from '../app/engine';
import { css, healthColor, serviceColor } from '../app/palette';
import { formatMs } from '../model/stats';
import type { Trace } from '../model/span';
import { h } from './dom';
import { sparklinePath } from './sparkline';

export interface SidebarEvents {
  onSelectTrace: (trace: Trace) => void;
  onSelectService: (id: string | null) => void;
}

/** Right-hand column: KPIs, per-service table and the live trace stream. */
export class Sidebar {
  readonly root: HTMLElement;
  private readonly kpiEls: Record<keyof Kpis | 'spark', HTMLElement>;
  private readonly services: HTMLElement;
  private readonly stream: HTMLElement;
  private readonly filterLabel: HTMLElement;
  private streamKey = '';

  constructor(private readonly engine: Engine, private readonly events: SidebarEvents) {
    const kpi = (label: string, cls = '') => h('div', { class: `kpi ${cls}` }, h('span', { class: 'kpi-label' }, label), h('span', { class: 'kpi-value' }, '–'));
    const rps = kpi('Requests / s');
    const err = kpi('Error rate');
    const p50 = kpi('p50');
    const p95 = kpi('p95');
    const spark = document.createElementNS('http://www.w3.org/2000/svg', 'svg') as unknown as HTMLElement;
    spark.setAttribute('class', 'spark');
    spark.setAttribute('viewBox', '0 0 240 36');
    spark.setAttribute('preserveAspectRatio', 'none');
    this.kpiEls = {
      rps: rps.lastElementChild as HTMLElement,
      errorRate: err.lastElementChild as HTMLElement,
      p50: p50.lastElementChild as HTMLElement,
      p95: p95.lastElementChild as HTMLElement,
      inFlight: h('span'),
      tracesSeen: h('span'),
      spark,
    };
    this.services = h('div', { class: 'services' });
    this.stream = h('div', { class: 'stream' });
    this.filterLabel = h('span', { class: 'muted' });

    this.root = h('aside', { class: 'sidebar' },
      h('section', { class: 'card' },
        h('div', { class: 'kpis' }, rps, err, p50, p95),
        spark,
        h('div', { class: 'kpi-foot' }, 'in flight ', this.kpiEls.inFlight, ' · traces ', this.kpiEls.tracesSeen),
      ),
      h('section', { class: 'card grow' },
        h('h2', {}, 'Services', h('span', { class: 'muted' }, ' by throughput')),
        this.services,
      ),
      h('section', { class: 'card grow' },
        h('h2', {}, 'Trace stream ', this.filterLabel),
        this.stream,
      ),
    );
  }

  update(now: number): void {
    const k = this.engine.kpis(now);
    this.kpiEls.rps.textContent = k.rps.toFixed(1);
    this.kpiEls.errorRate.textContent = `${(k.errorRate * 100).toFixed(1)}%`;
    this.kpiEls.errorRate.style.color = k.errorRate > 0.05 ? css(healthColor(k.errorRate)) : '';
    this.kpiEls.p50.textContent = formatMs(k.p50);
    this.kpiEls.p95.textContent = formatMs(k.p95);
    this.kpiEls.inFlight.textContent = String(k.inFlight);
    this.kpiEls.tracesSeen.textContent = k.tracesSeen.toLocaleString();

    const series = this.engine.traceCount.series(now, 60);
    const errSeries = this.engine.errorCount.series(now, 60);
    const max = Math.max(1, ...series);
    this.kpiEls.spark.innerHTML =
      `<path d="${sparklinePath(series, 240, 36, max)}" fill="none" stroke="rgba(124,196,255,0.9)" stroke-width="1.5"/>` +
      `<path d="${sparklinePath(errSeries, 240, 36, max)}" fill="none" stroke="rgba(248,113,113,0.9)" stroke-width="1.5"/>`;

    this.renderServices(now);
    this.renderStream();
  }

  private renderServices(now: number): void {
    const rows = [...this.engine.topology.nodes.values()]
      .map((n) => {
        const rps = n.requests.rate(now, 10);
        const err = rps > 0 ? n.errors.rate(now, 10) / rps : 0;
        return { id: n.id, rps, err, p95: n.latency.percentile(0.95) };
      })
      .sort((a, b) => b.rps - a.rps);
    const maxRps = Math.max(1e-6, ...rows.map((r) => r.rps));
    const selected = this.engine.selectedService;
    this.services.replaceChildren(...rows.map((r) =>
      h('button', {
        class: `service-row${selected === r.id ? ' is-selected' : ''}`,
        onClick: () => this.events.onSelectService(selected === r.id ? null : r.id),
      },
        h('span', { class: 'service-dot', style: `background:${css(serviceColor(r.id))}` }),
        h('span', { class: 'service-name' }, r.id),
        h('span', { class: 'service-bar' }, h('span', { style: `width:${(r.rps / maxRps) * 100}%;background:${css(r.err > 0.01 ? healthColor(r.err) : serviceColor(r.id), 0.8)}` })),
        h('span', { class: 'service-stat' }, `${r.rps.toFixed(1)}`),
        h('span', { class: 'service-stat', style: r.err > 0.01 ? `color:${css(healthColor(r.err))}` : '' }, `${(r.err * 100).toFixed(0)}%`),
        h('span', { class: 'service-stat' }, formatMs(r.p95)),
      ),
    ));
  }

  private renderStream(): void {
    const traces = this.engine.stream(40);
    this.filterLabel.textContent = this.engine.selectedService ? `· ${this.engine.selectedService}` : '';
    const key = traces.map((t) => t.traceId).join(',') + (this.engine.selectedTrace?.traceId ?? '');
    if (key === this.streamKey) return;
    this.streamKey = key;
    const selected = this.engine.selectedTrace?.traceId;
    this.stream.replaceChildren(...traces.map((t) => {
      const route = String(t.root.attributes['http.route'] ?? t.root.name);
      return h('button', {
        class: `trace-row${t.hasError ? ' is-error' : ''}${selected === t.traceId ? ' is-selected' : ''}`,
        onClick: () => this.events.onSelectTrace(t),
      },
        h('span', { class: 'trace-status' }),
        h('span', { class: 'trace-route', title: route }, route),
        h('span', { class: 'trace-spans' }, `${t.spans.length}`),
        h('span', { class: 'trace-dur' }, formatMs(t.end - t.start)),
      );
    }));
  }
}
