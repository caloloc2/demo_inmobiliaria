import * as maplibregl from 'maplibre-gl';
import type { Fix } from './gps';
import { bearing, project } from '../nav/geom';
import { fetchRoute, formatDuration, straightRoute, type Mode, type Route } from '../nav/route';
import { Simulator } from '../nav/simulator';
import { distanceM, formatDistance } from '../properties/geo';
import { TYPE_LABEL, formatPrice, typeIcon } from '../properties/format';
import type { LatLng, Property } from '../properties/types';

type State = 'idle' | 'preview' | 'navigating';
/** drive: vista 3D como si condujeras · overview: mapa 2D con el norte arriba. */
type View = 'drive' | 'overview';

export interface NavDeps {
  map: maplibregl.Map;
  /** Origen de la ruta: GPS actual, o la zona de ejemplo si no hay GPS. */
  getOrigin(): LatLng;
  /** Se llama al entrar/salir de la vista de ruta para ocultar/mostrar el resto de la UI. */
  onActiveChange(active: boolean): void;
  /** Mueve el marcador del usuario (lo usa el simulador). */
  onSimFix(f: Fix): void;
  /** Se llama al iniciar una simulación (para volver a permitir las alertas de cercanía). */
  onSimStart?(): void;
}

const SIM_SPEEDS: Record<Mode, number[]> = { driving: [12, 25, 40], foot: [3, 6, 12] };
const OFF_ROUTE_M = 50;
const ARRIVAL_M = 25;

const LANE_ARROW: Record<string, string> = {
  left: '↰', 'slight left': '↖', 'sharp left': '↰', straight: '↑', 'slight right': '↗', 'sharp right': '↱', right: '↱', uturn: '↩', none: '↑',
};
const laneHtml = (lanes?: { valid: boolean; indications: string[] }[]) =>
  lanes?.length
    ? `<div class="lanes">${lanes.map((l) => `<span class="lane ${l.valid ? 'valid' : ''}">${l.indications.map((i) => LANE_ARROW[i] ?? '↑').join('')}</span>`).join('')}</div>`
    : '';

const angleDiff = (from: number, to: number) => ((to - from + 540) % 360) - 180;

export function createNavigation(deps: NavDeps) {
  const { map } = deps;
  const navbar = document.getElementById('navbar')!;
  const panel = document.getElementById('routepanel')!;
  const speedEl = document.getElementById('speed')!;
  const streetEl = document.getElementById('street')!;
  const compassEl = document.getElementById('compass')!;

  let state: State = 'idle';
  let view: View = 'drive';
  let dest: Property | null = null;
  let mode: Mode = 'driving';
  let route: Route | null = null;
  let sim: Simulator | null = null;
  let simSpeedIdx = 0;
  let hint = 0;
  let offCount = 0;
  let lastReroute = 0;
  let camBearing = 0;
  let prevFix: LatLng | null = null;
  let abort: AbortController | null = null;
  let wakeLock: WakeLockSentinel | null = null;
  let arrived = false;
  let lastSpeedKmh: number | null = null;

  // --- Capas: ruta (negra por recorrer, celeste ya recorrida), destino y edificios 3D ---
  const empty = { type: 'FeatureCollection' as const, features: [] };
  const line = (coords: number[][]) => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates: coords } });

  const destEl = document.createElement('div');
  destEl.className = 'dest';
  destEl.innerHTML = '<div class="dest-tag" id="dest-tag"></div><div class="dest-dot"></div>';
  const destMarker = new maplibregl.Marker({ element: destEl });

  // Burbuja sobre la ruta con el giro siguiente y la calle a la que entras (como en Google Maps).
  const bubbleEl = document.createElement('div');
  bubbleEl.className = 'turn-bubble';
  const bubbleMarker = new maplibregl.Marker({ element: bubbleEl, anchor: 'bottom-left', offset: [8, -8] });
  let bubbleFor = -1;

  /** Primera capa de etiquetas por encima de las calles: la ruta y los edificios 3D van justo debajo de los textos. */
  function firstSymbolId(): string | undefined {
    const layers = map.getStyle().layers;
    let lastRoad = -1;
    layers.forEach((l, i) => {
      if (l.type !== 'symbol' && /^(highway|railway|road|bridge|tunnel|building)/.test(l.id)) lastRoad = i;
    });
    return layers.find((l, i) => i > lastRoad && l.type === 'symbol')?.id;
  }

  let lastDraw: { r: Route | null; done?: number[][]; rest?: number[][] } = { r: null };

  function ensureLayers() {
    if (map.getSource('route')) return;
    const night = document.body.dataset.theme === 'night';
    const before = firstSymbolId();
    const cap = { 'line-cap': 'round' as const, 'line-join': 'round' as const };
    if (map.getSource('openmaptiles') && !map.getLayer('buildings-3d')) {
      const h = ['min', ['coalesce', ['get', 'render_height'], 9], 110] as maplibregl.ExpressionSpecification;
      map.addLayer(
        {
          id: 'buildings-3d', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 15,
          layout: { visibility: state === 'navigating' && view === 'drive' ? 'visible' : 'none' },
          paint: {
            // Más claros y con degradado según la altura, para que no se vean como cajas grises.
            'fill-extrusion-color': ['interpolate', ['linear'], h, 0, night ? '#222b3b' : '#f1ebe0', 40, night ? '#2e3a50' : '#e6dece', 110, night ? '#44526f' : '#d5cbb9'],
            'fill-extrusion-height': h,
            'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
            'fill-extrusion-opacity': night ? 0.92 : 0.88,
            'fill-extrusion-vertical-gradient': true,
          },
        },
        before,
      );
    }
    map.addSource('route', { type: 'geojson', data: empty });
    map.addSource('route-done', { type: 'geojson', data: empty });
    // Brillo suave bajo la ruta, sobre todo visible de noche.
    map.addLayer({ id: 'route-glow', type: 'line', source: 'route', layout: cap, paint: { 'line-color': night ? '#4cc3ff' : '#8fd3fa', 'line-width': 20, 'line-blur': 10, 'line-opacity': night ? 0.55 : 0.35 } }, before);
    map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: cap, paint: { 'line-color': night ? '#0b1220' : '#ffffff', 'line-width': 12 } }, before);
    map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: cap, paint: { 'line-color': night ? '#4cc3ff' : '#111111', 'line-width': 7 } }, before);
    map.addLayer({ id: 'route-done-line', type: 'line', source: 'route-done', layout: cap, paint: { 'line-color': night ? '#2a6f95' : '#5cc4f5', 'line-width': 7 } }, before);
  }
  // El estilo se vuelve a cargar al cambiar día/noche: recrear capas y repintar la ruta actual.
  map.on('style.load', () => {
    ensureLayers();
    drawRoute(lastDraw.r, lastDraw.done, lastDraw.rest);
  });
  if (map.isStyleLoaded()) ensureLayers();

  function drawRoute(r: Route | null, doneCoords?: number[][], restCoords?: number[][]) {
    lastDraw = { r, done: doneCoords, rest: restCoords };
    ensureLayers();
    (map.getSource('route') as maplibregl.GeoJSONSource).setData(r ? line(restCoords ?? r.coords) : empty);
    (map.getSource('route-done') as maplibregl.GeoJSONSource).setData(doneCoords && doneCoords.length > 1 ? line(doneCoords) : empty);
    if (r) {
      destMarker.setLngLat(r.coords[r.coords.length - 1]);
      if (!destEl.isConnected) destMarker.addTo(map);
    } else destMarker.remove();
  }
  const setDestTag = (text: string) => {
    const t = document.getElementById('dest-tag');
    if (t) t.textContent = text;
  };
  const set3d = (on: boolean) => {
    if (map.getLayer('buildings-3d')) map.setLayoutProperty('buildings-3d', 'visibility', on ? 'visible' : 'none');
  };

  // --- Pantalla encendida durante la navegación ---
  async function lockScreen() {
    try {
      wakeLock = (await navigator.wakeLock?.request('screen')) ?? null;
    } catch {
      /* no soportado o denegado */
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state === 'navigating') void lockScreen();
  });

  // --- Flujo ---
  async function loadRoute(): Promise<boolean> {
    if (!dest) return false;
    abort?.abort();
    abort = new AbortController();
    try {
      route = await fetchRoute(deps.getOrigin(), dest, mode, abort.signal);
    } catch (e) {
      if ((e as Error).name === 'AbortError') return false;
      // Sin servicio de rutas: línea recta aproximada para que la demo siga funcionando.
      route = straightRoute(deps.getOrigin(), dest, mode);
    }
    hint = 0;
    drawRoute(route);
    setDestTag(formatDistance(route.distance));
    return true;
  }

  function fitRoute() {
    if (!route) return;
    const b = new maplibregl.LngLatBounds();
    route.coords.forEach((c) => b.extend(c));
    map.easeTo({ pitch: 0, bearing: 0, duration: 0 });
    map.fitBounds(b, { padding: { top: 90, bottom: 300, left: 70, right: 70 }, duration: 600, maxZoom: 17 });
  }

  async function preview(p: Property) {
    dest = p;
    state = 'preview';
    arrived = false;
    set3d(false);
    deps.onActiveChange(true);
    renderPanel('Calculando ruta…');
    if (await loadRoute()) {
      fitRoute();
      renderPanel();
    }
  }

  function start() {
    if (!route) return;
    state = 'navigating';
    view = 'drive';
    hint = 0;
    offCount = 0;
    prevFix = null;
    camBearing = deps.getOrigin() && route ? bearing(deps.getOrigin(), { lng: route.coords[1][0], lat: route.coords[1][1] }) : 0;
    document.body.classList.add('navigating');
    applyView();
    void lockScreen();
    renderPanel();
    updateProgress(deps.getOrigin(), null, null);
  }

  function exit() {
    abort?.abort();
    sim?.stop();
    sim = null;
    void wakeLock?.release().catch(() => {});
    wakeLock = null;
    state = 'idle';
    dest = null;
    route = null;
    drawRoute(null);
    set3d(false);
    navbar.classList.add('hidden');
    panel.classList.add('hidden');
    speedEl.classList.add('hidden');
    streetEl.classList.add('hidden');
    bubbleMarker.remove();
    bubbleFor = -1;
    document.body.classList.remove('navigating', 'driveview');
    map.easeTo({ pitch: 0, bearing: 0, duration: 500 });
    deps.onActiveChange(false);
  }

  function applyView() {
    document.body.classList.toggle('driveview', state === 'navigating' && view === 'drive');
    set3d(state === 'navigating' && view === 'drive');
  }

  // --- Simulación ---
  function toggleSim() {
    if (!route) return;
    if (sim?.running) {
      sim.stop();
      sim = null;
    } else {
      sim = new Simulator(route, (f) => deps.onSimFix(f), () => ((sim = null), renderPanel()), SIM_SPEEDS[mode][simSpeedIdx]);
      deps.onSimStart?.();
      sim.start();
    }
    renderPanel();
  }
  function cycleSpeed() {
    simSpeedIdx = (simSpeedIdx + 1) % SIM_SPEEDS[mode].length;
    if (sim) sim.speed = SIM_SPEEDS[mode][simSpeedIdx];
    renderPanel();
  }

  // --- Cámara ---
  function moveCamera(pos: LatLng, heading: number, speedMs: number | null) {
    if (view === 'overview') {
      map.easeTo({ center: [pos.lng, pos.lat], bearing: 0, pitch: 0, zoom: 16.3, offset: [0, 0], duration: 250, easing: (t) => t });
      return;
    }
    // Conducción: rumbo suavizado, más zoom al ir lento y más panorámica al ir rápido.
    camBearing = (camBearing + angleDiff(camBearing, heading) * 0.35 + 360) % 360;
    const kmh = (speedMs ?? (mode === 'driving' ? 8 : 1.4)) * 3.6;
    const zoom = mode === 'foot' ? 17.9 : Math.max(15.9, 17.4 - kmh / 45);
    map.easeTo({ center: [pos.lng, pos.lat], bearing: camBearing, pitch: 58, zoom, offset: [0, 170], duration: 250, easing: (t) => t });
  }

  // --- Cada posición (real o simulada) ---
  function updateProgress(pos: LatLng, heading: number | null, speedMs: number | null) {
    if (!route || state !== 'navigating') return;
    const total = route.cum[route.cum.length - 1];
    const pr = project(route.coords, route.cum, pos, hint);
    hint = pr.index;
    const remaining = Math.max(0, total - pr.traveled);

    // Rumbo: el del GPS o, si no hay, el del movimiento reciente.
    let h = heading;
    if (h == null) {
      if (prevFix && distanceM(prevFix, pos) > 3) h = bearing(prevFix, pos);
      else h = camBearing;
    }
    if (!prevFix || distanceM(prevFix, pos) > 3) prevFix = pos;

    // Ruta recorrida (celeste) y por recorrer (negra).
    const here: number[] = [pos.lng, pos.lat];
    drawRoute(route, [...route.coords.slice(0, pr.index + 1), here], [here, ...route.coords.slice(pr.index + 1)]);

    // Llegada.
    if (!arrived && dest && (remaining < ARRIVAL_M * 1.5 || distanceM(pos, dest) < ARRIVAL_M)) {
      arrived = true;
      sim?.stop();
      sim = null;
    }

    // Siguiente maniobra.
    const next = route.steps.find((s) => s.at > pr.traveled + 8) ?? route.steps[route.steps.length - 1];
    const isLast = next === route.steps[route.steps.length - 1];
    navbar.classList.remove('hidden');
    if (arrived) {
      navbar.innerHTML = `<div class="turn-main"><div class="turn-ico">🏁</div><div><div class="turn-txt">Has llegado</div><div class="turn-dist">${dest?.title ?? ''}</div></div></div>`;
    } else {
      const near = next.at - pr.traveled < 400; // los carriles solo importan al acercarse
      navbar.innerHTML = `<div class="turn-main"><div class="turn-ico">${isLast ? '🏁' : next.icon}</div><div><div class="turn-dist">${formatDistance(Math.max(0, next.at - pr.traveled))}</div><div class="turn-txt">${isLast ? 'Tu destino está adelante' : next.text}</div></div></div>${near && !isLast ? laneHtml(next.lanes) : ''}`;
    }

    // Calle actual y burbuja del próximo giro.
    const cur = [...route.steps].reverse().find((st) => st.at <= pr.traveled + 1);
    streetEl.textContent = cur?.road ?? '';
    streetEl.classList.toggle('hidden', !cur?.road || arrived);
    const nextIdx = route.steps.indexOf(next);
    if (!isLast && !arrived && next.road) {
      if (bubbleFor !== nextIdx) {
        bubbleFor = nextIdx;
        bubbleEl.innerHTML = `<b>${next.icon}</b> ${next.road}`;
        bubbleMarker.setLngLat([next.lng, next.lat]);
        if (!bubbleEl.isConnected) bubbleMarker.addTo(map);
      }
    } else {
      bubbleMarker.remove();
      bubbleFor = -1;
    }

    // Velocidad.
    const kmh = speedMs != null ? Math.round(speedMs * 3.6) : null;
    if (kmh !== lastSpeedKmh) {
      lastSpeedKmh = kmh;
      speedEl.classList.toggle('hidden', kmh == null);
      if (kmh != null) speedEl.querySelector('b')!.textContent = String(kmh);
    }

    moveCamera(pos, h, speedMs);

    // Resumen inferior.
    const left = route.duration * (remaining / total || 0);
    const eta = new Date(Date.now() + left * 1000).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
    const sum = document.getElementById('route-summary');
    if (sum) sum.innerHTML = arrived ? 'Llegaste' : `${formatDuration(left)} <span>· ${formatDistance(remaining)} · ${eta}</span>`;
    setDestTag(formatDistance(remaining));

    // Fuera de ruta: recalcular (solo con GPS real; en simulación seguimos la ruta).
    if (!sim && !arrived) {
      offCount = pr.offRoute > OFF_ROUTE_M ? offCount + 1 : 0;
      if (offCount >= 3 && Date.now() - lastReroute > 10000) {
        offCount = 0;
        lastReroute = Date.now();
        navbar.innerHTML = '<div class="turn-main"><div class="turn-ico">⟳</div><div><div class="turn-txt">Recalculando ruta…</div></div></div>';
        void loadRoute();
      }
    }
    if (arrived) renderPanel();
  }

  // --- Panel inferior ---
  function renderPanel(message?: string) {
    if (state === 'idle' || !dest) return;
    panel.classList.remove('hidden');
    const modes = (['driving', 'foot'] as Mode[])
      .map((m) => `<button class="mode ${m === mode ? 'on' : ''}" data-mode="${m}">${m === 'driving' ? '🚗 Auto' : '🚶 A pie'}</button>`)
      .join('');
    const info = arrived ? 'Llegaste' : route ? `${route.approximate ? '≈ ' : ''}${formatDuration(route.duration)} <span>· ${formatDistance(route.distance)}</span>` : message ?? '';
    const head = `<div class="rp-dest"><span class="rp-ico" style="color:var(--${dest.type})">${typeIcon(dest.type, 20)}</span><div><b>${dest.title}</b><small>${TYPE_LABEL[dest.type]} · ${formatPrice(dest.price)}</small></div></div>`;
    const note = route?.approximate ? '<small class="note">Ruta aproximada: el servicio de rutas no respondió.</small>' : '';

    if (state === 'preview') {
      panel.innerHTML = `${head}<div class="modes">${modes}</div><div class="rp-info" id="route-summary">${info}</div>${note}
        <div class="rp-actions"><button class="ghost" data-act="cancel">Cancelar</button><button class="go" data-act="start" ${route ? '' : 'disabled'}>Iniciar</button></div>`;
    } else {
      const kmh = `${Math.round(SIM_SPEEDS[mode][simSpeedIdx] * 3.6)} km/h`;
      panel.innerHTML = `<div class="rp-info" id="route-summary">${info}</div>${note}
        <div class="rp-actions">
          <button class="ghost" data-act="view">${view === 'drive' ? '2D' : '3D'}</button>
          <button class="ghost grow" data-act="sim">${sim?.running ? '⏸ Detener simulación' : '▶ Simular recorrido'}</button>
          ${sim?.running ? `<button class="ghost" data-act="speed">${kmh}</button>` : ''}
          <button class="exit" data-act="exit" aria-label="Salir">✕</button>
        </div>`;
    }
  }

  function toggleView() {
    view = view === 'drive' ? 'overview' : 'drive';
    applyView();
    renderPanel();
    if (prevFix) moveCamera(prevFix, camBearing, lastSpeedKmh != null ? lastSpeedKmh / 3.6 : null);
  }
  compassEl.addEventListener('click', () => state === 'navigating' && toggleView());
  const spin = () => ((compassEl.firstElementChild as HTMLElement).style.transform = `rotate(${-map.getBearing()}deg)`);
  map.on('rotate', spin);

  /** Demo: calcula la ruta, inicia la navegación en modo conducción y simula el recorrido. */
  async function demo(p: Property) {
    mode = 'driving';
    await preview(p);
    if (!route) return;
    start();
    simSpeedIdx = 0;
    toggleSim();
  }

  panel.addEventListener('click', async (e) => {
    const el = (e.target as HTMLElement).closest('button');
    if (!el) return;
    const m = el.dataset.mode as Mode | undefined;
    if (m && state === 'preview' && m !== mode) {
      mode = m;
      simSpeedIdx = 0;
      renderPanel('Calculando ruta…');
      if (await loadRoute()) {
        fitRoute();
        renderPanel();
      }
      return;
    }
    switch (el.dataset.act) {
      case 'start': start(); break;
      case 'cancel':
      case 'exit': exit(); break;
      case 'sim': toggleSim(); break;
      case 'speed': cycleSpeed(); break;
      case 'view': toggleView(); break;
    }
  });

  return {
    preview,
    demo,
    feed(f: Fix) {
      updateProgress(f, f.heading, f.speed);
    },
    get navigating() {
      return state === 'navigating';
    },
    get simulating() {
      return !!sim?.running;
    },
    get active() {
      return state !== 'idle';
    },
  };
}
