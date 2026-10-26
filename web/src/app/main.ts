import 'maplibre-gl/dist/maplibre-gl.css';
import '../style.css';
import './app.css';
import * as maplibregl from 'maplibre-gl';
import { DEFAULT_LOCATION, watchGps, type Fix, type GpsStatus } from './gps';
import { SimulatedPropertyProvider } from '../properties/generator';
import { distanceM, formatDistance } from '../properties/geo';
import { TYPE_COLOR, TYPE_EMOJI, TYPE_LABEL, formatPrice, placeholderImage } from '../properties/format';
import type { LatLng, Property, PropertyType } from '../properties/types';

const SEARCH_RADIUS_M = 2500;
const provider = new SimulatedPropertyProvider();

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/liberty',
  center: [DEFAULT_LOCATION.lng, DEFAULT_LOCATION.lat],
  zoom: 14.5,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');

// --- Estado ---
let user: Fix | null = null;
let follow = true;
let genCenter: LatLng | null = null;
let activeTypes = new Set<PropertyType>(['casa', 'edificio', 'finca']);
const markers = new Map<string, { marker: maplibregl.Marker; property: Property }>();

// --- UI ---
const gpsBanner = document.getElementById('gps-banner')!;
const sheet = document.getElementById('sheet')!;
const recenterBtn = document.getElementById('recenter')!;
const countEl = document.getElementById('count')!;

function setGpsStatus(s: GpsStatus) {
  gpsBanner.classList.toggle('hidden', s === 'ok');
  gpsBanner.textContent =
    s === 'denied'
      ? 'Ubicación denegada: mostrando una zona de ejemplo. Activa el permiso para usar tu GPS.'
      : s === 'unavailable'
        ? 'GPS no disponible: mostrando una zona de ejemplo.'
        : '';
}

// Marcador del usuario (punto azul con flecha de rumbo).
const userEl = document.createElement('div');
userEl.className = 'user-dot';
userEl.innerHTML = '<div class="user-arrow"></div>';
const userMarker = new maplibregl.Marker({ element: userEl, rotationAlignment: 'map' });

function onFix(f: Fix) {
  user = f;
  userMarker.setLngLat([f.lng, f.lat]);
  if (!userMarker.getElement().isConnected) userMarker.addTo(map);
  if (f.heading != null) userMarker.setRotation(f.heading);
  if (follow) map.easeTo({ center: [f.lng, f.lat], duration: 600 });
  refreshProperties(f);
  if (sheetProperty) renderSheet(sheetProperty);
}

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
  el.textContent = TYPE_EMOJI[p.type];
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    openSheet(p);
  });
  return new maplibregl.Marker({ element: el }).setLngLat([p.lng, p.lat]).addTo(map);
}

function applyFilter() {
  let visible = 0;
  for (const { marker, property } of markers.values()) {
    const show = activeTypes.has(property.type);
    marker.getElement().style.display = show ? '' : 'none';
    if (show) visible++;
  }
  countEl.textContent = `${visible} inmuebles en venta cerca`;
}

// --- Filtros por tipo ---
document.querySelectorAll<HTMLButtonElement>('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    const t = chip.dataset.type as PropertyType;
    if (activeTypes.has(t)) activeTypes.delete(t);
    else activeTypes.add(t);
    chip.classList.toggle('off', !activeTypes.has(t));
    applyFilter();
  });
});

// --- Ficha (bottom sheet) ---
let sheetProperty: Property | null = null;

function openSheet(p: Property) {
  sheetProperty = p;
  renderSheet(p);
  sheet.classList.add('open');
  follow = false;
  recenterBtn.classList.remove('hidden');
  map.easeTo({ center: [p.lng, p.lat], duration: 500 });
}

function closeSheet() {
  sheetProperty = null;
  sheet.classList.remove('open');
}

function renderSheet(p: Property) {
  const dist = user ? formatDistance(distanceM(user, p)) : '—';
  const stats = [
    `${p.areaM2.toLocaleString('es-EC')} m²`,
    p.bedrooms != null ? `${p.bedrooms} hab.` : null,
    p.bathrooms != null ? `${p.bathrooms} baños` : null,
  ].filter(Boolean);
  sheet.innerHTML = `
    <button class="sheet-close" aria-label="Cerrar">✕</button>
    <img src="${placeholderImage(p)}" alt="" />
    <div class="sheet-body">
      <span class="tag" style="--c:${TYPE_COLOR[p.type]}">${TYPE_LABEL[p.type]} · En venta</span>
      <h2>${p.title}</h2>
      <div class="price">${formatPrice(p.price)}</div>
      <div class="stats">${stats.map((s) => `<span>${s}</span>`).join('')}<span>📍 a ${dist}</span></div>
      <p class="addr">${p.address}</p>
      <p>${p.description}</p>
      <button class="primary" disabled>Cómo llegar (próximamente)</button>
    </div>`;
  sheet.querySelector('.sheet-close')!.addEventListener('click', closeSheet);
}

map.on('click', closeSheet);
map.on('dragstart', () => {
  follow = false;
  recenterBtn.classList.remove('hidden');
});

recenterBtn.addEventListener('click', () => {
  follow = true;
  recenterBtn.classList.add('hidden');
  if (user) map.easeTo({ center: [user.lng, user.lat], zoom: 15.5, duration: 600 });
});

// --- Arranque ---
// Sin GPS mostramos igualmente propiedades de ejemplo para que el demo nunca quede vacío.
map.on('load', () => refreshProperties(DEFAULT_LOCATION));

let firstFix = true;
watchGps(
  (f) => {
    if (firstFix) {
      firstFix = false;
      genCenter = null; // forzar regeneración alrededor de la ubicación real
      map.jumpTo({ center: [f.lng, f.lat], zoom: 15.5 });
    }
    onFix(f);
  },
  setGpsStatus,
);
