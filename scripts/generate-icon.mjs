#!/usr/bin/env node
/**
 * Generates `build/icon.ico`, the Windows application icon used by
 * electron-builder for the executable, the installer and the shortcuts.
 *
 * The icon is drawn programmatically rather than committed as a binary blob so
 * the repository stays source-only and the icon is reproducible. It contains
 * the standard Windows sizes (16/24/32/48/64/128 as 32-bit DIBs plus 256 as an
 * embedded PNG), which is what Explorer and the shell expect.
 *
 * Run: npm run generate:icon
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'build');
const OUT_FILE = join(OUT_DIR, 'icon.ico');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const BASE = 256;

/* ------------------------------------------------------------------ */
/* Drawing                                                             */
/* ------------------------------------------------------------------ */

const COLOURS = {
  background: [20, 24, 30, 255],
  frame: [231, 236, 243, 255],
  frameEdge: [61, 139, 253, 255],
  live: [239, 68, 68, 255],
};

/** An RGBA canvas with just enough primitives for this one icon. */
function createCanvas(size) {
  return { size, data: new Uint8ClampedArray(size * size * 4) };
}

function blend(canvas, x, y, [r, g, b, a], coverage) {
  if (x < 0 || y < 0 || x >= canvas.size || y >= canvas.size) return;
  const alpha = (a / 255) * coverage;
  if (alpha <= 0) return;

  const index = (y * canvas.size + x) * 4;
  const data = canvas.data;
  const destAlpha = data[index + 3] / 255;
  const outAlpha = alpha + destAlpha * (1 - alpha);
  if (outAlpha <= 0) return;

  data[index] = (r * alpha + data[index] * destAlpha * (1 - alpha)) / outAlpha;
  data[index + 1] = (g * alpha + data[index + 1] * destAlpha * (1 - alpha)) / outAlpha;
  data[index + 2] = (b * alpha + data[index + 2] * destAlpha * (1 - alpha)) / outAlpha;
  data[index + 3] = outAlpha * 255;
}

/** Signed distance to a rounded rectangle, used for cheap anti-aliasing. */
function roundedRectDistance(px, py, cx, cy, halfWidth, halfHeight, radius) {
  const dx = Math.abs(px - cx) - (halfWidth - radius);
  const dy = Math.abs(py - cy) - (halfHeight - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

function fillRoundedRect(canvas, cx, cy, halfWidth, halfHeight, radius, colour) {
  const minX = Math.max(0, Math.floor(cx - halfWidth - 2));
  const maxX = Math.min(canvas.size - 1, Math.ceil(cx + halfWidth + 2));
  const minY = Math.max(0, Math.floor(cy - halfHeight - 2));
  const maxY = Math.min(canvas.size - 1, Math.ceil(cy + halfHeight + 2));

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const distance = roundedRectDistance(
        x + 0.5,
        y + 0.5,
        cx,
        cy,
        halfWidth,
        halfHeight,
        radius,
      );
      const coverage = Math.min(1, Math.max(0, 0.5 - distance));
      if (coverage > 0) blend(canvas, x, y, colour, coverage);
    }
  }
}

function fillCircle(canvas, cx, cy, radius, colour) {
  const minX = Math.max(0, Math.floor(cx - radius - 2));
  const maxX = Math.min(canvas.size - 1, Math.ceil(cx + radius + 2));
  const minY = Math.max(0, Math.floor(cy - radius - 2));
  const maxY = Math.min(canvas.size - 1, Math.ceil(cy + radius + 2));

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - radius;
      const coverage = Math.min(1, Math.max(0, 0.5 - distance));
      if (coverage > 0) blend(canvas, x, y, colour, coverage);
    }
  }
}

/**
 * The mark: a dark rounded tile containing a bright 9:16 portrait frame with a
 * blue outline and a small red "live" dot. Reads clearly down to 16x16.
 */
function drawIcon() {
  const canvas = createCanvas(BASE);
  const centre = BASE / 2;

  fillRoundedRect(canvas, centre, centre, centre, centre, BASE * 0.22, COLOURS.background);

  // 9:16 portrait frame, with the accent as a 1-unit outline behind it.
  const frameHeight = BASE * 0.62;
  const frameWidth = (frameHeight * 9) / 16;
  const outline = BASE * 0.028;

  fillRoundedRect(
    canvas,
    centre,
    centre,
    frameWidth / 2 + outline,
    frameHeight / 2 + outline,
    BASE * 0.055,
    COLOURS.frameEdge,
  );
  fillRoundedRect(
    canvas,
    centre,
    centre,
    frameWidth / 2,
    frameHeight / 2,
    BASE * 0.04,
    COLOURS.frame,
  );

  fillCircle(canvas, centre, centre - frameHeight * 0.24, BASE * 0.055, COLOURS.live);

  return canvas;
}

/** Box-filter downscale. Good enough and dependency free. */
function resize(source, size) {
  const target = createCanvas(size);
  const ratio = source.size / size;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const startX = Math.floor(x * ratio);
      const endX = Math.min(source.size, Math.ceil((x + 1) * ratio));
      const startY = Math.floor(y * ratio);
      const endY = Math.min(source.size, Math.ceil((y + 1) * ratio));

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;

      for (let sy = startY; sy < endY; sy += 1) {
        for (let sx = startX; sx < endX; sx += 1) {
          const index = (sy * source.size + sx) * 4;
          const alpha = source.data[index + 3] / 255;
          r += source.data[index] * alpha;
          g += source.data[index + 1] * alpha;
          b += source.data[index + 2] * alpha;
          a += source.data[index + 3];
          count += 1;
        }
      }

      if (count === 0) continue;
      const outIndex = (y * size + x) * 4;
      const meanAlpha = a / count / 255;
      target.data[outIndex] = meanAlpha > 0 ? r / count / meanAlpha : 0;
      target.data[outIndex + 1] = meanAlpha > 0 ? g / count / meanAlpha : 0;
      target.data[outIndex + 2] = meanAlpha > 0 ? b / count / meanAlpha : 0;
      target.data[outIndex + 3] = a / count;
    }
  }

  return target;
}

/* ------------------------------------------------------------------ */
/* PNG encoding (for the 256x256 entry)                                */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, payload) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, payload])), 0);
  return Buffer.concat([length, typeBuffer, payload, crc]);
}

function encodePng(canvas) {
  const { size, data } = canvas;

  // Each scanline is prefixed with filter type 0 (None).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let offset = 0;
  for (let y = 0; y < size; y += 1) {
    raw[offset] = 0;
    offset += 1;
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      raw[offset] = data[index];
      raw[offset + 1] = data[index + 1];
      raw[offset + 2] = data[index + 2];
      raw[offset + 3] = data[index + 3];
      offset += 4;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ */
/* ICO encoding                                                        */
/* ------------------------------------------------------------------ */

/** 32-bit BGRA DIB with an all-opaque AND mask, stored bottom-up. */
function encodeDib(canvas) {
  const { size, data } = canvas;

  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight: XOR + AND stacked
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // BI_RGB

  const xor = Buffer.alloc(size * size * 4);
  let offset = 0;
  for (let y = size - 1; y >= 0; y -= 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      xor[offset] = data[index + 2]; // B
      xor[offset + 1] = data[index + 1]; // G
      xor[offset + 2] = data[index]; // R
      xor[offset + 3] = data[index + 3]; // A
      offset += 4;
    }
  }

  // The AND mask is ignored for 32-bit icons but must still be present and
  // padded to a 4-byte row stride.
  const maskStride = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskStride * size, 0);

  return Buffer.concat([header, xor, mask]);
}

function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let dataOffset = header.length + directory.length;
  const payloads = [];

  images.forEach((image, index) => {
    const entry = 16 * index;
    directory[entry] = image.size >= 256 ? 0 : image.size;
    directory[entry + 1] = image.size >= 256 ? 0 : image.size;
    directory[entry + 2] = 0; // palette size
    directory[entry + 3] = 0; // reserved
    directory.writeUInt16LE(1, entry + 4); // colour planes
    directory.writeUInt16LE(32, entry + 6); // bits per pixel
    directory.writeUInt32LE(image.payload.length, entry + 8);
    directory.writeUInt32LE(dataOffset, entry + 12);

    payloads.push(image.payload);
    dataOffset += image.payload.length;
  });

  return Buffer.concat([header, directory, ...payloads]);
}

/* ------------------------------------------------------------------ */

function main() {
  const master = drawIcon();

  const images = SIZES.map((size) => {
    const canvas = size === BASE ? master : resize(master, size);
    // 256x256 is stored as PNG (the modern convention); smaller sizes as DIBs
    // for maximum compatibility with older shell components.
    const payload = size === 256 ? encodePng(canvas) : encodeDib(canvas);
    return { size, payload };
  });

  mkdirSync(OUT_DIR, { recursive: true });
  const ico = buildIco(images);
  writeFileSync(OUT_FILE, ico);

  console.log(`[icon] Wrote ${OUT_FILE} (${ico.length} bytes, sizes: ${SIZES.join(', ')})`);
}

main();
