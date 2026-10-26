# Inmuebles en Ruta — Demo MVP

PWA instalable (Android/iOS) que muestra inmuebles en venta cerca del usuario mientras navega.
Producción del demo: https://inmuebles.calolomino.dev

- `web/` — Vite + TypeScript + vite-plugin-pwa (landing en `/`, app en `/app/`)
- `infra/` — AWS CDK: S3 privado + CloudFront (OAC) + ACM + Route 53 (`inmuebles.calolomino.dev`)

## Despliegue
```
cd web && npm ci && npm run build
cd ../infra && npm ci && npx cdk deploy
```
Estado: Fase 1 (PWA instalable + landing + infraestructura). Siguiente: mapa, GPS e inmuebles simulados.

## Fase 4: alertas y push
- Alertas de cercanía en el cliente (`web/src/app/alerts.ts`): radio configurable, aviso dentro de la app + notificación del sistema.
- Web Push con VAPID (`infra/lambda/handler.ts`): Lambda con URL pública detrás de CloudFront (`/api/*`), DynamoDB para suscripciones y avisos recientes. Las claves VAPID se generan en el primer uso y se guardan en DynamoDB.
- Service Worker propio (`web/src/sw.ts`) con `push` y `notificationclick` (abre la ficha del inmueble).
- Limitación de las PWA: el GPS solo funciona con la app abierta; para alertas con la app cerrada se necesita app nativa.

## Fotos
Las fotos de `web/public/photos/` son imágenes de stock de Unsplash (licencia libre, sin atribución obligatoria), usadas solo como relleno del demo; se reemplazarán por las fotos reales de cada inmueble.
