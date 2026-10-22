import { Engine, type Vocabulary } from './app/engine';
import { css, ERROR_PARTICLE, healthColor, mix, OK_PARTICLE, serviceColor, SLOW_PARTICLE, type RGB } from './app/palette';
import { GlobeView } from './geo/globe';
import { ForceLayout, type ForceOptions } from './layout/force';
import { layeredTargets, type LayeredOptions } from './layout/layered';
import type { GeoEvent } from './live/geo';
import type { FeedStatus } from './live/feed';
import { formatRatio, WikipediaSource } from './live/source';
import { parseTraces } from './model/parsers';
import { formatMs } from './model/stats';
import type { Trace } from './model/span';
import { GEO_LINGER_MS, GlRenderer } from './render/gl';
import { nodeRadius } from './render/metrics';
import { Overlay, rateText, type Hit } from './render/overlay';
import { View } from './render/view';
import { TrafficGenerator } from './sim/generator';
import { combine, SCENARIOS } from './sim/scenarios';
import { FeedCaption, SimControls } from './ui/controls';
import { HistoryCard } from './ui/history';
import { h } from './ui/dom';
import { Sidebar } from './ui/sidebar';
import { Topbar, type LiveSource, type StatusTone } from './ui/topbar';
import { Waterfall } from './ui/waterfall';
import './ui/styles.css';

/** The live map spreads hosts into a cloud between editors and the stream instead of one tall column. */
const FEED_LAYOUT: Partial<ForceOptions> = { columnGap: 360, columnBand: 300, columnPull: 0.35, repulsion: 30000, restLength: 190, centerPull: 0.02 };
const NARROW_FEED_LAYOUT: Partial<ForceOptions> = { ...FEED_LAYOUT, columnGap: 220, columnBand: 170, repulsion: 22000, restLength: 140 };
const NARROW_TIDY: Partial<LayeredOptions> = { columnGap: 170, subColumnGap: 130, rowGap: 74, maxRows: 9 };

function fatal(root: HTMLElement, err: unknown): void {
  root.replaceChildren(h('div', { class: 'fatal' }, h('div', { class: 'fatal-card' },
    h('h2', {}, "Synapse couldn't start"),
    h('p', { class: 'muted' }, 'This app needs WebGL2. Try a current Chrome, Edge, Firefox or Safari with hardware acceleration on.'),
    h('pre', {}, err instanceof Error ? err.message : String(err)),
  )));
}

function feedStatus(s: FeedStatus, now: number, loadingHistory: boolean): [string, StatusTone, string] {
  if (loadingHistory) return ['Loading history', 'warn', "Fetching the always-on collector's snapshot, then replaying the stream from where it ends."];
  const secs = (ms: number) => Math.max(1, Math.ceil(ms / 1000));
  switch (s.state) {
    case 'connecting':
      return [s.attempts > 1 ? `Reconnecting, attempt ${s.attempts}` : 'Connecting to Wikimedia', 'warn', 'Opening stream.wikimedia.org/v2/stream/recentchange'];
    case 'live':
      return ['Live from Wikimedia', 'ok', `${s.received.toLocaleString()} events received from stream.wikimedia.org. Each change is drawn the moment it arrives; history from before you opened the page only feeds the counts.`];
    case 'stalled':
      return [`No events for ${secs(now - (s.lastEventAt ?? s.since))} s`, 'warn', 'The stream is open but silent. Synapse reconnects automatically after 30 s.'];
    case 'disconnected':
      return [s.retryAt ? `Disconnected, retrying in ${secs(s.retryAt - now)} s` : 'Disconnected', 'bad', 'The connection to stream.wikimedia.org dropped or could not be opened.'];
    case 'paused':
      return ['Paused while this tab is hidden', 'muted', 'The stream disconnects while you are away and resumes when you come back.'];
  }
}

function main(): void {
  const root = document.getElementById('app')!;
  const mapEl = h('div', { class: 'map' });
  const glCanvas = h('canvas', { class: 'gl', 'aria-hidden': 'true' });
  const overlayCanvas = h('canvas', { class: 'overlay', 'aria-label': 'Service map' });
  const tip = h('div', { class: 'node-tip hidden' });
  const toast = h('div', { class: 'toast', role: 'status' });
  const dropzone = h('div', { class: 'dropzone hidden' }, 'Drop an OTLP, Jaeger or Zipkin JSON export');
  const legend = h('div', { class: 'legend' });
  const hint = h('div', { class: 'hint' }, 'Drag to pan, scroll to zoom, click a node to filter, click a row for its waterfall');

  let gl: GlRenderer;
  let overlay: Overlay;
  try {
    gl = new GlRenderer(glCanvas);
    overlay = new Overlay(overlayCanvas);
  } catch (err) {
    fatal(root, err);
    return;
  }

  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const view = new View();
  const globe = new GlobeView();
  gl.globe = overlay.globe = globe;
  const applyMotion = () => {
    gl.reducedMotion = overlay.reducedMotion = view.instant = motionQuery.matches;
  };
  applyMotion();
  motionQuery.addEventListener('change', applyMotion);

  const layout = new ForceLayout();
  const SIM_LAYOUT: ForceOptions = { ...layout.options };
  // Keep re-framing while the graph is still growing/settling, until the user takes over.
  let autoFitUntil = performance.now() + 12_000;
  const armAutoFit = (ms = 12_000) => { autoFitUntil = performance.now() + ms; };
  const cancelAutoFit = () => { autoFitUntil = 0; };
  const panelInset = () => {
    const panel = [simControls.root, feedCaption.root].find((p) => !p.classList.contains('hidden'));
    return panel ? panel.offsetTop + panel.offsetHeight : 0;
  };
  let globeBelow = false;
  // Horizontal padding leaves room for the labels centred under the outermost nodes.
  const fit = () => view.fit(layout.bounds(), globe.visible ? { x: 96, y: 64 } : { x: 110, y: 90 }, {
    top: panelInset(),
    right: globe.visible && !globeBelow ? view.width - (globe.cx - globe.r * 1.3) : 0,
    bottom: globe.visible && globeBelow ? view.height - (globe.cy - globe.r * 1.3) : 0,
  });

  let tidy = true;
  let lastRetarget = 0;
  /** Recomputes the tidy layout's slots: columns by depth, ordered to cut crossings, busiest first on ties. */
  const retarget = () => {
    lastRetarget = performance.now();
    if (!tidy) { layout.targets = null; return; }
    const now = engine.clock.now();
    layout.targets = layeredTargets(
      [...engine.topology.nodes.values()],
      [...engine.topology.edges.values()],
      (id) => engine.topology.nodes.get(id)?.requests.rate(now, 10) ?? 0,
      mapEl.clientWidth < 820 ? NARROW_TIDY : {},
    );
  };

  const engine = new Engine({
    onStructureChange: () => {
      layout.sync([...engine.topology.nodes.values()], [...engine.topology.edges.values()]);
      retarget();
      if (performance.now() < autoFitUntil) fit();
    },
  });

  let toastTimer = 0;
  const notify = (msg: string, isError = false) => {
    toast.textContent = msg;
    toast.classList.toggle('error', isError);
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('show'), isError ? 6000 : 3200);
  };

  const wiki = new WikipediaSource(engine, (b) => {
    notify(`Burst on ${b.key}: ${b.rate.toFixed(1)} changes/s, ${formatRatio(b.rate / b.baseline)} its usual pace`);
  });

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
  sidebar.bursts = wiki.bursts;
  gl.geo = overlay.geo = wiki.located.events;
  gl.cells = { [Symbol.iterator]: () => wiki.cells.values() };
  const historyCard = new HistoryCard();
  sidebar.root.insertBefore(historyCard.root, sidebar.root.children[1] ?? null);

  const simControls = new SimControls(engine);
  const feedCaption = new FeedCaption(() => { if (performance.now() < autoFitUntil) fit(); });
  const globeTitle = h('p', { class: 'globe-title' }, 'Where the edited pages are');
  const globeMeta = h('p', { class: 'globe-meta' }, '');
  const globeCaption = h('div', { class: 'globe-caption hidden' }, globeTitle, globeMeta);

  /** In live mode, wide maps get a globe on the right; the network is framed in the space left of it. */
  const placeGlobe = () => {
    const r = mapEl.getBoundingClientRect();
    globe.visible = engine.mode === 'feed' && r.width >= 300 && r.height >= 420;
    globeCaption.classList.toggle('hidden', !globe.visible);
    if (!globe.visible) return;
    // Wide maps put the globe on the right; narrow (phone) maps stack it under the network.
    globeBelow = r.width < 820;
    if (globeBelow) {
      globe.r = Math.round(Math.max(90, Math.min(r.width * 0.36, r.height * 0.2)));
      globe.cx = Math.round(r.width / 2);
      globe.cy = Math.round(r.height - globe.r * 1.15 - 150);
    } else {
      globe.r = Math.round(Math.max(120, Math.min(r.width * 0.165, (r.height - 150) * 0.38)));
      globe.cx = Math.round(r.width - globe.r * 1.3 - 20);
      globe.cy = Math.round(r.height * 0.5 - 6);
    }
    const capW = Math.min(globe.r * 2.4, r.width - 24);
    globeCaption.style.left = `${Math.max(12, globe.cx - capW / 2)}px`;
    globeCaption.style.width = `${capW}px`;
    globeCaption.style.top = `${globe.cy + globe.r * 1.12}px`;
  };

  const updateGlobeCaption = (now: number) => {
    let pinned = 0;
    for (const ev of wiki.located.events) if (ev.at <= now && now - ev.at <= GEO_LINGER_MS) pinned++;
    let placed = 0;
    for (const c of wiki.cells.values()) placed += c[2];
    // The collector keeps whole hours; its oldest is 24 hours before the hour holding the boundary.
    const windowStart = (Math.floor(wiki.history.boundary / 3_600_000) - 24) * 3_600_000;
    const firstCovered = wiki.history.coverage[0]?.[0];
    // Never claim more than was collected: the window starts at whichever is later, 24 hours ago or the first data.
    const since = firstCovered === undefined ? null : Math.max(windowStart, firstCovered);
    const window = since ? `since ${new Date(since).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : 'since you opened this page';
    globeMeta.textContent = wiki.geo.lastError
      ? `Location lookups paused: ${wiki.geo.lastError}. Retrying shortly.`
      : `${placed.toLocaleString()} edits to geotagged pages ${window}; ${pinned} pinned in the last 10 minutes. Only pages with coordinates can be placed; where editors are is never published.`;
  };

  const setLegend = (v: Vocabulary) => {
    const dot = (c: RGB, label: string) => h('span', {}, h('i', { style: `color:${css(c)}` }), label);
    legend.replaceChildren(dot(mix(OK_PARTICLE, [255, 255, 255], 0.1), v.request), dot(SLOW_PARTICLE, v.slow), dot(ERROR_PARTICLE, v.error === 'flagged' ? 'revert, block or deletion' : v.error));
  };

  let liveSource: LiveSource = 'wikipedia';
  const startLive = (source: LiveSource) => {
    liveSource = source;
    selectTrace(null);
    Object.assign(layout.options, SIM_LAYOUT, source === 'wikipedia' ? (mapEl.clientWidth < 820 ? NARROW_FEED_LAYOUT : FEED_LAYOUT) : {});
    if (source === 'wikipedia') {
      wiki.start();
      topbar.setMode('feed');
    } else {
      wiki.stop();
      engine.goSim();
      topbar.setMode('sim');
    }
    simControls.root.classList.toggle('hidden', source !== 'sim');
    simControls.sync();
    feedCaption.root.classList.toggle('hidden', source !== 'wikipedia');
    // On a phone the note would leave the network no room, so it starts folded.
    if (source === 'wikipedia') { if (mapEl.clientWidth < 820) feedCaption.collapse(); else feedCaption.expand(25_000); }
    placeGlobe();
    setLegend(engine.vocab);
    // The live map keeps changing shape as wikis come and go, so it keeps re-framing until the user pans or zooms.
    armAutoFit(source === 'wikipedia' ? Infinity : 12_000);
  };

  const enterReplay = (label: string) => {
    wiki.stop();
    Object.assign(layout.options, SIM_LAYOUT);
    layout.sync([...engine.topology.nodes.values()], [...engine.topology.edges.values()]);
    simControls.root.classList.add('hidden');
    feedCaption.root.classList.add('hidden');
    placeGlobe();
    setLegend(engine.vocab);
    armAutoFit();
    topbar.setMode('replay', label);
    selectTrace(null);
  };

  const loadSpansAsReplay = (text: string, label: string) => {
    const result = parseTraces(text);
    const info = engine.loadReplay(result.spans);
    enterReplay(label);
    notify(`Loaded ${info.traces} traces (${result.spans.length} spans, ${result.format.toUpperCase()})${result.skipped ? `, skipped ${result.skipped} malformed` : ''}, ${formatMs(info.end - info.start)} of activity`);
  };

  const importFile = async (file: File) => {
    try {
      loadSpansAsReplay(await file.text(), file.name);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    }
  };

  const topbar = new Topbar(engine, {
    onSource: (s) => startLive(s),
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
      enterReplay('the payments incident sample');
      notify('Replaying a 45 s sample: payments degrade at 0:15. Scrub the timeline or change speed.');
    },
    onBackToLive: () => startLive(liveSource),
    onFit: fit,
    onTidy: (on) => {
      tidy = on;
      if (!on) layout.alpha = 1;
      retarget();
      armAutoFit(3000);
    },
    onSeek: (ms) => engine.seek(ms),
  });

  mapEl.append(glCanvas, overlayCanvas, simControls.root, feedCaption.root, globeCaption, legend, hint, tip, waterfall.root, dropzone, toast);
  root.append(topbar.root, mapEl, sidebar.root);

  const params = new URLSearchParams(location.search);
  const scenarios = (params.get('scenario') ?? '').split(',').filter((id) => SCENARIOS.some((s) => s.id === id));
  for (const id of scenarios) engine.toggleScenario(id);
  if (params.get('rps')) engine.setRps(Number(params.get('rps')));
  const wantsSim = params.get('source') === 'sim' || scenarios.length > 0 || params.has('rps');
  startLive(wantsSim ? 'sim' : 'wikipedia');
  if (import.meta.env.DEV) Object.assign(window, { __synapse: { engine, wiki } });

  // A tab hidden for a moment keeps streaming; one left in the background disconnects, and on return the
  // stream replays from the last change counted, so history stays exact either way.
  let hideTimer = 0;
  document.addEventListener('visibilitychange', () => {
    clearTimeout(hideTimer);
    if (engine.mode !== 'feed') return;
    if (document.hidden) hideTimer = window.setTimeout(() => wiki.pause(), 30_000);
    else if (wiki.status().state === 'paused') wiki.resume();
  });

  // ------------------------------------------------------------ interaction
  let dragging: { x: number; y: number; moved: number; node: string | null; globe: boolean } | null = null;
  overlayCanvas.addEventListener('pointerdown', (e) => {
    const onGlobe = globe.contains(e.offsetX, e.offsetY);
    const hit = onGlobe ? null : overlay.hitTest(engine, layout, view, e.offsetX, e.offsetY);
    dragging = { x: e.clientX, y: e.clientY, moved: 0, node: hit?.kind === 'node' ? hit.id : null, globe: onGlobe };
    overlayCanvas.setPointerCapture(e.pointerId);
    mapEl.classList.add('dragging');
  });
  overlayCanvas.addEventListener('pointermove', (e) => {
    if (dragging) {
      const dx = e.clientX - dragging.x;
      const dy = e.clientY - dragging.y;
      dragging.x = e.clientX; dragging.y = e.clientY;
      dragging.moved += Math.abs(dx) + Math.abs(dy);
      if (dragging.globe) {
        globe.drag(dx, dy, performance.now());
        tip.classList.add('hidden');
      } else if (dragging.node) {
        const n = layout.nodes.get(dragging.node);
        if (n) { const [wx, wy] = view.toWorld(e.offsetX, e.offsetY); n.fx = wx; n.fy = wy; layout.alpha = Math.max(layout.alpha, 0.3); }
      } else {
        cancelAutoFit();
        view.panBy(dx, dy);
      }
      return;
    }
    if (globe.contains(e.offsetX, e.offsetY)) {
      setHover(null, 0, 0);
      showPin(pinAt(e.offsetX, e.offsetY), e.offsetX, e.offsetY);
      return;
    }
    const hit = overlay.hitTest(engine, layout, view, e.offsetX, e.offsetY);
    setHover(hit, e.offsetX, e.offsetY);
  });
  const endDrag = (e: PointerEvent) => {
    if (!dragging) return;
    const { moved, node, globe: onGlobe } = dragging;
    if (node) { const n = layout.nodes.get(node); if (n) { n.fx = null; n.fy = null; } }
    dragging = null;
    mapEl.classList.remove('dragging');
    if (moved < 4 && onGlobe) {
      const pin = pinAt(e.offsetX, e.offsetY);
      const trace = pin && engine.recentTraces.find((t) => t.traceId === pin.traceId);
      if (trace) selectTrace(trace);
    } else if (moved < 4) {
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

  const pinAt = (sx: number, sy: number): GeoEvent | null => {
    const now = engine.clock.now();
    const p: [number, number, number] = [0, 0, 0];
    let best: GeoEvent | null = null;
    let bestD = 10;
    for (const ev of wiki.located.events) {
      if (ev.at > now || now - ev.at > GEO_LINGER_MS) continue;
      globe.project(ev.lat, ev.lon, p);
      const d = Math.hypot(p[0] - sx, p[1] - sy);
      if (p[2] > 0 && d <= bestD) { bestD = d; best = ev; }
    }
    return best;
  };

  function showPin(ev: GeoEvent | null, x: number, y: number): void {
    overlayCanvas.style.cursor = ev ? 'pointer' : 'grab';
    if (!ev) { tip.classList.add('hidden'); return; }
    const hasTrace = engine.recentTraces.some((t) => t.traceId === ev.traceId);
    tip.replaceChildren(
      h('h3', {}, h('i', { style: `background:${css(ev.flagged ? ERROR_PARTICLE : serviceColor(ev.editor))}` }), h('span', { class: 'name' }, ev.title)),
      h('dl', {},
        h('dt', {}, 'Wiki'), h('dd', {}, ev.host),
        h('dt', {}, 'Edited by'), h('dd', {}, ev.editor === 'bots' ? 'a bot' : ev.editor === 'anonymous' ? 'a logged-out editor' : 'a registered editor'),
        h('dt', {}, 'Location'), h('dd', {}, `${Math.abs(ev.lat).toFixed(2)}°${ev.lat >= 0 ? 'N' : 'S'}, ${Math.abs(ev.lon).toFixed(2)}°${ev.lon >= 0 ? 'E' : 'W'}`),
      ),
    );
    if (ev.flagged) tip.append(h('p', { class: 'tip-alert' }, 'A revert, block or deletion'));
    if (hasTrace) tip.append(h('p', { class: 'tip-hint' }, 'Click to open its trace'));
    tip.classList.remove('hidden');
    const r = mapEl.getBoundingClientRect();
    tip.style.left = `${Math.max(0, Math.min(x, r.width - 300))}px`;
    tip.style.top = `${Math.max(0, Math.min(y, r.height - tip.offsetHeight - 24))}px`;
  }

  const list = (ids: string[]) => (ids.length > 5 ? `${ids.slice(0, 5).join(', ')} and ${ids.length - 5} more` : ids.join(', ') || '–');

  function setHover(hit: Hit, x: number, y: number): void {
    overlay.hover = hit;
    gl.hoverEdge = hit?.kind === 'edge' ? hit.id : null;
    overlayCanvas.style.cursor = hit ? 'pointer' : '';
    if (hit?.kind !== 'node') { tip.classList.add('hidden'); return; }
    const node = engine.topology.nodes.get(hit.id);
    if (!node) return;
    const v = engine.vocab;
    const now = engine.clock.now();
    const rps = node.requests.rate(now, 10);
    const err = rps > 0 ? node.errors.rate(now, 10) / rps : 0;
    const p95 = node.latency.percentile(0.95);
    const inbound = [...engine.topology.edges.values()].filter((e) => e.target === hit.id).map((e) => e.source);
    const outbound = [...engine.topology.edges.values()].filter((e) => e.source === hit.id).map((e) => e.target);
    const alert = engine.alerts.get(hit.id);
    tip.replaceChildren(
      h('h3', {}, h('i', { style: `background:${css(serviceColor(hit.id))}` }), h('span', { class: 'name' }, hit.id), node.entry ? h('span', { class: 'pill pill-ok' }, 'Entry') : null),
      h('dl', {},
        h('dt', {}, 'Throughput'), h('dd', {}, rateText(rps, v.unit)),
        h('dt', {}, v.errors), h('dd', { style: `color:${css(healthColor(err))}` }, `${(err * 100).toFixed(1)}%`),
        p95 > 0 ? h('dt', {}, `${v.latency ? `${v.latency} ` : ''}p50 / p95`) : null,
        p95 > 0 ? h('dd', {}, `${formatMs(node.latency.percentile(0.5))} / ${formatMs(p95)}`) : null,
        h('dt', {}, 'From'), h('dd', {}, list(inbound)),
        h('dt', {}, 'To'), h('dd', {}, list(outbound)),
      ),
    );
    if (alert) tip.append(h('p', { class: 'tip-alert' }, alert.detail));
    tip.classList.remove('hidden');
    const r = mapEl.getBoundingClientRect();
    tip.style.left = `${Math.max(0, Math.min(x, r.width - 300))}px`;
    tip.style.top = `${Math.max(0, Math.min(y, r.height - tip.offsetHeight - 24))}px`;
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
      case 'f': case 'F': fit(); break;
      case 'l': case 'L': topbar.toggleTidy(); break;
      case ' ': if (engine.mode === 'replay') { e.preventDefault(); topbar.togglePlay(); } break;
    }
  });

  // --------------------------------------------------------------- loop
  const resize = () => {
    placeGlobe();
    const r = mapEl.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    view.resize(r.width, r.height);
    gl.resize(r.width, r.height, dpr);
    overlay.resize(r.width, r.height, dpr);
  };
  new ResizeObserver(resize).observe(mapEl);
  resize();

  let lastUi = 0;
  let lastFrame = performance.now();
  const frame = (t: number) => {
    const now = engine.update();
    for (const node of engine.topology.nodes.values()) {
      const p = layout.nodes.get(node.id);
      if (p) p.radius = nodeRadius(node.requests.rate(now, 10));
    }
    globe.advance(t - lastFrame, t, !motionQuery.matches);
    lastFrame = t;
    layout.step();
    if (performance.now() < autoFitUntil && Math.floor(t / 700) !== Math.floor((t - 16) / 700)) fit();
    view.animate();
    const dpr = window.devicePixelRatio || 1;
    gl.render(engine, layout, view, now, dpr, t / 1000);
    overlay.render(engine, layout, view, now, dpr, t / 1000);
    if (t - lastUi > 250) {
      if (engine.mode === 'feed') {
        wiki.tick(Date.now());
        const [text, tone, title] = feedStatus(wiki.status(), Date.now(), wiki.historyState === 'loading');
        topbar.setStatus(text, tone, title);
        updateGlobeCaption(now);
        historyCard.update(wiki, true, Date.now());
      } else {
        historyCard.update(wiki, false, 0);
      }
      if (performance.now() - lastRetarget > 12_000) {
        retarget();
      }
      sidebar.bursts = wiki.bursts;
      sidebar.update(now);
      topbar.update(now);
      lastUi = t;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main();
