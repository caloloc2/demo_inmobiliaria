import { distanceM } from './geo';
import type { LatLng, Property, PropertyProvider, PropertyType } from './types';

/** Tamaño de celda en grados (~1.1 km). Cada celda tiene siempre los mismos inmuebles. */
const CELL = 0.01;
const PER_CELL = 2;

// PRNG determinista (mulberry32) para que el demo sea estable entre recargas.
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hashCell = (ix: number, iy: number) => (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663)) >>> 0;

const STREETS = ['Av. Los Álamos', 'Calle del Sol', 'Av. Principal', 'Calle Las Palmas', 'Av. Los Pinos', 'Calle Bolívar', 'Vía Panorámica', 'Calle de los Cedros'];
const NEIGHBORHOODS = ['Los Pinos', 'La Colina', 'El Mirador', 'Valle Verde', 'San Miguel', 'Altos del Río'];
const ADJ = ['Moderna', 'Amplia', 'Acogedora', 'Con vista', 'Remodelada', 'Esquinera'];

const pick = <T>(rnd: () => number, arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)];
const int = (rnd: () => number, min: number, max: number) => min + Math.floor(rnd() * (max - min + 1));
const round = (n: number, step: number) => Math.round(n / step) * step;

function build(rnd: () => number, id: string, center: LatLng): Property {
  const r = rnd();
  const type: PropertyType = r < 0.5 ? 'casa' : r < 0.8 ? 'edificio' : 'finca';
  const neighborhood = pick(rnd, NEIGHBORHOODS);
  const street = pick(rnd, STREETS);
  const number = int(rnd, 10, 480);

  let areaM2: number, price: number, bedrooms: number | null, bathrooms: number | null, title: string, description: string;
  if (type === 'casa') {
    areaM2 = int(rnd, 90, 320);
    bedrooms = int(rnd, 2, 5);
    bathrooms = int(rnd, 1, 4);
    price = round(areaM2 * int(rnd, 900, 1500), 1000);
    title = `Casa ${pick(rnd, ADJ).toLowerCase()} en ${neighborhood}`;
    description = `Casa de ${bedrooms} habitaciones y ${bathrooms} baños, ${areaM2} m² de construcción, parqueadero y patio. Sector tranquilo con todos los servicios.`;
  } else if (type === 'edificio') {
    areaM2 = int(rnd, 450, 2400);
    bedrooms = null;
    bathrooms = null;
    price = round(areaM2 * int(rnd, 1100, 1900), 5000);
    title = `Edificio ${int(rnd, 3, 12)} pisos en ${neighborhood}`;
    description = `Edificio de ${areaM2} m² ideal para renta o inversión. Excelente ubicación, alta plusvalía y acceso directo a la vía principal.`;
  } else {
    areaM2 = int(rnd, 5000, 80000);
    bedrooms = int(rnd, 2, 6);
    bathrooms = int(rnd, 2, 5);
    price = round((areaM2 / 10000) * int(rnd, 60000, 150000), 1000);
    title = `Finca de ${(areaM2 / 10000).toFixed(1)} ha cerca de ${neighborhood}`;
    description = `Finca de ${(areaM2 / 10000).toFixed(1)} hectáreas con casa principal, agua propia y acceso lastrado. Ideal para vivienda campestre o proyecto productivo.`;
  }

  return { id, type, title, price, areaM2, bedrooms, bathrooms, address: `${street} N${number}, ${neighborhood}`, description, ...center };
}

export class SimulatedPropertyProvider implements PropertyProvider {
  private cache = new Map<string, Property[]>();

  private cell(ix: number, iy: number): Property[] {
    const key = `${ix}:${iy}`;
    let list = this.cache.get(key);
    if (!list) {
      const rnd = mulberry32(hashCell(ix, iy));
      list = Array.from({ length: PER_CELL }, (_, i) =>
        build(rnd, `sim-${ix}-${iy}-${i}`, {
          lat: (iy + 0.05 + rnd() * 0.9) * CELL,
          lng: (ix + 0.05 + rnd() * 0.9) * CELL,
        }),
      );
      this.cache.set(key, list);
    }
    return list;
  }

  nearby(center: LatLng, radiusM: number): Property[] {
    const span = Math.ceil(radiusM / 111000 / CELL) + 1;
    const cx = Math.floor(center.lng / CELL);
    const cy = Math.floor(center.lat / CELL);
    const out: Property[] = [];
    for (let ix = cx - span; ix <= cx + span; ix++) {
      for (let iy = cy - span; iy <= cy + span; iy++) {
        for (const p of this.cell(ix, iy)) if (distanceM(center, p) <= radiusM) out.push(p);
      }
    }
    return out;
  }
}
