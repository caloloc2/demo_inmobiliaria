import type { LatLng } from '../properties/types';
import { distanceM } from '../properties/geo';

export type PushState = 'unsupported' | 'needs-install' | 'denied' | 'off' | 'on';

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

function urlBase64ToUint8Array(b64: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function currentSubscription(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

export async function pushState(): Promise<PushState> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    // En iPhone fuera de la pantalla de inicio el navegador no expone PushManager.
    return isIos() && !isStandalone() ? 'needs-install' : 'unsupported';
  }
  if (isIos() && !isStandalone()) return 'needs-install';
  if (Notification.permission === 'denied') return 'denied';
  return (await currentSubscription()) ? 'on' : 'off';
}

/** Debe llamarse desde un gesto del usuario (requisito de iOS). */
export async function enablePush(): Promise<PushState> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';
  const reg = await navigator.serviceWorker.ready;
  const { vapidPublicKey } = await api<{ vapidPublicKey: string }>('config');
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) }));
  await api('subscribe', { subscription: sub.toJSON() });
  return 'on';
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await api('unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}

export async function sendTestPush(): Promise<boolean> {
  const sub = await currentSubscription();
  if (!sub) return false;
  const r = await api<{ ok: boolean }>('test', { endpoint: sub.endpoint });
  return r.ok;
}

// --- Posición hacia el servidor: él decide qué inmueble queda cerca y manda el push ---
let lastSent = 0;
let lastPos: LatLng | null = null;

export async function reportPosition(pos: LatLng, radiusM: number): Promise<void> {
  const now = Date.now();
  if (now - lastSent < 20000 || (lastPos && distanceM(lastPos, pos) < 40)) return;
  const sub = await currentSubscription();
  if (!sub) return;
  lastSent = now;
  lastPos = pos;
  await api('position', { endpoint: sub.endpoint, lat: pos.lat, lng: pos.lng, radius: radiusM }).catch(() => {});
}
