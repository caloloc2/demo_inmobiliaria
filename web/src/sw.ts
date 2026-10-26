/// <reference lib="webworker" />
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';

declare const self: ServiceWorkerGlobalScope;

self.skipWaiting();
self.addEventListener('activate', () => void self.clients.claim());

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);
// La landing funciona offline; la app (/app/) y la API siempre salen a la red / precache propio.
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/app\//, /^\/api\//] }));

// Las fotos no se precargan (pesan varios MB): se guardan al verlas y quedan disponibles sin red.
registerRoute(
  ({ url }) => url.pathname.startsWith('/photos/'),
  new CacheFirst({ cacheName: 'photos', plugins: [new ExpirationPlugin({ maxEntries: 120, maxAgeSeconds: 60 * 24 * 3600 })] }),
);

interface PushPayload {
  title: string;
  body: string;
  /** Id del inmueble; al tocar la notificación se abre su ficha. */
  id?: string | null;
  tag?: string;
  image?: string;
}

self.addEventListener('push', (event) => {
  let data: PushPayload = { title: 'Inmuebles en Ruta', body: 'Hay un inmueble cerca de ti' };
  try {
    data = { ...data, ...(event.data?.json() as PushPayload) };
  } catch {
    /* payload no JSON: usar el texto por defecto */
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      // Misma etiqueta que la alerta local: si llegan las dos, se reemplazan en vez de duplicarse.
      tag: data.tag ?? (data.id ? `prop-${data.id}` : 'inmuebles'),
      data: { id: data.id ?? null },
      ...(data.image ? { image: data.image } : {}),
    } as NotificationOptions),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const id = (event.notification.data as { id: string | null } | undefined)?.id ?? null;
  const url = id ? `/app/?p=${encodeURIComponent(id)}` : '/app/';
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = wins.find((w) => new URL(w.url).pathname.startsWith('/app'));
      if (open) {
        await open.focus();
        if (id) open.postMessage({ type: 'open-property', id });
      } else {
        await self.clients.openWindow(url);
      }
    })(),
  );
});
