// Draws the PhoneDrop app icon (a phone with a down arrow on a blue rounded square) and writes
// build/icon.png (512x512, used by electron-builder for the .exe/installer) and electron/icon.png (256x256, window) and electron/tray.png (32x32).
// Zero dependencies. Usage: node scripts/make-icon.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.join(__dirname, '..');

// Signed distance to a rounded rectangle centred at (cx, cy) with half-size (hw, hh) and corner radius r.
function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - hw + r, qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
// Signed distance to a line segment with half-thickness t.
function sdSegment(x, y, ax, ay, bx, by, t) {
  const px = x - ax, py = y - ay, dx = bx - ax, dy = by - ay;
  const h = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - dx * h, py - dy * h) - t;
}
const cover = (d, aa) => Math.max(0, Math.min(1, 0.5 - d / aa)); // anti-aliased coverage

// Shapes in a 0..1 coordinate space.
function shade(u, v, aa) {
  // Background: rounded square, vertical gradient.
  const bg = cover(sdRoundRect(u, v, 0.5, 0.5, 0.47, 0.47, 0.2), aa);
  const top = [79, 140, 255], bot = [44, 92, 230];
  let col = top.map((c, i) => c + (bot[i] - c) * v);
  // Phone outline.
  const outer = sdRoundRect(u, v, 0.5, 0.5, 0.2, 0.32, 0.07);
  const ring = cover(Math.abs(outer + 0.022) - 0.022, aa);
  // Down arrow inside the phone.
  const t = 0.028;
  const arrow = cover(Math.min(
    sdSegment(u, v, 0.5, 0.33, 0.5, 0.6, t),
    sdSegment(u, v, 0.5, 0.62, 0.4, 0.52, t),
    sdSegment(u, v, 0.5, 0.62, 0.6, 0.52, t),
  ), aa);
  // Home bar.
  const bar = cover(sdSegment(u, v, 0.46, 0.72, 0.54, 0.72, 0.012), aa);
  const fg = Math.max(ring, arrow, bar);
  col = col.map(c => c + (255 - c) * fg);
  return [...col, 255 * bg];
}

function render(size) {
  const ss = 4; // supersampling per axis
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const acc = [0, 0, 0, 0];
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const c = shade((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size, 1 / size);
      const a = c[3] / 255;
      for (let i = 0; i < 3; i++) acc[i] += c[i] * a;
      acc[3] += a;
    }
    const o = (y * size + x) * 4;
    for (let i = 0; i < 3; i++) px[o + i] = acc[3] ? Math.round(acc[i] / acc[3]) : 0;
    px[o + 3] = Math.round(acc[3] / (ss * ss) * 255);
  }
  return encodePng(size, px);
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (const b of buf) {
    c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.writeFileSync(path.join(root, 'build', 'icon.png'), render(512));
fs.writeFileSync(path.join(root, 'electron', 'icon.png'), render(256));
fs.writeFileSync(path.join(root, 'electron', 'tray.png'), render(32));
console.log('Wrote build/icon.png, electron/icon.png, electron/tray.png');
