import { distanceM, formatDistance } from '../properties/geo';
import { TYPE_LABEL, formatPrice } from '../properties/format';
import type { LatLng, Property, PropertyProvider } from '../properties/types';

export interface AlertSettings {
  enabled: boolean;
  radiusM: number;
}

const KEY = 'inmuebles.alerts.v1';
const COOLDOWN_MS = 15 * 60 * 1000;
export const RADII = [200, 300, 500, 1000];

function load(): AlertSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { enabled: true, radiusM: 500, ...JSON.parse(raw) };
  } catch {
    /* almacenamiento no disponible */
  }
  return { enabled: true, radiusM: 500 };
}

export function createAlerts(provider: PropertyProvider, onAlert: (p: Property, distM: number) => void) {
  let settings = load();
  /** Último aviso por inmueble; evita repetir la alerta cada segundo. */
  const lastSeen = new Map<string, number>();
  let ignoreId: string | null = null;

  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(settings));
    } catch {
      /* ignorar */
    }
  };

  return {
    get settings() {
      return settings;
    },
    update(patch: Partial<AlertSettings>) {
      settings = { ...settings, ...patch };
      save();
    },
    /** Vuelve a permitir avisos (p. ej. al repetir una simulación). */
    reset() {
      lastSeen.clear();
    },
    /** No avisar del inmueble al que ya estás navegando. */
    setDestination(id: string | null) {
      ignoreId = id;
    },
    /** Evalúa una posición. Avisa solo del inmueble más cercano que aún no se avisó. */
    check(pos: LatLng) {
      if (!settings.enabled) return;
      const now = Date.now();
      let best: { p: Property; d: number } | null = null;
      for (const p of provider.nearby(pos, settings.radiusM)) {
        if (p.id === ignoreId) continue;
        if (now - (lastSeen.get(p.id) ?? 0) < COOLDOWN_MS) continue;
        const d = distanceM(pos, p);
        if (d <= settings.radiusM && (!best || d < best.d)) best = { p, d };
      }
      if (!best) return;
      lastSeen.set(best.p.id, now);
      onAlert(best.p, best.d);
      void showSystemNotification(best.p, best.d);
    },
  };
}

/** Notificación del sistema (con la app abierta o no); la etiqueta evita duplicados con el push del servidor. */
async function showSystemNotification(p: Property, distM: number) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification(`${TYPE_LABEL[p.type]} en venta a ${formatDistance(distM)}`, {
      body: `${p.title} · ${formatPrice(p.price)}`,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: `prop-${p.id}`,
      data: { id: p.id },
    });
  } catch {
    /* sin Service Worker activo */
  }
}
