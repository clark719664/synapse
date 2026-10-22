import type { Engine, Kpis } from '../app/engine';
import { css, healthColor, serviceColor } from '../app/palette';
import type { BurstDetector } from '../live/bursts';
import { formatRatio } from '../live/source';
import { formatMs } from '../model/stats';
import { traceLabel, type Trace } from '../model/span';
import { formatDuration, h } from './dom';
import { sparklinePath } from './sparkline';

export interface SidebarEvents {
  onSelectTrace: (trace: Trace) => void;
  onSelectService: (id: string | null) => void;
}

const SVG = 'http://www.w3.org/2000/svg';

/** Right-hand column: KPIs, detected bursts, per-node table and the live stream. */
export class Sidebar {
  readonly root: HTMLElement;
  private readonly kpiEls: Record<keyof Kpis | 'spark', HTMLElement>;
  private readonly kpiLabels: Record<'rps' | 'errorRate' | 'p50' | 'p95', HTMLElement>;
  private readonly services: HTMLElement;
  private readonly servicesTitle: HTMLElement;
  private readonly servicesHead: HTMLElement;
  private readonly stream: HTMLElement;
  private readonly streamTitle: HTMLElement;
  private readonly filterLabel: HTMLElement;
  private readonly burstCard: HTMLElement;
  private readonly burstList: HTMLElement;
  private streamKey = '';
  private servicesKey = '';
  private streamHeld = false;
  bursts: BurstDetector | null = null;

  constructor(private readonly engine: Engine, private readonly events: SidebarEvents) {
    const kpi = () => {
      const label = h('span', { class: 'kpi-label' }, '');
      const value = h('span', { class: 'kpi-value num' }, '–');
      return { el: h('div', { class: 'kpi' }, label, value), label, value };
    };
    const rps = kpi();
    const err = kpi();
    const p50 = kpi();
    const p95 = kpi();
    const spark = document.createElementNS(SVG, 'svg') as unknown as HTMLElement;
    spark.setAttribute('class', 'spark');
    spark.setAttribute('viewBox', '0 0 300 44');
    spark.setAttribute('preserveAspectRatio', 'none');
    spark.setAttribute('aria-hidden', 'true');
    this.kpiEls = { rps: rps.value, errorRate: err.value, p50: p50.value, p95: p95.value, inFlight: h('span', { class: 'num' }), tracesSeen: h('span', { class: 'num' }), spark };
    this.kpiLabels = { rps: rps.label, errorRate: err.label, p50: p50.label, p95: p95.label };
    this.services = h('div', { class: 'services' });
    this.servicesTitle = h('span', {});
    this.servicesHead = h('div', { class: 'service-head', 'aria-hidden': 'true' });
    this.stream = h('div', { class: 'stream' });
    this.streamTitle = h('span', {});
    this.filterLabel = h('span', { class: 'muted' });
    this.burstList = h('div', { class: 'bursts' });
    this.burstCard = h('section', { class: 'card hidden' }, h('h2', {}, 'Bursts'), this.burstList);

    this.stream.addEventListener('pointerenter', () => (this.streamHeld = true));
    this.stream.addEventListener('pointerleave', () => (this.streamHeld = false));

    this.root = h('aside', { class: 'sidebar' },
      h('section', { class: 'card' },
        h('div', { class: 'kpis' }, rps.el, err.el, p50.el, p95.el),
        spark,
        h('div', { class: 'kpi-foot' }, this.kpiEls.inFlight, ' in flight, ', this.kpiEls.tracesSeen, ' seen'),
      ),
      this.burstCard,
      h('section', { class: 'card grow' },
        h('h2', {}, this.servicesTitle, h('span', { class: 'muted' }, ' by throughput')),
        this.servicesHead,
        this.services,
      ),
      h('section', { class: 'card grow' },
        h('h2', {}, this.streamTitle, ' ', this.filterLabel),
        this.stream,
      ),
    );
  }

  update(now: number): void {
    const v = this.engine.vocab;
    const k = this.engine.kpis(now);
    const lat = v.latency ? `${v.latency} ` : '';
    this.kpiLabels.rps.textContent = v.rate;
    this.kpiLabels.errorRate.textContent = v.errors;
    this.kpiLabels.p50.textContent = `${lat}p50`;
    this.kpiLabels.p95.textContent = `${lat}p95`;
    this.servicesTitle.textContent = v.nodes;
    const head = `${v.unit}|${v.error}|${v.latency}`;
    if (this.servicesHead.dataset.key !== head) {
      this.servicesHead.dataset.key = head;
      this.servicesHead.replaceChildren(h('span', {}), h('span', {}), h('span', { title: v.rate }, v.unit), h('span', { title: v.errors }, '%'), h('span', { title: `${v.latency} p95`.trim() }, 'p95'));
    }
    this.streamTitle.textContent = v.stream;

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
    const line = sparklinePath(series, 300, 44, max);
    this.kpiEls.spark.innerHTML =
      '<defs><linearGradient id="sparkFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="rgba(111,211,255,0.35)"/><stop offset="1" stop-color="rgba(111,211,255,0)"/></linearGradient></defs>' +
      (line ? `<path d="${line}L300,44L0,44Z" fill="url(#sparkFill)"/>` : '') +
      `<path d="${line}" fill="none" stroke="rgba(111,211,255,0.95)" stroke-width="1.5" vector-effect="non-scaling-stroke"/>` +
      `<path d="${sparklinePath(errSeries, 300, 44, max)}" fill="none" stroke="rgba(255,96,128,0.95)" stroke-width="1.5" vector-effect="non-scaling-stroke"/>`;

    this.renderBursts(now);
    this.renderServices(now);
    if (!this.streamHeld) this.renderStream();
  }

  private renderBursts(now: number): void {
    const b = this.bursts;
    this.burstCard.classList.toggle('hidden', this.engine.mode !== 'feed' || !b);
    if (!b || this.engine.mode !== 'feed') return;
    if (!b.isWarm(now)) {
      this.burstList.replaceChildren(h('p', { class: 'empty' }, 'Learning each wiki\'s usual pace. Bursts are flagged once a wiki edits at 3× its normal rate.'));
      return;
    }
    if (b.history.length === 0) {
      this.burstList.replaceChildren(h('p', { class: 'empty' }, 'No bursts yet. A wiki is flagged when it edits at 3× its normal rate for a few seconds.'));
      return;
    }
    this.burstList.replaceChildren(...b.history.slice(0, 5).map((x) => {
      const live = x.endedAt === null;
      const ratio = (live ? x.rate : x.peakRate) / x.baseline;
      const when = live ? `for ${formatDuration(now - x.since)}` : `${formatDuration(now - x.endedAt!)} ago`;
      return h('button', { class: `burst-row${live ? ' is-live' : ''}`, onClick: () => this.events.onSelectService(this.engine.topology.nodes.has(x.key) ? x.key : null) },
        h('span', { class: 'burst-host' }, x.key),
        h('span', { class: 'burst-ratio num' }, live ? formatRatio(ratio) : `peak ${formatRatio(ratio)}`),
        h('span', { class: 'burst-meta' }, `${(live ? x.rate : x.peakRate).toFixed(1)}/s vs ${x.baseline.toFixed(1)}/s usual, ${live ? 'active ' : 'ended '}${when}`),
      );
    }));
  }

  private renderServices(now: number): void {
    const rows = [...this.engine.topology.nodes.values()]
      .map((n) => {
        const rps = n.requests.rate(now, 10);
        const err = rps > 0 ? n.errors.rate(now, 10) / rps : 0;
        return { id: n.id, rps, err, p95: n.latency.percentile(0.95) };
      })
      .sort((a, b) => b.rps - a.rps || a.id.localeCompare(b.id));
    const maxRps = Math.max(1e-6, ...rows.map((r) => r.rps));
    const selected = this.engine.selectedService;
    const key = rows.map((r) => `${r.id}:${r.rps.toFixed(1)}:${r.err.toFixed(2)}:${r.p95}`).join('|') + selected;
    if (key === this.servicesKey) return;
    this.servicesKey = key;
    this.services.replaceChildren(...rows.map((r) =>
      h('button', {
        class: `service-row${selected === r.id ? ' is-selected' : ''}`,
        title: r.id,
        onClick: () => this.events.onSelectService(selected === r.id ? null : r.id),
      },
        h('span', { class: 'service-dot', style: `background:${css(serviceColor(r.id))}` }),
        h('span', { class: 'service-name' }, r.id),
        h('span', { class: 'service-stat num' }, r.rps.toFixed(1)),
        h('span', { class: 'service-stat num', style: r.err > 0.01 ? `color:${css(healthColor(r.err))}` : '' }, `${(r.err * 100).toFixed(0)}%`),
        h('span', { class: 'service-stat num' }, r.p95 > 0 ? formatMs(r.p95) : '–'),
        h('span', { class: 'service-bar' }, h('span', { style: `width:${(r.rps / maxRps) * 100}%;background:${css(r.err > 0.01 ? healthColor(r.err) : serviceColor(r.id), 0.85)}` })),
      ),
    ));
  }

  private renderStream(): void {
    const traces = this.engine.stream(40);
    this.filterLabel.textContent = this.engine.selectedService ? `in ${this.engine.selectedService}` : '';
    const key = traces.map((t) => t.traceId).join(',') + (this.engine.selectedTrace?.traceId ?? '');
    if (key === this.streamKey) return;
    this.streamKey = key;
    const selected = this.engine.selectedTrace?.traceId;
    this.stream.replaceChildren(...traces.map((t) => {
      const label = traceLabel(t);
      const a = t.root.attributes;
      const sub = a['wiki.host'] !== undefined ? `${a['wiki.host']}, ${a['wiki.action']}` : `${t.spans.length} spans across ${t.services.length} services`;
      return h('button', {
        class: `trace-row${t.hasError ? ' is-error' : ''}${selected === t.traceId ? ' is-selected' : ''}`,
        onClick: () => this.events.onSelectTrace(t),
      },
        h('span', { class: 'trace-status' }),
        h('span', { class: 'trace-text' },
          h('span', { class: 'trace-route', title: label }, label),
          h('span', { class: 'trace-sub', title: sub }, sub),
        ),
        h('span', { class: 'trace-dur num' }, formatMs(t.end - t.start)),
      );
    }));
  }
}
