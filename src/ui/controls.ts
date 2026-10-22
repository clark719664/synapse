import type { Engine } from '../app/engine';
import { SCENARIOS } from '../sim/scenarios';
import { h } from './dom';

/** Floating panel on the map for the simulator: traffic level and incident injection. */
export class SimControls {
  readonly root: HTMLElement;
  private readonly chips = new Map<string, HTMLButtonElement>();

  constructor(private readonly engine: Engine) {
    const rpsLabel = h('span', { class: 'num' }, `${engine.generator.rps} rps`);
    const rps = h('input', { type: 'range', min: 1, max: 80, step: 1, value: engine.generator.rps, class: 'rps', 'aria-label': 'Simulated requests per second', onInput: (e: Event) => {
      const v = Number((e.target as HTMLInputElement).value);
      engine.setRps(v);
      rpsLabel.textContent = `${v} rps`;
    } });
    const chips = SCENARIOS.map((s) => {
      const chip = h('button', { class: `chip${engine.activeScenarios.has(s.id) ? ' is-active' : ''}`, title: s.description, 'aria-pressed': String(engine.activeScenarios.has(s.id)), onClick: () => {
        engine.toggleScenario(s.id);
        const on = engine.activeScenarios.has(s.id);
        chip.classList.toggle('is-active', on);
        chip.setAttribute('aria-pressed', String(on));
      } }, s.label);
      this.chips.set(s.id, chip);
      return chip;
    });
    this.root = h('section', { class: 'map-panel sim-panel' },
      h('label', { class: 'panel-row' }, h('span', { class: 'panel-label' }, 'Traffic'), rps, rpsLabel),
      h('div', { class: 'panel-label' }, 'Break something'),
      h('div', { class: 'chips' }, ...chips),
    );
  }

  /** Reflects incidents armed elsewhere (e.g. from the URL). */
  sync(): void {
    for (const [id, chip] of this.chips) {
      const on = this.engine.activeScenarios.has(id);
      chip.classList.toggle('is-active', on);
      chip.setAttribute('aria-pressed', String(on));
    }
  }
}

/** Short caption explaining how to read the live map. It folds into a small button once it has been read. */
export class FeedCaption {
  readonly root: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly opener: HTMLButtonElement;
  private timer = 0;

  constructor(private readonly onResize: () => void) {
    const link = h('a', { href: 'https://stream.wikimedia.org/?doc', target: '_blank', rel: 'noopener noreferrer' }, 'Wikimedia EventStreams');
    this.opener = h('button', { class: 'btn map-chip hidden', onClick: () => this.expand() }, 'How to read this map');
    this.panel = h('section', { class: 'map-panel feed-panel' },
      h('button', { class: 'panel-close', 'aria-label': 'Fold this note away', onClick: () => this.collapse() }, '✕'),
      h('p', { class: 'panel-title' }, 'Every change to every Wikimedia wiki, live'),
      h('p', { class: 'panel-copy' },
        'Each particle is one edit, new page or log action, flowing from who made it, through the wiki, to ',
        link,
        ', which delivered it here. Red marks reverts, blocks and deletions. Pages with coordinates also arc onto the globe.'),
    );
    this.panel.addEventListener('pointerenter', () => clearTimeout(this.timer));
    this.root = h('div', { class: 'map-corner' }, this.panel, this.opener);
  }

  /** Opens the note, then folds it away after `foldAfterMs` unless the pointer is resting on it. */
  expand(foldAfterMs = 0): void {
    this.panel.classList.remove('hidden');
    this.opener.classList.add('hidden');
    clearTimeout(this.timer);
    if (foldAfterMs) this.timer = window.setTimeout(() => this.collapse(), foldAfterMs);
    this.onResize();
  }

  collapse(): void {
    clearTimeout(this.timer);
    this.panel.classList.add('hidden');
    this.opener.classList.remove('hidden');
    this.onResize();
  }
}
