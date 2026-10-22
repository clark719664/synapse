import type { Engine } from '../app/engine';
import { SCENARIOS } from '../sim/scenarios';
import { h } from './dom';

export interface TopbarEvents {
  onImportFile: (file: File) => void;
  onLoadSample: () => void;
  onGoLive: () => void;
  onFit: () => void;
  onSeek: (ms: number) => void;
}

const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4];

/** Header: brand, source mode, incident chips, playback controls, import. */
export class Topbar {
  readonly root: HTMLElement;
  private readonly liveControls: HTMLElement;
  private readonly replayControls: HTMLElement;
  private readonly scrub: HTMLInputElement;
  private readonly timeLabel: HTMLElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly speedSel: HTMLSelectElement;
  private readonly rpsLabel: HTMLElement;
  private readonly chips: Map<string, HTMLButtonElement> = new Map();
  private readonly modeLabel: HTMLElement;
  private scrubbing = false;

  constructor(private readonly engine: Engine, events: TopbarEvents) {
    const file = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none', onChange: (e: Event) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (f) events.onImportFile(f);
      (e.target as HTMLInputElement).value = '';
    } });

    this.rpsLabel = h('span', { class: 'mono' }, `${engine.generator.rps}`);
    const rps = h('input', { type: 'range', min: 1, max: 80, step: 1, value: engine.generator.rps, class: 'rps', onInput: (e: Event) => {
      const v = Number((e.target as HTMLInputElement).value);
      engine.setRps(v);
      this.rpsLabel.textContent = String(v);
    } });

    for (const s of SCENARIOS) {
      const chip = h('button', { class: `chip${engine.activeScenarios.has(s.id) ? ' is-active' : ''}`, title: s.description, onClick: () => {
        engine.toggleScenario(s.id);
        chip.classList.toggle('is-active', engine.activeScenarios.has(s.id));
      } }, s.label);
      this.chips.set(s.id, chip);
    }

    this.liveControls = h('div', { class: 'group' },
      h('label', { class: 'inline' }, 'Traffic ', rps, this.rpsLabel, ' rps'),
      h('span', { class: 'sep' }),
      h('span', { class: 'muted' }, 'Inject:'),
      ...this.chips.values(),
    );

    this.playBtn = h('button', { class: 'btn', onClick: () => this.togglePlay() }, '❚❚');
    this.speedSel = h('select', { class: 'select', onChange: (e: Event) => { engine.clock.speed = Number((e.target as HTMLSelectElement).value); } },
      ...SPEEDS.map((s) => h('option', { value: s, selected: s === 1 }, `${s}×`)));
    this.scrub = h('input', { type: 'range', min: 0, max: 1000, step: 1, value: 0, class: 'scrub' });
    this.scrub.addEventListener('pointerdown', () => (this.scrubbing = true));
    this.scrub.addEventListener('change', () => {
      this.scrubbing = false;
      const r = engine.replayRange;
      if (r) events.onSeek(r.start + (Number(this.scrub.value) / 1000) * (r.end - r.start));
    });
    this.timeLabel = h('span', { class: 'mono muted' }, '0.0s');
    this.replayControls = h('div', { class: 'group hidden' },
      this.playBtn,
      this.speedSel,
      this.scrub,
      this.timeLabel,
      h('button', { class: 'btn btn-ghost', onClick: () => events.onGoLive() }, '← Back to live'),
    );

    this.modeLabel = h('span', { class: 'mode-pill live' }, 'LIVE · simulated');

    this.root = h('header', { class: 'topbar' },
      h('div', { class: 'brand' },
        h('span', { class: 'brand-mark' }),
        h('h1', {}, 'Synapse'),
        this.modeLabel,
      ),
      this.liveControls,
      this.replayControls,
      h('div', { class: 'group right' },
        h('button', { class: 'btn btn-ghost', onClick: () => events.onFit(), title: 'Fit graph (F)' }, 'Fit'),
        h('button', { class: 'btn btn-ghost', onClick: () => events.onLoadSample(), title: 'Load a bundled OTLP export' }, 'Sample'),
        h('button', { class: 'btn btn-accent', onClick: () => file.click(), title: 'OTLP/JSON, Jaeger or Zipkin v2' }, 'Import JSON'),
        file,
      ),
    );
  }

  togglePlay(): void {
    if (this.engine.clock.isPaused) this.engine.clock.resume();
    else this.engine.clock.pause();
    this.playBtn.textContent = this.engine.clock.isPaused ? '▶' : '❚❚';
  }

  setMode(mode: 'live' | 'replay', label?: string): void {
    this.liveControls.classList.toggle('hidden', mode !== 'live');
    this.replayControls.classList.toggle('hidden', mode !== 'replay');
    this.modeLabel.textContent = mode === 'live' ? 'LIVE · simulated' : `REPLAY · ${label ?? 'file'}`;
    this.modeLabel.classList.toggle('live', mode === 'live');
    this.playBtn.textContent = this.engine.clock.isPaused ? '▶' : '❚❚';
  }

  update(now: number): void {
    const r = this.engine.replayRange;
    if (this.engine.mode !== 'replay' || !r) return;
    const span = Math.max(1, r.end - r.start);
    if (!this.scrubbing) this.scrub.value = String(Math.max(0, Math.min(1000, ((now - r.start) / span) * 1000)));
    this.timeLabel.textContent = `${Math.max(0, (now - r.start) / 1000).toFixed(1)}s / ${(span / 1000).toFixed(1)}s`;
  }
}
