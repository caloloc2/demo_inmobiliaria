import type { LatLng } from '../properties/types';
import { cumulative, project, type Coord } from './geom';

export type Mode = 'driving' | 'foot';

export interface Lane {
  valid: boolean;
  /** Flechas de cada carril (p. ej. ['straight', 'right']). */
  indications: string[];
}

export interface RouteStep {
  text: string;
  icon: string;
  /** Calle por la que se circula después de la maniobra. */
  road: string;
  lng: number;
  lat: number;
  /** Carriles al acercarse a la maniobra, si el servicio los entrega. */
  lanes?: Lane[];
  /** Metros desde el inicio de la ruta donde ocurre la maniobra. */
  at: number;
}

export interface Route {
  mode: Mode;
  coords: Coord[];
  cum: number[];
  distance: number;
  duration: number;
  steps: RouteStep[];
  /** true si es una línea recta de respaldo (el servicio de rutas no respondió). */
  approximate?: boolean;
}

// Servidores OSRM públicos de OpenStreetMap (CORS abierto). Solo para el demo.
const BASE: Record<Mode, string> = {
  driving: 'https://routing.openstreetmap.de/routed-car',
  foot: 'https://routing.openstreetmap.de/routed-foot',
};

interface OsrmStep {
  name: string;
  intersections?: { lanes?: Lane[] }[];
  maneuver: { type: string; modifier?: string; exit?: number; location: Coord };
}

const MOD: Record<string, string> = {
  left: 'a la izquierda',
  right: 'a la derecha',
  'slight left': 'ligeramente a la izquierda',
  'slight right': 'ligeramente a la derecha',
  'sharp left': 'cerrado a la izquierda',
  'sharp right': 'cerrado a la derecha',
  straight: 'recto',
  uturn: 'en U',
};
const ICON: Record<string, string> = {
  left: '↰', right: '↱', 'slight left': '↖', 'slight right': '↗', 'sharp left': '↰', 'sharp right': '↱', straight: '↑', uturn: '↩',
};

function describe(s: OsrmStep): { text: string; icon: string } {
  const { type, modifier = 'straight', exit } = s.maneuver;
  const on = s.name ? ` por ${s.name}` : '';
  const toward = s.name ? ` hacia ${s.name}` : '';
  const icon = ICON[modifier] ?? '↑';
  const mod = MOD[modifier] ?? 'recto';
  switch (type) {
    case 'depart': return { text: `Inicia${on}`, icon: '↑' };
    case 'arrive': return { text: 'Has llegado a tu destino', icon: '🏁' };
    case 'roundabout':
    case 'rotary':
    case 'roundabout turn':
      return { text: exit ? `En la rotonda toma la salida ${exit}` : 'Entra a la rotonda', icon: '⟳' };
    case 'fork': return { text: `Mantente ${mod}${toward}`, icon };
    case 'merge': return { text: `Incorpórate${on}`, icon };
    case 'continue':
    case 'new name': return modifier === 'straight' ? { text: `Continúa recto${on}`, icon: '↑' } : { text: `Sigue ${mod}${toward}`, icon };
    default: return modifier === 'straight' ? { text: `Continúa recto${on}`, icon: '↑' } : { text: `Gira ${mod}${toward}`, icon };
  }
}

export async function fetchRoute(from: LatLng, to: LatLng, mode: Mode, signal?: AbortSignal): Promise<Route> {
  const url = `${BASE[mode]}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson&steps=true`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Ruta no disponible (${res.status})`);
  const data = await res.json();
  if (data.code !== 'Ok' || !data.routes?.length) throw new Error('No se encontró una ruta');
  const r = data.routes[0];
  const coords: Coord[] = r.geometry.coordinates;
  const cum = cumulative(coords);

  // Ubicar cada maniobra sobre la polilínea (avanzando, nunca hacia atrás).
  let hint = 0;
  const steps: RouteStep[] = (r.legs[0].steps as OsrmStep[]).map((s, i, all) => {
    const { text, icon } = describe(s);
    const [lng, lat] = s.maneuver.location;
    const base = { text, icon, road: s.name ?? '', lng, lat };
    if (i === 0) return { ...base, at: 0 };
    // Los carriles se muestran en la última intersección del tramo anterior, justo antes del giro.
    const ints = all[i - 1].intersections;
    const lanes = ints?.[ints.length - 1]?.lanes;
    if (i === all.length - 1) return { ...base, at: cum[cum.length - 1] };
    const p = project(coords, cum, { lng, lat }, hint);
    hint = p.index;
    return { ...base, at: p.traveled, lanes };
  });

  return { mode, coords, cum, distance: r.distance, duration: r.duration, steps };
}

export const formatDuration = (s: number) => {
  const m = Math.max(1, Math.round(s / 60));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

/** Respaldo sin servicio de rutas: línea recta con velocidad media. */
export function straightRoute(from: LatLng, to: LatLng, mode: Mode): Route {
  const coords: Coord[] = [[from.lng, from.lat], [to.lng, to.lat]];
  const cum = cumulative(coords);
  const distance = cum[1];
  const speed = mode === 'driving' ? 8 : 1.3;
  return {
    mode, coords, cum, distance, duration: distance / speed, approximate: true,
    steps: [
      { text: 'Dirígete hacia el destino', icon: '↑', road: '', lng: from.lng, lat: from.lat, at: 0 },
      { text: 'Has llegado a tu destino', icon: '🏁', road: '', lng: to.lng, lat: to.lat, at: distance },
    ],
  };
}
