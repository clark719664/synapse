import { Engine } from './app/engine';
import { css, healthColor, serviceColor } from './app/palette';
import { ForceLayout } from './layout/force';
import { parseTraces } from './model/parsers';
import { formatMs } from './model/stats';
import type { Trace } from './model/span';
import { GlRenderer } from './render/gl';
import { Overlay, type Hit } from './render/overlay';
import { View } from './render/view';
import { TrafficGenerator } from './sim/generator';
import { combine, SCENARIOS } from './sim/scenarios';
import { h } from './ui/dom';
import { Sidebar } from './ui/sidebar';
import { Topbar } from './ui/topbar';
import { Waterfall } from './ui/waterfall';
import './ui/styles.css';

function fatal(root: HTMLElement, err: unknown): void {
  root.replaceChildren(h('div', { class: 'fatal' }, h('div', { class: 'fatal-card' },
    h('h2', {}, "Synapse couldn't start"),
    h('p', { class: 'muted' }, 'This app needs WebGL2. Try a current Chrome, Edge, Firefox or Safari with hardware acceleration on.'),
    h('pre', {}, err instanceof Error ? err.message : String(err)),
  )));
}

function main(): void {
  const root = document.getElementById('app')!;
  const mapEl = h('div', { class: 'map' });
  const glCanvas = h('canvas', { class: 'gl', 'aria-hidden': 'true' });
  const overlayCanvas = h('canvas', { class: 'overlay', 'aria-label': 'Service map' });
  const grid = h('div', { class: 'grid' });
  const tip = h('div', { class: 'node-tip hidden' });
  const toast = h('div', { class: 'toast' });
  const dropzone = h('div', { class: 'dropzone hidden' }, 'Drop an OTLP, Jaeger or Zipkin JSON export');
  const legend = h('div', { class: 'legend' },
    h('span', {}, h('i', { style: 'color:#8cd2ff' }), 'request'),
    h('span', {}, h('i', { style: 'color:#ffc450' }), 'slow response'),
    h('span', {}, h('i', { style: 'color:#ff6060' }), 'error'),
  );
  const hint = h('div', { class: 'hint' }, 'drag to pan · wheel to zoom · click a service to filter · click a trace for its waterfall');

  let gl: GlRenderer;
  let overlay: Overlay;
  try {
    gl = new GlRenderer(glCanvas);
    overlay = new Overlay(overlayCanvas);
  } catch (err) {
    fatal(root, err);
    return;
  }

  const view = new View();
  const layout = new ForceLayout();
  // Keep re-framing while the graph is still growing/settling, until the user takes over.
  let autoFitUntil = performance.now() + 12_000;
  const armAutoFit = () => { autoFitUntil = performance.now() + 12_000; };
  const cancelAutoFit = () => { autoFitUntil = 0; };

  const engine = new Engine({
    onStructureChange: () => {
      layout.sync([...engine.topology.nodes.values()], [...engine.topology.edges.values()]);
      if (performance.now() < autoFitUntil) view.fit(layout.bounds(), 110);
    },
  });

  const params = new URLSearchParams(location.search);
  if (params.get('scenario')) for (const id of params.get('scenario')!.split(',')) if (SCENARIOS.some((s) => s.id === id)) engine.toggleScenario(id);
  if (params.get('rps')) engine.setRps(Number(params.get('rps')));

  let toastTimer = 0;
  const notify = (msg: string, isError = false) => {
    toast.textContent = msg;
    toast.classList.toggle('error', isError);
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('show'), isError ? 5000 : 2600);
  };

  const waterfall = new Waterfall({
    onClose: () => selectTrace(null),
    onHoverSpan: () => undefined,
  });

  const selectTrace = (t: Trace | null) => {
    engine.selectTrace(t);
    gl.highlightTrace = t?.traceId ?? null;
    if (t) waterfall.show(t); else waterfall.hide();
  };

  const sidebar = new Sidebar(engine, {
    onSelectTrace: (t) => selectTrace(engine.selectedTrace?.traceId === t.traceId ? null : t),
    onSelectService: (id) => engine.selectService(id),
  });

  const loadSpansAsReplay = (text: string, label: string) => {
    const result = parseTraces(text);
    const info = engine.loadReplay(result.spans);
    layout.sync([...engine.topology.nodes.values()], [...engine.topology.edges.values()]);
    armAutoFit();
    topbar.setMode('replay', label);
    selectTrace(null);
    notify(`Loaded ${info.traces} traces (${result.spans.length} spans, ${result.format.toUpperCase()})${result.skipped ? `, skipped ${result.skipped} malformed` : ''} · ${formatMs(info.end - info.start)} of activity`);
  };

  const importFile = async (file: File) => {
    try {
      loadSpansAsReplay(await file.text(), file.name);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    }
  };

  const topbar = new Topbar(engine, {
    onImportFile: (f) => void importFile(f),
    onLoadSample: () => {
      // Synthesize a deterministic 45-second incident and replay it: exercises the
      // exact same path as an imported file, without shipping a large fixture.
      const gen = new TrafficGenerator({ seed: 2024, rps: 10, startTime: 0 });
      const spans = gen.tick(15_000).flatMap((t) => t.spans);
      const c = combine([SCENARIOS[0]!]);
      gen.modifier = c.modifier;
      spans.push(...gen.tick(45_000).flatMap((t) => t.spans));
      engine.loadReplay(spans);
      layout.sync([...engine.topology.nodes.values()], [...engine.topology.edges.values()]);
      armAutoFit();
      topbar.setMode('replay', 'sample: payments incident');
      selectTrace(null);
      notify('Replaying a 45s sample: payments degrade at 0:15. Scrub the timeline or change speed.');
    },
    onGoLive: () => {
      engine.goLive();
      topbar.setMode('live');
      selectTrace(null);
      armAutoFit();
    },
    onFit: () => view.fit(layout.bounds(), 110),
    onSeek: (ms) => engine.seek(ms),
  });

  mapEl.append(grid, glCanvas, overlayCanvas, legend, hint, tip, waterfall.root, dropzone, toast);
  root.append(topbar.root, mapEl, sidebar.root);

  // ------------------------------------------------------------ interaction
  let dragging: { x: number; y: number; moved: number; node: string | null } | null = null;
  overlayCanvas.addEventListener('pointerdown', (e) => {
    const hit = overlay.hitTest(engine, layout, view, e.offsetX, e.offsetY);
    dragging = { x: e.clientX, y: e.clientY, moved: 0, node: hit?.kind === 'node' ? hit.id : null };
    overlayCanvas.setPointerCapture(e.pointerId);
    mapEl.classList.add('dragging');
  });
  overlayCanvas.addEventListener('pointermove', (e) => {
    if (dragging) {
      const dx = e.clientX - dragging.x;
      const dy = e.clientY - dragging.y;
      dragging.x = e.clientX; dragging.y = e.clientY;
      dragging.moved += Math.abs(dx) + Math.abs(dy);
      if (dragging.node) {
        const n = layout.nodes.get(dragging.node);
        if (n) { const [wx, wy] = view.toWorld(e.offsetX, e.offsetY); n.fx = wx; n.fy = wy; layout.alpha = Math.max(layout.alpha, 0.3); }
      } else {
        cancelAutoFit();
        view.panBy(dx, dy);
      }
      return;
    }
    const hit = overlay.hitTest(engine, layout, view, e.offsetX, e.offsetY);
    setHover(hit, e.offsetX, e.offsetY);
  });
  const endDrag = (e: PointerEvent) => {
    if (!dragging) return;
    const { moved, node } = dragging;
    if (node) { const n = layout.nodes.get(node); if (n) { n.fx = null; n.fy = null; } }
    dragging = null;
    mapEl.classList.remove('dragging');
    if (moved < 4) {
      const hit = overlay.hitTest(engine, layout, view, e.offsetX, e.offsetY);
      if (hit?.kind === 'node') engine.selectService(engine.selectedService === hit.id ? null : hit.id);
      else if (!hit) engine.selectService(null);
    }
  };
  overlayCanvas.addEventListener('pointerup', endDrag);
  overlayCanvas.addEventListener('pointercancel', endDrag);
  overlayCanvas.addEventListener('pointerleave', () => setHover(null, 0, 0));
  overlayCanvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    cancelAutoFit();
    view.zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });

  function setHover(hit: Hit, x: number, y: number): void {
    overlay.hover = hit;
    gl.hoverEdge = hit?.kind === 'edge' ? hit.id : null;
    overlayCanvas.style.cursor = hit ? 'pointer' : '';
    if (hit?.kind !== 'node') { tip.classList.add('hidden'); return; }
    const node = engine.topology.nodes.get(hit.id);
    if (!node) return;
    const now = engine.clock.now();
    const rps = node.requests.rate(now, 10);
    const err = rps > 0 ? node.errors.rate(now, 10) / rps : 0;
    const inbound = [...engine.topology.edges.values()].filter((e) => e.target === hit.id).map((e) => e.source);
    const outbound = [...engine.topology.edges.values()].filter((e) => e.source === hit.id).map((e) => e.target);
    tip.replaceChildren(
      h('h3', {}, h('i', { style: `background:${css(serviceColor(hit.id))}` }), hit.id, node.entry ? h('span', { class: 'pill pill-ok' }, 'ENTRY') : null),
      h('dl', {},
        h('dt', {}, 'throughput'), h('dd', {}, `${rps.toFixed(1)} rps`),
        h('dt', {}, 'error rate'), h('dd', { style: `color:${css(healthColor(err))}` }, `${(err * 100).toFixed(1)}%`),
        h('dt', {}, 'p50 / p95'), h('dd', {}, `${formatMs(node.latency.percentile(0.5))} / ${formatMs(node.latency.percentile(0.95))}`),
        h('dt', {}, 'called by'), h('dd', {}, inbound.join(', ') || '–'),
        h('dt', {}, 'calls'), h('dd', {}, outbound.join(', ') || '–'),
      ),
    );
    tip.classList.remove('hidden');
    const r = mapEl.getBoundingClientRect();
    tip.style.left = `${Math.min(x, r.width - 260)}px`;
    tip.style.top = `${Math.min(y, r.height - 160)}px`;
  }

  // Drag & drop import.
  let dragDepth = 0;
  mapEl.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; dropzone.classList.remove('hidden'); });
  mapEl.addEventListener('dragover', (e) => e.preventDefault());
  mapEl.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; dropzone.classList.add('hidden'); } });
  mapEl.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropzone.classList.add('hidden');
    const f = e.dataTransfer?.files[0];
    if (f) void importFile(f);
  });

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    switch (e.key) {
      case 'Escape': selectTrace(null); engine.selectService(null); break;
      case 'f': case 'F': view.fit(layout.bounds(), 110); break;
      case ' ': if (engine.mode === 'replay') { e.preventDefault(); topbar.togglePlay(); } break;
    }
  });

  // --------------------------------------------------------------- loop
  const resize = () => {
    const r = mapEl.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    view.resize(r.width, r.height);
    gl.resize(r.width, r.height, dpr);
    overlay.resize(r.width, r.height, dpr);
  };
  new ResizeObserver(resize).observe(mapEl);
  resize();

  let lastUi = 0;
  const frame = (t: number) => {
    const now = engine.update();
    layout.step();
    if (performance.now() < autoFitUntil && Math.floor(t / 700) !== Math.floor((t - 16) / 700)) view.fit(layout.bounds(), 110);
    view.animate();
    const dpr = window.devicePixelRatio || 1;
    gl.render(engine, layout, view, now, dpr);
    overlay.render(engine, layout, view, now, dpr);
    if (t - lastUi > 250) {
      sidebar.update(now);
      topbar.update(now);
      lastUi = t;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main();
