import { createHash } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import webpush from 'web-push';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
// El mismo generador del cliente: el servidor "conoce" los mismos inmuebles simulados.
import { SimulatedPropertyProvider } from '../../web/src/properties/generator';
import { distanceM, formatDistance } from '../../web/src/properties/geo';
import { TYPE_LABEL, formatPrice, photos } from '../../web/src/properties/format';

const TABLE = process.env.TABLE_NAME!;
const SUBJECT = 'https://inmuebles.calolomino.dev';
const DAY = 24 * 3600;

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const provider = new SimulatedPropertyProvider();

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 40);
const now = () => Math.floor(Date.now() / 1000);

// Importante: CloudFront reescribe 403/404 a index.html, así que la API nunca responde esos códigos.
const json = (status: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode: status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
});

/** Claves VAPID: se generan una vez y quedan en DynamoDB (sin secretos en el repo). */
let vapidCache: { publicKey: string; privateKey: string } | null = null;
async function vapid() {
  if (vapidCache) return vapidCache;
  const key = { pk: 'config#vapid' };
  let item = (await db.send(new GetCommand({ TableName: TABLE, Key: key }))).Item;
  if (!item) {
    const k = webpush.generateVAPIDKeys();
    try {
      await db.send(new PutCommand({ TableName: TABLE, Item: { ...key, ...k }, ConditionExpression: 'attribute_not_exists(pk)' }));
      item = k;
    } catch {
      item = (await db.send(new GetCommand({ TableName: TABLE, Key: key }))).Item; // otra invocación ganó la carrera
    }
  }
  vapidCache = { publicKey: item!.publicKey, privateKey: item!.privateKey };
  return vapidCache;
}

interface Sub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

const validSub = (s: unknown): s is Sub => {
  const o = s as Sub | undefined;
  return (
    typeof o?.endpoint === 'string' && o.endpoint.startsWith('https://') && o.endpoint.length < 2000 &&
    typeof o.keys?.p256dh === 'string' && typeof o.keys?.auth === 'string'
  );
};

async function getSub(endpoint: unknown): Promise<Sub | null> {
  if (typeof endpoint !== 'string' || endpoint.length > 2000) return null;
  const r = await db.send(new GetCommand({ TableName: TABLE, Key: { pk: `sub#${sha(endpoint)}` } }));
  return (r.Item?.subscription as Sub | undefined) ?? null;
}

/** Envía y limpia suscripciones caducadas (410/404 del servicio de push). */
async function send(sub: Sub, payload: object): Promise<boolean> {
  const keys = await vapid();
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload), {
      vapidDetails: { subject: SUBJECT, publicKey: keys.publicKey, privateKey: keys.privateKey },
      TTL: 300,
      urgency: 'high',
    });
    return true;
  } catch (e) {
    const code = (e as { statusCode?: number }).statusCode;
    if (code === 404 || code === 410) await db.send(new DeleteCommand({ TableName: TABLE, Key: { pk: `sub#${sha(sub.endpoint)}` } }));
    console.warn('push failed', code, (e as Error).message);
    return false;
  }
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  const path = event.rawPath.replace(/\/+$/, '');
  let body: Record<string, unknown> = {};
  if (method === 'POST') {
    try {
      body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString() : (event.body ?? '{}'));
    } catch {
      return json(400, { error: 'JSON inválido' });
    }
  }

  if (method === 'GET' && path === '/api/config') return json(200, { vapidPublicKey: (await vapid()).publicKey });

  if (method === 'POST' && path === '/api/subscribe') {
    if (!validSub(body.subscription)) return json(400, { error: 'Suscripción inválida' });
    const sub = body.subscription;
    await db.send(new PutCommand({ TableName: TABLE, Item: { pk: `sub#${sha(sub.endpoint)}`, subscription: { endpoint: sub.endpoint, keys: sub.keys }, ttl: now() + 30 * DAY } }));
    return json(200, { ok: true });
  }

  if (method === 'POST' && path === '/api/unsubscribe') {
    if (typeof body.endpoint !== 'string') return json(400, { error: 'Falta endpoint' });
    await db.send(new DeleteCommand({ TableName: TABLE, Key: { pk: `sub#${sha(body.endpoint)}` } }));
    return json(200, { ok: true });
  }

  if (method === 'POST' && path === '/api/test') {
    const sub = await getSub(body.endpoint);
    if (!sub) return json(200, { ok: false, reason: 'unknown-subscription' });
    const ok = await send(sub, { title: 'Prueba de notificación', body: 'Las notificaciones push funcionan 🎉', tag: 'test' });
    return json(200, { ok });
  }

  if (method === 'POST' && path === '/api/position') {
    const lat = Number(body.lat), lng = Number(body.lng);
    const radius = Math.min(1500, Math.max(100, Number(body.radius) || 500));
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return json(400, { error: 'Posición inválida' });
    const sub = await getSub(body.endpoint);
    if (!sub) return json(200, { sent: 0, reason: 'unknown-subscription' });

    const here = { lat, lng };
    const candidates = provider
      .nearby(here, radius)
      .map((p) => ({ p, d: distanceM(here, p) }))
      .filter((x) => x.d <= radius)
      .sort((a, b) => a.d - b.d);
    const subKey = sha(sub.endpoint);
    for (const { p, d } of candidates) {
      // Un aviso por inmueble cada 30 min (la condición evita duplicados entre invocaciones concurrentes).
      try {
        await db.send(new PutCommand({ TableName: TABLE, Item: { pk: `seen#${subKey}#${p.id}`, ttl: now() + 1800 }, ConditionExpression: 'attribute_not_exists(pk) OR #t < :now', ExpressionAttributeNames: { '#t': 'ttl' }, ExpressionAttributeValues: { ':now': now() } }));
      } catch {
        continue;
      }
      const ok = await send(sub, {
        title: `${TYPE_LABEL[p.type]} en venta a ${formatDistance(d)}`,
        body: `${p.title} · ${formatPrice(p.price)}`,
        id: p.id,
        tag: `prop-${p.id}`,
        image: photos(p).hero,
      });
      return json(200, { sent: ok ? 1 : 0, id: p.id });
    }
    return json(200, { sent: 0 });
  }

  return json(400, { error: 'Ruta desconocida' });
};
