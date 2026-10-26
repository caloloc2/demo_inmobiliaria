import * as maplibregl from 'maplibre-gl';
import type { Fix } from './gps';
import { bearing, project, toLatLng } from '../nav/geom';
import { fetchRoute, formatDuration, straightRoute, type Mode, type Route } from '../nav/route';
import { Simulator } from '../nav/simulator';
import { distanceM, formatDistance } from '../properties/geo';
import { TYPE_EMOJI, formatPrice } from '../properties/format';
import type { LatLng, Property } from '../properties/types';

type State = 'idle' | 'preview' | 'navigating';

export interface NavDeps {
  map: maplibregl.Map;
  /** Origen de la ruta: GPS actual, o la zona de ejemplo si no hay GPS. */
  getOrigin(): LatLng;
  /** Se llama al entrar/salir de la vista de ruta para ocultar/mostrar el resto de la UI. */
  onActiveChange(active: boolean): void;
  /** Mueve el marcador del usuario (lo usa el simulador). */
  onSimFix(f: Fix): void;
}

const SIM_SPEEDS: Record<Mode, number[]> = { driving: [12, 25, 40], foot: [3, 6, 12] };
const OFF_ROUTE_M = 50;
const ARRIVAL_M = 25;

export function createNavigation(deps: NavDeps) {
  const { map } = deps;
  const navbar = document.getElementById('navbar')!;
  const panel = document.getElementById('routepanel')!;

  let state: State = 'idle';
  let dest: Property | null = null;
  let mode: Mode = 'driving';
  let route: Route | null = null;
  let sim: Simulator | null = null;
  let simSpeedIdx = 0;
  let hint = 0;
  let offCount = 0;
  let lastReroute = 0;
  let lastHeading = 0;
  let prevFix: LatLng | null = null;
  let abort: AbortController | null = null;
  let wakeLock: WakeLockSentinel | null = null;
  let arrived = false;

  // --- Capa de ruta ---
  const empty = { type: 'FeatureCollection' as const, features: [] };
  function ensureLayers() {
    if (map.getSource('route')) return;
    map.addSource('route', { type: 'geojson', data: empty });
    map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#1e3a8a', 'line-width': 10 } });
    map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#3b82f6', 'line-width': 6 } });
  }
  function drawRoute(r: Route | null) {
    ensureLayers();
    (map.getSource('route') as maplibregl.GeoJSONSource).setData(
      r ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: r.coords } } : empty,
    );
  }
  if (map.isStyleLoaded()) ensureLayers();
  else map.once('load', ensureLayers);

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
      hint = 0;
      drawRoute(route);
      return true;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return false;
      // Sin servicio de rutas: línea recta aproximada para que la demo siga funcionando.
      route = straightRoute(deps.getOrigin(), dest, mode);
      hint = 0;
      drawRoute(route);
      return true;
    }
  }

  function fitRoute() {
    if (!route) return;
    const b = new maplibregl.LngLatBounds();
    route.coords.forEach((c) => b.extend(c));
    map.easeTo({ pitch: 0, bearing: 0, duration: 0 });
    map.fitBounds(b, { padding: { top: 70, bottom: 280, left: 40, right: 40 }, duration: 600, maxZoom: 17 });
  }

  async function preview(p: Property) {
    dest = p;
    state = 'preview';
    arrived = false;
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
    hint = 0;
    offCount = 0;
    prevFix = null;
    void lockScreen();
    renderPanel();
    updateProgress(deps.getOrigin(), null);
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
    navbar.classList.add('hidden');
    panel.classList.add('hidden');
    map.easeTo({ pitch: 0, bearing: 0, duration: 500 });
    deps.onActiveChange(false);
  }

  // --- Simulación ---
  function toggleSim() {
    if (!route) return;
    if (sim?.running) {
      sim.stop();
      sim = null;
    } else {
      sim = new Simulator(route, (f) => deps.onSimFix(f), () => (sim = null, renderPanel()), SIM_SPEEDS[mode][simSpeedIdx]);
      sim.start();
    }
    renderPanel();
  }
  function cycleSpeed() {
    simSpeedIdx = (simSpeedIdx + 1) % SIM_SPEEDS[mode].length;
    if (sim) sim.speed = SIM_SPEEDS[mode][simSpeedIdx];
    renderPanel();
  }

  // --- Cada posición (real o simulada) ---
  function updateProgress(pos: LatLng, heading: number | null) {
    if (!route || state !== 'navigating') return;
    const total = route.cum[route.cum.length - 1];
    const pr = project(route.coords, route.cum, pos, hint);
    hint = pr.index;
    const remaining = Math.max(0, total - pr.traveled);

    // Rumbo: el del GPS o, si no hay, el del movimiento reciente.
    if (heading != null) lastHeading = heading;
    else if (prevFix && distanceM(prevFix, pos) > 3) lastHeading = bearing(prevFix, pos);
    if (!prevFix || distanceM(prevFix, pos) > 3) prevFix = pos;

    // Llegada.
    if (!arrived && dest && (remaining < ARRIVAL_M * 1.5 || distanceM(pos, dest) < ARRIVAL_M)) {
      arrived = true;
      sim?.stop();
      sim = null;
      showArrival();
    }

    // Siguiente maniobra.
    const next = route.steps.find((s) => s.at > pr.traveled + 8) ?? route.steps[route.steps.length - 1];
    if (!arrived) {
      navbar.classList.remove('hidden');
      const isLast = next === route.steps[route.steps.length - 1];
      navbar.innerHTML = `<div class="nav-icon">${isLast ? '🏁' : next.icon}</div><div><div class="nav-dist">${formatDistance(Math.max(0, next.at - pr.traveled))}</div><div class="nav-text">${isLast ? 'Tu destino está adelante' : next.text}</div></div>`;
    }

    // Cámara tipo navegación.
    map.easeTo({ center: [pos.lng, pos.lat], bearing: lastHeading, pitch: 55, zoom: 17, offset: [0, 150], duration: 250, easing: (t) => t });

    // Resumen inferior.
    const left = route.duration * (remaining / total || 0);
    const eta = new Date(Date.now() + left * 1000).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
    const sum = document.getElementById('route-summary');
    if (sum) sum.textContent = arrived ? 'Llegaste' : `${formatDuration(left)} · ${formatDistance(remaining)} · llegada ${eta}`;

    // Fuera de ruta: recalcular (solo con GPS real; en simulación seguimos la ruta).
    if (!sim && !arrived) {
      offCount = pr.offRoute > OFF_ROUTE_M ? offCount + 1 : 0;
      if (offCount >= 3 && Date.now() - lastReroute > 10000) {
        offCount = 0;
        lastReroute = Date.now();
        navbar.innerHTML = '<div class="nav-icon">⟳</div><div><div class="nav-text">Recalculando ruta…</div></div>';
        void loadRoute();
      }
    }
  }

  function showArrival() {
    navbar.classList.remove('hidden');
    navbar.innerHTML = `<div class="nav-icon">🏁</div><div><div class="nav-dist">Has llegado</div><div class="nav-text">${dest?.title ?? ''}</div></div>`;
    renderPanel();
  }

  // --- Panel inferior ---
  function renderPanel(message?: string) {
    if (state === 'idle' || !dest) return;
    panel.classList.remove('hidden');
    const modes = (['driving', 'foot'] as Mode[])
      .map((m) => `<button class="mode ${m === mode ? 'on' : ''}" data-mode="${m}" ${state === 'navigating' ? 'disabled' : ''}>${m === 'driving' ? '🚗 Auto' : '🚶 A pie'}</button>`)
      .join('');
    const info = route ? `${route.approximate ? '≈ ' : ''}${formatDuration(route.duration)} · ${formatDistance(route.distance)}` : message ?? '';
    const common = `<div class="rp-dest">${TYPE_EMOJI[dest.type]} ${dest.title} · ${formatPrice(dest.price)}</div>${route?.approximate ? '<small>Ruta aproximada: el servicio de rutas no respondió.</small>' : ''}`;

    if (state === 'preview') {
      panel.innerHTML = `${common}<div class="modes">${modes}</div><div class="rp-info" id="route-summary">${info}</div>
        <div class="rp-actions"><button class="secondary" data-act="cancel">Cancelar</button><button class="primary" data-act="start" ${route ? '' : 'disabled'}>Iniciar</button></div>`;
    } else {
      const speed = SIM_SPEEDS[mode][simSpeedIdx];
      const unit = `${Math.round(speed * 3.6)} km/h`;
      panel.innerHTML = `${common}<div class="rp-info" id="route-summary">${info}</div>
        <div class="rp-actions"><button class="secondary" data-act="exit">Salir</button>
        <button class="secondary" data-act="sim">${sim?.running ? '⏸ Detener simulación' : '▶ Simular recorrido'}</button>
        ${sim?.running ? `<button class="secondary small" data-act="speed">${unit}</button>` : ''}</div>`;
    }
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
    }
  });

  return {
    preview,
    /** Llamar con cada posición. Devuelve true si la navegación está activa. */
    feed(f: Fix) {
      updateProgress(f, f.heading);
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
