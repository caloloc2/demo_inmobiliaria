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

/** Ilustración plana de relleno hasta tener fotos reales. */
export function illustration(p: Property): string {
  const c = TYPE_COLOR[p.type];
  const scene: Record<PropertyType, string> = {
    casa: `<rect x="130" y="95" width="140" height="85" rx="6" fill="#fff"/><path d="M118 98 200 36l82 62z" fill="${c}"/><rect x="186" y="128" width="28" height="52" rx="4" fill="#111"/><rect x="144" y="112" width="26" height="24" rx="4" fill="#bfe6fb"/><rect x="230" y="112" width="26" height="24" rx="4" fill="#bfe6fb"/>`,
    edificio: `<rect x="140" y="30" width="120" height="150" rx="8" fill="#fff"/><rect x="262" y="82" width="46" height="98" rx="6" fill="#e8e4dc"/>${[0, 1, 2, 3].map((r) => [0, 1, 2].map((k) => `<rect x="${154 + k * 36}" y="${44 + r * 32}" width="22" height="20" rx="4" fill="${(r + k) % 3 === 0 ? '#fde68a' : '#bfe6fb'}"/>`).join('')).join('')}<rect x="190" y="150" width="20" height="30" rx="3" fill="#111"/>`,
    finca: `<path d="M0 150Q100 110 200 140T400 125V220H0z" fill="#c7e08a"/><rect x="150" y="104" width="100" height="62" rx="5" fill="#fff"/><path d="M140 108 200 62l60 46z" fill="${c}"/><rect x="190" y="130" width="20" height="36" rx="3" fill="#111"/><circle cx="92" cy="128" r="26" fill="#86b84a"/><rect x="88" y="140" width="8" height="30" fill="#7a5a2b"/><circle cx="312" cy="132" r="22" fill="#86b84a"/><rect x="308" y="142" width="8" height="28" fill="#7a5a2b"/>`,
  };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e8f5fd"/><stop offset="1" stop-color="#f4f1ec"/></linearGradient></defs><rect width="400" height="200" fill="url(#s)"/><ellipse cx="200" cy="184" rx="170" ry="14" fill="#0000000f"/>${scene[p.type]}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
