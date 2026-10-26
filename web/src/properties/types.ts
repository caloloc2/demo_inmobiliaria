export type PropertyType = 'casa' | 'edificio' | 'finca';

export interface LatLng {
  lat: number;
  lng: number;
}

export interface Property extends LatLng {
  id: string;
  type: PropertyType;
  title: string;
  price: number;
  areaM2: number;
  bedrooms: number | null;
  bathrooms: number | null;
  address: string;
  condition: string;
  rating: number;
  reviews: number;
  description: string;
}

/** Punto de extensión: hoy datos simulados, mañana una API real. */
export interface PropertyProvider {
  /** Inmuebles en venta dentro de `radiusM` metros de `center`. */
  nearby(center: LatLng, radiusM: number): Property[];
  get(id: string): Property | undefined;
}
