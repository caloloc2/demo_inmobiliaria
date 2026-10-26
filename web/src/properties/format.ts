import type { Property, PropertyType } from './types';

export const TYPE_LABEL: Record<PropertyType, string> = { casa: 'Casa', edificio: 'Edificio', finca: 'Finca' };
export const TYPE_PLURAL: Record<PropertyType, string> = { casa: 'Casas', edificio: 'Edificios', finca: 'Fincas' };
export const TYPE_COLOR: Record<PropertyType, string> = { casa: '#5b9a0c', edificio: '#0ea5e9', finca: '#d97706' };

export const formatPrice = (n: number) => `$${n.toLocaleString('es-EC')}`;

const PATHS: Record<PropertyType, string> = {
  casa: 'M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  edificio: 'M5 21V4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v17M15 9h4a1 1 0 0 1 1 1v11M3 21h18M9 7h2M9 11h2M9 15h2',
  finca: 'M12 22v-7M12 15c-4.5 0-6.5-3-5.5-6-2-2.5-.5-6 3-6 1.5-2 5.5-2 6.5.5 3.5.5 4.5 4.5 2.5 6.5 1 3-1 5-6.5 5z',
};

/** Icono lineal (hereda `currentColor`), mismo lenguaje visual que el logo. */
export function typeIcon(type: PropertyType, size = 22): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${PATHS[type]}"/></svg>`;
}

const PHOTO_COUNT: Record<PropertyType | 'interior', number> = { casa: 11, edificio: 5, finca: 5, interior: 3 };

const hash = (id: string) => [...id].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);
const at = (kind: keyof typeof PHOTO_COUNT, n: number, small = false) => `/photos/${kind}-${n % PHOTO_COUNT[kind]}${small ? '-s' : ''}.jpg`;

export interface PhotoSet {
  /** Miniatura cuadrada (tarjetas y listas). */
  thumb: string;
  /** Foto principal 3:2. */
  hero: string;
  /** Galería de la ficha: fachada, segunda vista y un interior (o entorno en fincas). */
  gallery: string[];
}

/** Fotos de relleno (stock) elegidas de forma estable por inmueble hasta tener las reales. */
export function photos(p: Property): PhotoSet {
  const h = hash(p.id);
  const hero = at(p.type, h);
  const third = p.type === 'finca' ? at('finca', h + 2) : at('interior', h);
  return { thumb: at(p.type, h, true), hero, gallery: [hero, at(p.type, h + 1), third] };
}

/** "$149k" / "$1.2M" para los pines del mapa. */
export function shortPrice(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace('.0', '')}M`;
  return `$${Math.round(n / 1000)}k`;
}
