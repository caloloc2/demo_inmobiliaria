import type { LatLng } from '../properties/types';

export interface Fix extends LatLng {
  heading: number | null;
  accuracy: number;
  /** Velocidad en m/s, si el dispositivo la entrega. */
  speed: number | null;
}

/** Quito: ubicación por defecto si el GPS no está disponible o fue denegado. */
export const DEFAULT_LOCATION: LatLng = { lat: -0.1807, lng: -78.4678 };

export type GpsStatus = 'ok' | 'denied' | 'unavailable';

/** Sigue el GPS del dispositivo. Devuelve una función para detenerlo. */
export function watchGps(onFix: (f: Fix) => void, onStatus: (s: GpsStatus) => void): () => void {
  if (!('geolocation' in navigator)) {
    onStatus('unavailable');
    return () => {};
  }
  const id = navigator.geolocation.watchPosition(
    (pos) => {
      onStatus('ok');
      onFix({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        heading: pos.coords.heading != null && !Number.isNaN(pos.coords.heading) ? pos.coords.heading : null,
        accuracy: pos.coords.accuracy,
        speed: pos.coords.speed != null && !Number.isNaN(pos.coords.speed) ? pos.coords.speed : null,
      });
    },
    (err) => onStatus(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable'),
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 },
  );
  return () => navigator.geolocation.clearWatch(id);
}
