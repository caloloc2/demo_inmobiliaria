import sharp from 'sharp';
import { readFileSync } from 'node:fs';

const svg = readFileSync('public/icon.svg');
const out = (name, size, extra = {}) =>
  sharp(svg, { density: 384 }).resize(size, size).png().toFile(`public/${name}`);

await out('icon-192.png', 192);
await out('icon-512.png', 512);
await out('apple-touch-icon.png', 180);
// Maskable: contenido en la zona segura (80%) sobre fondo sólido.
const inner = await sharp(svg, { density: 384 }).resize(410, 410).png().toBuffer();
await sharp({ create: { width: 512, height: 512, channels: 4, background: '#8fd3fa' } })
  .composite([{ input: inner, gravity: 'center' }])
  .png()
  .toFile('public/icon-maskable-512.png');
console.log('icons ok');
