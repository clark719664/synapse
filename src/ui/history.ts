import type { WikipediaSource } from '../live/source';
import type { Window } from '../live/history';
import { formatDuration, h } from './dom';

type Range = '10m' | '1h' | '24h';
const RANGES: [Range, string, 'second' | 'minute', number][] = [
  ['10m', '10 min', 'second', 600],
  ['1h', '1 hour', 'second', 3600],
  ['24h', '24 hours', 'minute', 1440],
];
const W = 300;
const H = 64;
const SVG = 'http://www.w3.org/2000/svg';

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Builds an SVG path that breaks wherever a value is null (no data), so gaps stay visible as gaps. */
function path(values: (number | null)[], max: number, area: boolean): string {
  const step = W / Math.max(1, values.length - 1);
  let d = '';
  let runStart = -1;
  const y = (v: number) => H - (Math.min(v, max) / max) * (H - 3) - 1;
  const close = (end: number) => { if (area && runStart >= 0) d += `L${(end * step).toFixed(1)},${H}L${(runStart * step).toFixed(1)},${H}Z`; };
  values.forEach((v, i) => {
    if (v === null) { close(i - 1); runStart = -1; return; }
    d += `${runStart < 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${y(v).toFixed(1)}`;
    if (runStart < 0) runStart = i;
  });
  close(values.length - 1);
  return d;
}

/** Sidebar card: exact change counts per second (last hour) or per minute (last day), with coverage spelled out. */
export class HistoryCard {
  readonly root: HTMLElement;
  private range: Range = '10m';
  private readonly chart: SVGSVGElement;
  private readonly stats: HTMLElement;
  private readonly note: HTMLElement;
  private readonly buttons = new Map<Range, HTMLButtonElement>();

  constructor() {
    this.chart = document.createElementNS(SVG, 'svg');
    this.chart.setAttribute('class', 'history-chart');
    this.chart.setAttribute('viewBox', `0 0 ${W} ${H}`);
    this.chart.setAttribute('preserveAspectRatio', 'none');
    this.chart.setAttribute('aria-hidden', 'true');
    this.stats = h('div', { class: 'history-stats' });
    this.note = h('p', { class: 'history-note' });
    const seg = h('div', { class: 'segmented small', role: 'group', 'aria-label': 'History range' },
      ...RANGES.map(([id, label]) => {
        const b = h('button', { class: `seg${id === this.range ? ' is-active' : ''}`, 'aria-pressed': String(id === this.range), onClick: () => this.pick(id) }, label);
        this.buttons.set(id, b);
        return b;
      }));
    this.root = h('section', { class: 'card history hidden' },
      h('div', { class: 'card-head' }, h('h2', {}, 'History'), seg),
      this.chart as unknown as HTMLElement,
      this.stats,
      this.note,
    );
  }

  private pick(r: Range): void {
    this.range = r;
    for (const [id, b] of this.buttons) {
      b.classList.toggle('is-active', id === r);
      b.setAttribute('aria-pressed', String(id === r));
    }
  }

  update(src: WikipediaSource, visible: boolean, now: number): void {
    this.root.classList.toggle('hidden', !visible);
    if (!visible) return;
    const [, , res, count] = RANGES.find(([id]) => id === this.range)!;
    const w: Window = src.history.window(res, count, now);
    const total = w.values.total;
    const flagged = w.values.flagged;
    let sum = 0, flag = 0, auto = 0, peak = 0, peakAt = 0;
    total.forEach((v, i) => {
      if (v === null) return;
      sum += v;
      flag += flagged[i] ?? 0;
      auto += w.values.automatic[i] ?? 0;
      if (v > peak) { peak = v; peakAt = w.start + i * w.unitMs; }
    });
    const max = Math.max(1, peak);
    this.chart.innerHTML =
      '<defs><linearGradient id="histFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="rgba(111,211,255,0.4)"/><stop offset="1" stop-color="rgba(111,211,255,0.02)"/></linearGradient></defs>' +
      `<path d="${path(total, max, true)}" fill="url(#histFill)"/>` +
      `<path d="${path(total, max, false)}" fill="none" stroke="rgba(111,211,255,0.95)" stroke-width="1.2" vector-effect="non-scaling-stroke"/>` +
      `<path d="${path(flagged, max, false)}" fill="none" stroke="rgba(255,96,128,0.95)" stroke-width="1.2" vector-effect="non-scaling-stroke"/>`;

    const per = res === 'second' ? '/s' : '/min';
    const stat = (label: string, value: string, title = '') => h('div', { class: 'hstat', title }, h('span', { class: 'hstat-label' }, label), h('span', { class: 'hstat-value num' }, value));
    this.stats.replaceChildren(
      stat('Changes', sum.toLocaleString(), `${auto.toLocaleString()} automatic category updates are counted separately and not drawn`),
      stat('Flagged', sum ? `${flag.toLocaleString()} (${((flag / sum) * 100).toFixed(1)}%)` : '0'),
      stat(`Peak${per}`, peak ? `${peak.toLocaleString()} at ${clock(peakAt)}` : '–'),
    );

    const unit = res === 'second' ? 'second' : 'minute';
    // Seconds are the finest unit we report, so anything under one rounds to complete.
    const coverage = w.missingMs < 1000
      ? `Every ${unit} accounted for.`
      : `No data for ${formatDuration(w.missingMs)} of this window, before collection began or while it was offline.`;
    const source = src.historyState === 'loading'
      ? 'Loading the collector\'s history.'
      : src.historyState === 'loaded'
        ? `Collector history up to ${clock(src.history.boundary)}, replayed from Wikimedia since, live now.`
        : 'Collector history unavailable, so counting starts when you opened this page.';
    this.note.textContent = `${coverage} ${source}`;
  }
}
