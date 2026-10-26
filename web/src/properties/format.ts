import type { Property, PropertyType } from './types';

export const TYPE_LABEL: Record<PropertyType, string> = { casa: 'Casa', edificio: 'Edificio', finca: 'Finca' };
export const TYPE_EMOJI: Record<PropertyType, string> = { casa: '🏠', edificio: '🏢', finca: '🌳' };
export const TYPE_COLOR: Record<PropertyType, string> = { casa: '#22c55e', edificio: '#3b82f6', finca: '#f59e0b' };

export const formatPrice = (n: number) => `$${n.toLocaleString('es-EC')}`;

/** Foto de relleno (SVG embebido) hasta tener imágenes reales. */
export function placeholderImage(p: Property): string {
  const c = TYPE_COLOR[p.type];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 220"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c}"/><stop offset="1" stop-color="#0f172a"/></linearGradient></defs><rect width="400" height="220" fill="url(#g)"/><text x="200" y="125" font-size="80" text-anchor="middle">${TYPE_EMOJI[p.type]}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
