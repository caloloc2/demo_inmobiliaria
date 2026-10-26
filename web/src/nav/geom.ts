import type { LatLng } from '../properties/types';
import { distanceM } from '../properties/geo';

export type Coord = [number, number]; // [lng, lat]

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Rumbo inicial de a hacia b, 0-360°. */
export function bearing(a: LatLng, b: LatLng): number {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

export const toLatLng = (c: Coord): LatLng => ({ lng: c[0], lat: c[1] });

/** Distancias acumuladas (m) a lo largo de la polilínea. */
export function cumulative(coords: Coord[]): number[] {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + distanceM(toLatLng(coords[i - 1]), toLatLng(coords[i])));
  return cum;
}

export interface Projection {
  /** Metros recorridos desde el inicio de la ruta, sobre el punto más cercano. */
  traveled: number;
  /** Distancia (m) del punto a la ruta. */
  offRoute: number;
  /** Índice del segmento. */
  index: number;
}

/** Proyecta `p` sobre la polilínea. `hint` limita la búsqueda al tramo cercano al último avance. */
export function project(coords: Coord[], cum: number[], p: LatLng, hint = 0): Projection {
  const run = (from: number, to: number): Projection => {
    const kx = Math.cos(rad(p.lat)) * 111320;
    const ky = 110540;
    let best: Projection = { traveled: 0, offRoute: Infinity, index: from };
    for (let i = from; i < to; i++) {
      const ax = (coords[i][0] - p.lng) * kx, ay = (coords[i][1] - p.lat) * ky;
      const bx = (coords[i + 1][0] - p.lng) * kx, by = (coords[i + 1][1] - p.lat) * ky;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
      const off = Math.hypot(ax + t * dx, ay + t * dy);
      if (off < best.offRoute) best = { offRoute: off, index: i, traveled: cum[i] + t * (cum[i + 1] - cum[i]) };
    }
    return best;
  };
  const last = coords.length - 1;
  const local = run(Math.max(0, hint - 2), Math.min(last, hint + 80));
  return local.offRoute < 60 ? local : run(0, last);
}

/** Posición y rumbo a `d` metros del inicio. */
export function pointAt(coords: Coord[], cum: number[], d: number): { pos: LatLng; heading: number } {
  const total = cum[cum.length - 1];
  const dd = Math.max(0, Math.min(total, d));
  let i = 0;
  while (i < cum.length - 2 && cum[i + 1] < dd) i++;
  const seg = cum[i + 1] - cum[i];
  const t = seg === 0 ? 0 : (dd - cum[i]) / seg;
  const a = toLatLng(coords[i]);
  const b = toLatLng(coords[i + 1]);
  return { pos: { lng: a.lng + (b.lng - a.lng) * t, lat: a.lat + (b.lat - a.lat) * t }, heading: bearing(a, b) };
}
