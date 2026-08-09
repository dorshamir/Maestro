#!/usr/bin/env node
/*
 * Rasterises assets/maestro.svg into assets/maestro.ico.
 *
 * The logo is only rectangles, rounded rectangles and circles, so it is cheaper
 * to rasterise those shapes directly than to take on an SVG/PNG dependency -
 * and Maestro's whole point is that it installs with zero of them. zlib (for
 * the PNG entries) ships with Node.
 *
 *   node tools/make-icon.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'assets', 'maestro.ico');
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SS = 4; // supersampling factor -> antialiased edges

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const INK = hex('#16151A'), EDGE = hex('#2A2831'), BRASS = hex('#C8A24C');
const IVORY = hex('#F2E9D8'), CORK = hex('#8A5738'), TRAIL = hex('#575165');

// Shapes in the same 256-unit space as the SVG.
const rrect = (x, y, w, h, r) => (px, py) => {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r + 1e-9;
};
const circle = (cx, cy, r) => (px, py) => (px - cx) ** 2 + (py - cy) ** 2 <= r * r;

/** Tapered rounded stick from (x1,y1) to (x2,y2), radius r1 -> r2. */
const capsule = (x1, y1, x2, y2, r1, r2) => (px, py) => {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.min(1, Math.max(0, t));
  const cx = x1 + t * dx, cy = y1 + t * dy;
  const r = r1 + (r2 - r1) * t;
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
};

/** Slice of a ring. Angles in degrees, measured clockwise from +x (y grows down). */
const arcRing = (cx, cy, rIn, rOut, a0, a1) => (px, py) => {
  const d = Math.hypot(px - cx, py - cy);
  if (d < rIn || d > rOut) return false;
  let a = Math.atan2(py - cy, px - cx) * 180 / Math.PI;
  if (a < 0) a += 360;
  return a0 <= a1 ? (a >= a0 && a <= a1) : (a >= a0 || a <= a1);
};

// A conductor's baton, caught mid-gesture, sweeping through the arc it just
// traced. The baton is the one object that means "maestro" at a glance, and a
// single bold diagonal survives being scaled down to a 16px favicon - which the
// previous repeat-sign mark, all thin bars and small dots, did not.
// Painted back to front; the baton crosses over its own trail.
const TIP = [198, 60], HEEL = [64, 196];
const LAYERS = [
  { hit: rrect(0, 0, 256, 256, 52), color: INK },
  // inset hairline frame: inside the outer round-rect but not the inner one
  { hit: (x, y) => rrect(20, 20, 216, 216, 36)(x, y) && !rrect(22, 22, 212, 212, 34)(x, y), color: EDGE },
  // The gesture: a wide sweep the baton cuts across. Struck low and broad so it
  // reads as a traced path rather than a smudge behind the handle.
  { hit: arcRing(128, 240, 100, 107, 210, 330), color: TRAIL },
  // Ivory shaft first, tapering to a fine point; then the cork handle painted
  // over its base. Order matters - with the shaft on top its rounded end
  // bulged out through the handle as a pale notch.
  { hit: capsule(80, 180, TIP[0], TIP[1], 8, 2.4), color: IVORY },
  { hit: capsule(HEEL[0], HEEL[1], 100, 160, 13.5, 10), color: CORK },
  // Brass collar over the joint - the one warm accent, and what keeps the mark
  // recognisably Maestro's rather than a generic diagonal.
  { hit: capsule(96, 164, 112, 148, 9.8, 8.2), color: BRASS },
  // the downbeat: where the tip lands
  { hit: circle(TIP[0], TIP[1], 5.5), color: BRASS },
];

/** Render one size to a flat RGBA buffer (row-major, top-down). */
function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const scale = 256 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ux = (x + (sx + 0.5) / SS) * scale;
          const uy = (y + (sy + 0.5) / SS) * scale;
          let c = null;
          for (const layer of LAYERS) if (layer.hit(ux, uy)) c = layer.color;
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
        }
      }
      const n = SS * SS, i = (y * size + x) * 4;
      // Un-premultiply so partly covered edge pixels keep full colour.
      px[i] = a ? Math.round(r / (a / 255)) : 0;
      px[i + 1] = a ? Math.round(g / (a / 255)) : 0;
      px[i + 2] = a ? Math.round(b / (a / 255)) : 0;
      px[i + 3] = Math.round(a / n);
    }
  }
  return px;
}

/* ------------------------------------------------------------------ PNG */

function crc32(buf) {
  let c, table = crc32.t;
  if (!table) {
    table = crc32.t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function toPng(px, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ BMP */

// ICO's BMP entries are bottom-up BGRA with a doubled height in the header and
// a 1-bit AND mask appended (ignored for 32bpp, but required to be present).
function toBmp(px, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);   // height counts colour + mask planes
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const body = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4;
      const d = ((size - 1 - y) * size + x) * 4;
      body[d] = px[s + 2]; body[d + 1] = px[s + 1]; body[d + 2] = px[s]; body[d + 3] = px[s + 3];
    }
  }
  const maskRow = Math.ceil(size / 32) * 4;
  return Buffer.concat([header, body, Buffer.alloc(maskRow * size)]);
}

/* ------------------------------------------------------------------ ICO */

const images = SIZES.map((size) => {
  const px = render(size);
  // PNG entries are only universally understood at 256; keep BMP below that.
  return { size, data: size >= 256 ? toPng(px, size) : toBmp(px, size) };
});

const dir = Buffer.alloc(6 + 16 * images.length);
dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(images.length, 4);
let offset = dir.length;
images.forEach((img, i) => {
  const e = 6 + i * 16;
  dir[e] = img.size >= 256 ? 0 : img.size;      // 0 means 256
  dir[e + 1] = img.size >= 256 ? 0 : img.size;
  dir[e + 2] = 0; dir[e + 3] = 0;
  dir.writeUInt16LE(1, e + 4);
  dir.writeUInt16LE(32, e + 6);
  dir.writeUInt32LE(img.data.length, e + 8);
  dir.writeUInt32LE(offset, e + 12);
  offset += img.data.length;
});

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.concat([dir, ...images.map((i) => i.data)]));
console.log(`wrote ${OUT} (${SIZES.join(', ')} px, ${(fs.statSync(OUT).size / 1024).toFixed(1)} KB)`);

