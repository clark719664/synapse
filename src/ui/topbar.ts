import type { Engine, SourceMode } from '../app/engine';
import { h } from './dom';

export type LiveSource = 'wikipedia' | 'sim';
export type StatusTone = 'ok' | 'warn' | 'bad' | 'sim' | 'muted';

export interface TopbarEvents {
  onSource: (source: LiveSource) => void;
  onImportFile: (file: File) => void;
  onLoadSample: () => void;
  onBackToLive: () => void;
  onFit: () => void;
  onTidy: (on: boolean) => void;
  onSeek: (ms: number) => void;
}

const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4];

/** Header: brand, source switcher, connection status, playback controls, import. */
export class Topbar {
  readonly root: HTMLElement;
  private readonly replayControls: HTMLElement;
  private readonly scrub: HTMLInputElement;
  private readonly timeLabel: HTMLElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly status: HTMLElement;
  private readonly statusText: HTMLElement;
  private readonly sourceButtons: Map<LiveSource, HTMLButtonElement> = new Map();
  private scrubbing = false;
  private tidyBtn!: HTMLButtonElement;

  constructor(private readonly engine: Engine, private readonly events: TopbarEvents) {
    const file = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none', onChange: (e: Event) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (f) events.onImportFile(f);
      (e.target as HTMLInputElement).value = '';
    } });

    const sources: [LiveSource, string, string][] = [
      ['wikipedia', 'Wikipedia live', 'Every change on every Wikimedia wiki, streamed as it happens'],
      ['sim', 'Simulator', 'A simulated 17-service e-commerce backend you can break on purpose'],
    ];
    const switcher = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Data source' },
      ...sources.map(([id, label, title]) => {
        const b = h('button', { class: 'seg', title, 'aria-pressed': 'false', onClick: () => events.onSource(id) }, label);
        this.sourceButtons.set(id, b);
        return b;
      }));

    this.statusText = h('span', {}, '');
    this.status = h('span', { class: 'status', role: 'status' }, h('i', { class: 'status-dot' }), this.statusText);

    this.playBtn = h('button', { class: 'btn btn-icon', onClick: () => this.togglePlay(), 'aria-label': 'Pause' }, '❚❚');
    const speedSel = h('select', { class: 'select', 'aria-label': 'Playback speed', onChange: (e: Event) => { engine.clock.speed = Number((e.target as HTMLSelectElement).value); } },
      ...SPEEDS.map((s) => h('option', { value: s, selected: s === 1 }, `${s}×`)));
    this.scrub = h('input', { type: 'range', min: 0, max: 1000, step: 1, value: 0, class: 'scrub', 'aria-label': 'Replay position' });
    this.scrub.addEventListener('pointerdown', () => (this.scrubbing = true));
    this.scrub.addEventListener('change', () => {
      this.scrubbing = false;
      const r = engine.replayRange;
      if (r) events.onSeek(r.start + (Number(this.scrub.value) / 1000) * (r.end - r.start));
    });
    this.timeLabel = h('span', { class: 'num muted time' }, '0.0s');
    this.replayControls = h('div', { class: 'group hidden' },
      this.playBtn,
      speedSel,
      this.scrub,
      this.timeLabel,
      h('button', { class: 'btn btn-ghost', onClick: () => events.onBackToLive() }, 'Back to live'),
    );

    this.root = h('header', { class: 'topbar' },
      h('div', { class: 'brand' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }), h('h1', {}, 'Synapse')),
      switcher,
      this.status,
      this.replayControls,
      h('div', { class: 'group right' },
        this.tidyBtn = h('button', { class: 'btn btn-ghost btn-toggle', 'aria-pressed': 'true', title: 'Tidy columns, or free force-directed layout (L)', onClick: () => this.toggleTidy() }, 'Tidy layout'),
        h('button', { class: 'btn btn-ghost', onClick: () => events.onFit(), title: 'Fit the map to the window (F)' }, 'Fit'),
        h('button', { class: 'btn btn-ghost', onClick: () => events.onLoadSample(), title: 'Replay a 45-second simulated incident' }, 'Sample'),
        h('button', { class: 'btn btn-accent', onClick: () => file.click(), title: 'OTLP/JSON, Jaeger or Zipkin v2' }, 'Import JSON'),
        file,
      ),
    );
  }

  toggleTidy(): void {
    const on = this.tidyBtn.getAttribute('aria-pressed') !== 'true';
    this.tidyBtn.setAttribute('aria-pressed', String(on));
    this.events.onTidy(on);
  }

  togglePlay(): void {
    if (this.engine.clock.isPaused) this.engine.clock.resume();
    else this.engine.clock.pause();
    this.syncPlay();
  }

  private syncPlay(): void {
    const paused = this.engine.clock.isPaused;
    this.playBtn.textContent = paused ? '▶' : '❚❚';
    this.playBtn.setAttribute('aria-label', paused ? 'Play' : 'Pause');
  }

  setMode(mode: SourceMode, label?: string): void {
    this.replayControls.classList.toggle('hidden', mode !== 'replay');
    for (const [id, b] of this.sourceButtons) {
      const on = (id === 'wikipedia' && mode === 'feed') || (id === 'sim' && mode === 'sim');
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', String(on));
    }
    if (mode === 'sim') this.setStatus('Simulated traffic', 'sim');
    if (mode === 'replay') this.setStatus(`Replay of ${label ?? 'a file'}`, 'muted');
    this.syncPlay();
  }

  setStatus(text: string, tone: StatusTone, title = ''): void {
    if (this.statusText.textContent !== text) this.statusText.textContent = text;
    this.status.dataset.tone = tone;
    this.status.title = title;
  }

  update(now: number): void {
    const r = this.engine.replayRange;
    if (this.engine.mode !== 'replay' || !r) return;
    const span = Math.max(1, r.end - r.start);
    if (!this.scrubbing) this.scrub.value = String(Math.max(0, Math.min(1000, ((now - r.start) / span) * 1000)));
    this.timeLabel.textContent = `${Math.max(0, (now - r.start) / 1000).toFixed(1)}s of ${(span / 1000).toFixed(1)}s`;
  }
}
