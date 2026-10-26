# Inmuebles en Ruta — memoria del proyecto

PWA instalable (Android/iOS) tipo Waze/Google Maps que muestra inmuebles en venta cerca del usuario mientras navega (auto/a pie) y avisa al pasar cerca. **Demo MVP** para validar el producto con una empresa inmobiliaria: los datos son simulados (sin base de datos).

- **URL del demo:** https://inmuebles.calolomino.dev (landing en `/`, app en `/app/`)
- **Repo/rama de trabajo:** `caloloc2/demo_inmobiliaria`, rama `claude/focused-euler-awli82` (no abrir PR salvo que el usuario lo pida)
- **Idioma:** todo en español (UI, commits, documentos). El usuario es de Ecuador (formato `$3.310.000`, decimales con coma).
- **Estado:** Fases 1–5 completas y desplegadas. El usuario pidió dejar el demo así por ahora.

## Estructura
```
web/    Vite + TypeScript + MapLibre GL + vite-plugin-pwa (injectManifest)
  app/index.html, index.html      app y landing (multi-página)
  src/app/main.ts                 pantalla principal: inicio, mapa, pines, ficha, búsqueda, temas, alertas
  src/app/navigation.ts           ruta, navegación 3D, simulación, carriles, calle actual, brújula, demo
  src/app/alerts.ts, push.ts      alertas de cercanía (local) y Web Push (cliente)
  src/app/gps.ts                  watchPosition + zona por defecto (Quito)
  src/nav/{route,geom,simulator}.ts   OSRM, geometría, simulador de GPS
  src/properties/{generator,format,geo,types}.ts   inmuebles simulados (PropertyProvider), fotos, formatos
  src/sw.ts                       Service Worker: precache, caché de /photos/, push, notificationclick
  public/photos/                  48 fotos de stock (Unsplash) elegidas a mano
infra/  AWS CDK (stack `InmueblesWeb`, us-east-1) + lambda/handler.ts (API de push)
docs/   guias en PDF (técnica y comercial) y su fuente HTML en docs/guia/
```

## Comandos
```
cd web && npm ci && npm run build            # tipos + build
cd infra && npm ci && npx cdk deploy --require-approval never   # despliega todo (1–3 min)
npm run icons (en web)                       # regenera iconos PNG desde public/icon.svg
```
- Despliegue: S3 privado + CloudFront (OAC) + ACM + registros A/AAAA `inmuebles` en la zona Route 53 `calolomino.dev` (zona y otros registros existentes NO se tocan). `/api/*` va a una Lambda (Function URL) detrás del mismo CloudFront.
- AWS se usa con credenciales inyectadas por el proxy de la sesión (usuario IAM `admin-cli`, administrador). Recomendado a futuro: rol de menor privilegio + OIDC en CI.
- PDFs: se generan con Playwright (Chromium) desde `docs/guia/guia.html` (guía técnica) y `docs/guia/propuesta.html` (propuesta comercial). Capturas en `docs/guia/img/`.

## Decisiones y trampas aprendidas (leer antes de tocar)
- **MapLibre + Vite:** el worker no carga solo; se importa `maplibre-gl-worker.mjs?worker&url` y `setWorkerUrl`. Sin eso el mapa base sale en blanco.
- **Marcadores MapLibre:** nunca poner `position: relative` en el elemento del marker (rompe su posición). Usar `absolute`.
- **Capas personalizadas** (ruta, edificios 3D) se insertan antes de la primera etiqueta *posterior a la última capa de calles* (`firstSymbolId()`); en el estilo oscuro las etiquetas van antes de las calles. Se recrean en `style.load` al cambiar día/noche.
- **CloudFront** reescribe 403/404 a `index.html` (SPA): la API nunca devuelve 403/404 (usa 400/200). Una CloudFront Function convierte `/app/` en `/app/index.html`.
- **OSRM público** (`routing.openstreetmap.de`, perfiles car/foot) sin clave; si falla, `straightRoute()` dibuja línea recta y lo avisa. En el navegador headless del sandbox el fetch a ese host falla (CORS/red), en curl funciona: para probar se intercepta con `page.route`.
- **Carriles:** implementados, pero OSM no los trae en Guayaquil; solo aparecen donde existan.
- **Push:** VAPID se genera en la primera invocación de la Lambda y se guarda en DynamoDB (`config#vapid`). La API exige cabecera `Origin` = el sitio. El push real **no se pudo probar en el sandbox** (headless sin permiso de notificaciones ni salida a FCM/APNs).
- **PWA:** no hay GPS en segundo plano; alertas con app cerrada requieren app nativa (Capacitor/React Native). iOS solo permite push con la app instalada en inicio (16.4+). Cache del SW: actualizar = cerrar la app y abrir dos veces.
- **Tema:** día/noche automático (noche 19:00–05:00) y manual (`localStorage inmuebles.theme`). Nombre del usuario: `inmuebles.name` (por defecto «Andrea»).
- No hay `ReservedConcurrency` en la Lambda (cuentas nuevas pueden tener poca concurrencia libre). API pública sin autenticación: aceptable solo para demo.

## Pendiente / siguientes pasos (no iniciados)
1. **Validar en teléfonos reales** (Android e iPhone): GPS en movimiento, rendimiento del 3D, y sobre todo push real («Activar notificaciones» → «Enviar prueba»). Checklist en la guía técnica.
2. Base de datos real de inmuebles (PostGIS o DynamoDB+geohash) y panel de carga; sustituir `SimulatedPropertyProvider` implementando `PropertyProvider` (`nearby`, `get`).
3. Cuentas, favoritos, contacto con asesor (llamada/WhatsApp), agenda de visitas.
4. App nativa para alertas con la app cerrada; proveedor de mapas/rutas con contrato si hace falta.
5. Rol IAM de menor privilegio y despliegue por CI (hoy el CI solo compila y hace `cdk synth`).

## Convenciones de trabajo con este usuario
- Pide fases y revisa en su teléfono; reporta con honestidad qué se probó y qué no (el sandbox no puede probar push ni GPS real).
- Commits en español con pie `Co-Authored-By` y `Claude-Session` según indique el sistema; empujar siempre a la rama `claude/focused-euler-awli82`.
