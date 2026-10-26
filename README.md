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
