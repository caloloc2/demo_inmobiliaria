import 'maplibre-gl/dist/maplibre-gl.css';
import '../style.css';
import './app.css';
import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { DEFAULT_LOCATION, watchGps, type Fix, type GpsStatus } from './gps';
import { registerSW } from 'virtual:pwa-register';
import { createAlerts, RADII } from './alerts';
import { createNavigation } from './navigation';
import { disablePush, enablePush, pushState, reportPosition, sendTestPush, type PushState } from './push';
import { SimulatedPropertyProvider } from '../properties/generator';
import { distanceM, formatDistance } from '../properties/geo';
import { TYPE_COLOR, TYPE_LABEL, TYPE_PLURAL, formatPrice, illustration, typeIcon } from '../properties/format';
import type { LatLng, Property, PropertyType } from '../properties/types';

const SEARCH_RADIUS_M = 2000;
const TYPES: PropertyType[] = ['casa', 'edificio', 'finca'];

registerSW({ immediate: true });
maplibregl.setWorkerUrl(workerUrl);
const provider = new SimulatedPropertyProvider();

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/positron',
  center: [DEFAULT_LOCATION.lng, DEFAULT_LOCATION.lat],
  zoom: 14.5,
  attributionControl: { compact: true },
});

/** Paleta cálida y suave del diseño (el estilo base es gris frío). */
function tuneStyle() {
  const paint = (id: string, prop: string, value: string) => {
    if (map.getLayer(id)) map.setPaintProperty(id, prop as 'background-color', value);
  };
  paint('background', 'background-color', '#ece8e0');
  paint('park', 'fill-color', '#dde7d0');
  paint('landcover_wood', 'fill-color', '#d6e3c6');
  paint('water', 'fill-color', '#cfe3ef');
  paint('building', 'fill-color', '#e1dcd1');
  paint('landuse_residential', 'fill-color', '#e8e3da');
  for (const id of ['highway_minor', 'highway_major_inner', 'highway_motorway_inner']) paint(id, 'line-color', '#ffffff');
}
map.on('load', tuneStyle);

// --- Estado ---
let user: Fix | null = null;
let follow = true;
let genCenter: LatLng | null = null;
const activeTypes = new Set<PropertyType>(TYPES);
const markers = new Map<string, { marker: maplibregl.Marker; property: Property }>();

// --- UI ---
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const gpsBanner = $('gps-banner');
const sheet = $('sheet');
const recenterBtn = $('recenter');
const totalEl = $('total');
const chipsEl = $('chips');
const searchInput = $<HTMLInputElement>('q');
const resultsEl = $('results');

function setGpsStatus(s: GpsStatus) {
  gpsBanner.classList.toggle('hidden', s === 'ok');
  gpsBanner.textContent =
    s === 'denied'
      ? 'Ubicación denegada: mostrando una zona de ejemplo. Activa el permiso para usar tu GPS.'
      : s === 'unavailable'
        ? 'GPS no disponible: mostrando una zona de ejemplo.'
        : '';
}

// Marcador del usuario: halo celeste con flecha de rumbo.
const userEl = document.createElement('div');
userEl.className = 'user';
userEl.innerHTML = '<div class="user-halo"></div><div class="user-core"><svg width="16" height="16" viewBox="0 0 24 24" fill="#fff"><path d="M12 3 5 20l7-4 7 4z"/></svg></div><div class="user-tag">Tú</div>';
const userMarker = new maplibregl.Marker({ element: userEl, rotationAlignment: 'map' });
const userArrow = userEl.querySelector<HTMLElement>('.user-core')!;

const alerts = createAlerts(provider, (p, d) => showToast(p, d));

function onFix(f: Fix) {
  user = f;
  userMarker.setLngLat([f.lng, f.lat]);
  if (!userEl.isConnected) userMarker.addTo(map);
  if (f.heading != null) userArrow.style.transform = `rotate(${f.heading - map.getBearing()}deg)`;
  refreshProperties(f);
  updateNearest();
  alerts.check(f);
  if (alerts.settings.enabled) void reportPosition(f, alerts.settings.radiusM);
  if (nav.navigating) nav.feed(f);
  else if (follow && !nav.active) map.easeTo({ center: [f.lng, f.lat], duration: 600 });
  if (sheetProperty) renderSheet(sheetProperty);
}

// Mantener la flecha apuntando al rumbo real aunque rote la cámara.
map.on('rotate', () => {
  if (user?.heading != null) userArrow.style.transform = `rotate(${user.heading - map.getBearing()}deg)`;
});

const nav = createNavigation({
  map,
  getOrigin: () => user ?? DEFAULT_LOCATION,
  onActiveChange: (active) => {
    document.body.classList.toggle('routing', active);
    if (active) closeSheet();
    else {
      alerts.setDestination(null);
      follow = true;
      recenterBtn.classList.add('hidden');
    }
  },
  onSimFix: (f) => onFix(f),
  onSimStart: () => alerts.reset(),
});

// --- Inmuebles en el mapa ---
function refreshProperties(center: LatLng) {
  // Solo regenerar cuando nos alejamos lo suficiente del último centro.
  if (genCenter && distanceM(genCenter, center) < SEARCH_RADIUS_M / 4) return;
  genCenter = center;
  const next = new Map(provider.nearby(center, SEARCH_RADIUS_M).map((p) => [p.id, p]));
  for (const [id, entry] of markers) {
    if (!next.has(id)) {
      entry.marker.remove();
      markers.delete(id);
    }
  }
  for (const [id, p] of next) if (!markers.has(id)) markers.set(id, { marker: makeMarker(p), property: p });
  applyFilter();
}

function makeMarker(p: Property): maplibregl.Marker {
  const el = document.createElement('button');
  el.className = 'pin';
  el.style.setProperty('--c', TYPE_COLOR[p.type]);
  el.setAttribute('aria-label', `${TYPE_LABEL[p.type]} en venta ${formatPrice(p.price)}`);
  el.innerHTML = `${typeIcon(p.type, 22)}<span class="pin-tag">Más cercano</span>`;
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    openSheet(p);
  });
  return new maplibregl.Marker({ element: el }).setLngLat([p.lng, p.lat]).addTo(map);
}

function applyFilter() {
  const counts: Record<PropertyType, number> = { casa: 0, edificio: 0, finca: 0 };
  let visible = 0;
  for (const { marker, property } of markers.values()) {
    counts[property.type]++;
    const show = activeTypes.has(property.type);
    marker.getElement().style.display = show ? '' : 'none';
    if (show) visible++;
  }
  totalEl.textContent = String(visible);
  chipsEl.innerHTML = TYPES.map(
    (t) => `<button class="chip ${activeTypes.has(t) ? '' : 'off'}" data-type="${t}" style="--c:${TYPE_COLOR[t]}" aria-label="${TYPE_PLURAL[t]}">${typeIcon(t, 18)}<b>${counts[t]}</b></button>`,
  ).join('');
  updateNearest();
}

chipsEl.addEventListener('click', (e) => {
  const chip = (e.target as HTMLElement).closest<HTMLElement>('.chip');
  if (!chip) return;
  const t = chip.dataset.type as PropertyType;
  if (activeTypes.has(t)) activeTypes.delete(t);
  else activeTypes.add(t);
  applyFilter();
});

/** Etiqueta "Más cercano" sobre el inmueble visible más próximo al usuario. */
let nearestId: string | null = null;
function updateNearest() {
  const from = user ?? genCenter;
  if (!from) return;
  let best: string | null = null;
  let bestD = Infinity;
  for (const [id, { property, marker }] of markers) {
    if (marker.getElement().style.display === 'none') continue;
    const d = distanceM(from, property);
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  if (best === nearestId) return;
  if (nearestId) markers.get(nearestId)?.marker.getElement().classList.remove('nearest');
  nearestId = best;
  if (best) markers.get(best)?.marker.getElement().classList.add('nearest');
}

// --- Búsqueda ---
searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) return resultsEl.classList.add('hidden');
  const from = user ?? genCenter ?? DEFAULT_LOCATION;
  const found = [...markers.values()]
    .map((m) => m.property)
    .filter((p) => `${p.title} ${p.address} ${TYPE_LABEL[p.type]} ${p.price}`.toLowerCase().includes(q))
    .sort((a, b) => distanceM(from, a) - distanceM(from, b))
    .slice(0, 5);
  resultsEl.classList.remove('hidden');
  resultsEl.innerHTML = found.length
    ? found
        .map(
          (p) => `<button data-id="${p.id}"><span style="color:${TYPE_COLOR[p.type]}">${typeIcon(p.type, 20)}</span><div><b>${p.title}</b><small>${formatPrice(p.price)} · a ${formatDistance(distanceM(from, p))}</small></div></button>`,
        )
        .join('')
    : '<div class="empty">Sin resultados cerca</div>';
});
resultsEl.addEventListener('click', (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>('button')?.dataset.id;
  const p = id ? markers.get(id)?.property : undefined;
  if (!p) return;
  resultsEl.classList.add('hidden');
  searchInput.value = '';
  searchInput.blur();
  openSheet(p);
});

// --- Ficha (bottom sheet) ---
let sheetProperty: Property | null = null;

function openSheet(p: Property) {
  sheetProperty = p;
  renderSheet(p);
  sheet.classList.add('open');
  follow = false;
  recenterBtn.classList.remove('hidden');
  map.easeTo({ center: [p.lng, p.lat], offset: [0, -140], duration: 500 });
}

function closeSheet() {
  sheetProperty = null;
  sheet.classList.remove('open');
}

function renderSheet(p: Property) {
  const dist = user ? formatDistance(distanceM(user, p)) : '—';
  const second = p.bedrooms != null ? { v: String(p.bedrooms), l: 'Habitaciones' } : { v: 'Comercial', l: 'Uso' };
  sheet.innerHTML = `
    <button class="sheet-close" aria-label="Cerrar">‹</button>
    <div class="sheet-head">
      <h2>${p.title}</h2>
      <p class="sub">${TYPE_LABEL[p.type]} · ${p.address}</p>
      <div class="tags"><span class="pill">● En venta</span><span class="pill sun">${p.condition}</span></div>
    </div>
    <div class="stats3">
      <div><b>${p.areaM2.toLocaleString('es-EC')} m²</b><small>Área</small></div>
      <div><b>${second.v}</b><small>${second.l}</small></div>
      <div><b>${dist}</b><small>Distancia</small></div>
    </div>
    <img src="${illustration(p)}" alt="" />
    <p class="desc">${p.description}</p>
    <div class="sheet-foot"><span class="price">${formatPrice(p.price)}</span><button class="how" id="go">Cómo llegar <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button></div>`;
  sheet.querySelector('.sheet-close')!.addEventListener('click', closeSheet);
  sheet.querySelector('#go')!.addEventListener('click', () => {
    alerts.setDestination(p.id);
    void nav.preview(p);
  });
}

map.on('click', () => {
  closeSheet();
  closeAlertPanel();
  resultsEl.classList.add('hidden');
});
map.on('dragstart', () => {
  if (nav.active) return;
  follow = false;
  recenterBtn.classList.remove('hidden');
});

// --- Aviso de cercanía dentro de la app ---
const toastEl = $('toast');
let toastTimer: number | undefined;
function showToast(p: Property, distM: number) {
  toastEl.innerHTML = `<span class="toast-ico" style="color:${TYPE_COLOR[p.type]}">${typeIcon(p.type, 24)}</span><div><b>${TYPE_LABEL[p.type]} en venta a ${formatDistance(distM)}</b><small>${p.title} · ${formatPrice(p.price)}</small></div><span class="toast-go">Ver</span>`;
  toastEl.classList.remove('hidden');
  toastEl.onclick = () => {
    toastEl.classList.add('hidden');
    openSheet(p);
  };
  navigator.vibrate?.([120, 60, 120]);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.add('hidden'), 9000);
}

// --- Panel de alertas ---
const alertPanel = $('alertpanel');
$('bell').addEventListener('click', (e) => {
  e.preventDefault();
  void renderAlertPanel();
  alertPanel.classList.add('open');
});
function closeAlertPanel() {
  alertPanel.classList.remove('open');
}

async function renderAlertPanel(note = '') {
  const st: PushState = await pushState();
  const s = alerts.settings;
  const pushBlock: Record<PushState, string> = {
    unsupported: '<p class="hint">Este navegador no soporta notificaciones push. Las alertas se muestran dentro de la app.</p>',
    'needs-install': '<p class="hint">En iPhone, instala la app: <b>Compartir → Agregar a inicio</b> y ábrela desde su icono. Después podrás activar las notificaciones.</p>',
    denied: '<p class="hint">Las notificaciones están bloqueadas. Actívalas en los ajustes del sitio en tu navegador.</p>',
    off: '<button class="go" data-a="enable">Activar notificaciones</button>',
    on: '<p class="hint ok">✓ Notificaciones activas en este dispositivo</p><div class="rp-actions"><button class="ghost" data-a="test">Enviar prueba</button><button class="ghost" data-a="disable">Desactivar</button></div>',
  };
  alertPanel.innerHTML = `
    <button class="sheet-close" data-a="close" aria-label="Cerrar">‹</button>
    <div class="sheet-head"><h2>Alertas de cercanía</h2><p class="sub">Te avisamos cuando pases cerca de un inmueble en venta</p></div>
    <button class="switch ${s.enabled ? 'on' : ''}" data-a="toggle" role="switch" aria-checked="${s.enabled}"><span>Avisarme</span><i></i></button>
    <p class="label">Radio de aviso</p>
    <div class="modes">${RADII.map((r) => `<button class="mode ${r === s.radiusM ? 'on' : ''}" data-r="${r}">${r >= 1000 ? r / 1000 + ' km' : r + ' m'}</button>`).join('')}</div>
    <p class="label">Notificaciones push</p>
    ${pushBlock[st]}
    ${note ? `<p class="hint ok">${note}</p>` : ''}`;
}

alertPanel.addEventListener('click', async (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('button');
  if (!el) return;
  const r = el.dataset.r;
  if (r) {
    alerts.update({ radiusM: Number(r) });
    alerts.reset();
    return void renderAlertPanel();
  }
  switch (el.dataset.a) {
    case 'close': return closeAlertPanel();
    case 'toggle':
      alerts.update({ enabled: !alerts.settings.enabled });
      return void renderAlertPanel();
    case 'enable':
      try {
        await enablePush();
        return void renderAlertPanel('Listo: te avisaremos aunque la app esté en segundo plano.');
      } catch {
        return void renderAlertPanel('No se pudo activar. Revisa tu conexión e inténtalo de nuevo.');
      }
    case 'disable':
      await disablePush();
      return void renderAlertPanel();
    case 'test': {
      const ok = await sendTestPush().catch(() => false);
      return void renderAlertPanel(ok ? 'Prueba enviada: debería llegarte en unos segundos.' : 'No se pudo enviar la prueba.');
    }
  }
});

// --- Abrir un inmueble desde una notificación ---
function openById(id: string) {
  const p = provider.get(id);
  if (p) openSheet(p);
}
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type === 'open-property') openById(e.data.id);
});

// --- Controles del mapa ---
$('zin').addEventListener('click', () => map.zoomIn());
$('zout').addEventListener('click', () => map.zoomOut());
recenterBtn.addEventListener('click', () => {
  follow = true;
  recenterBtn.classList.add('hidden');
  if (user) map.easeTo({ center: [user.lng, user.lat], zoom: 14.4, duration: 600 });
});

// --- Arranque ---
// Sin GPS mostramos igualmente propiedades de ejemplo para que el demo nunca quede vacío.
map.on('load', () => {
  if (!user) refreshProperties(DEFAULT_LOCATION);
});

const deepLink = new URLSearchParams(location.search).get('p');
if (deepLink) {
  history.replaceState(null, '', '/app/');
  map.once('load', () => openById(deepLink));
}

let firstFix = true;
watchGps(
  (f) => {
    if (nav.simulating) return;
    if (firstFix) {
      firstFix = false;
      genCenter = null; // forzar regeneración alrededor de la ubicación real
      map.jumpTo({ center: [f.lng, f.lat], zoom: 14.4 });
    }
    onFix(f);
  },
  setGpsStatus,
);
