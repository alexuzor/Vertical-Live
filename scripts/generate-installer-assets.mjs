#!/usr/bin/env node
/**
 * Generates the NSIS installer artwork used by electron-builder:
 *   build/installerSidebar.bmp   164 x 314  (welcome / finish page panel)
 *   build/installerHeader.bmp    150 x 57   (inner-page header strip)
 *
 * Like the app icon, these are drawn programmatically and encoded as 24-bit
 * BMPs (the format NSIS requires) so the repository stays source-only and the
 * installer's look matches the app's brand — dark ground, the warm "V" mark,
 * an amber accent — with no binary blobs and no image dependencies.
 *
 * Run: npm run generate:installer
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'build');

/* ------------------------------------------------------------------ */
/* Brand palette                                                       */
/* ------------------------------------------------------------------ */

const BG_TOP = [10, 20, 29]; // #0a141d
const BG_BOTTOM = [6, 11, 16]; // #060b10
const AMBER = [245, 166, 35]; // #f5a623
const V_RED = [239, 47, 52]; // #ef2f34
const V_ORANGE = [245, 120, 20];
const V_YELLOW = [242, 203, 24]; // #f2cb18

/* ------------------------------------------------------------------ */
/* Canvas                                                              */
/* ------------------------------------------------------------------ */

function createCanvas(w, h) {
  return { w, h, data: new Float64Array(w * h * 3) };
}

function setPixel(canvas, x, y, [r, g, b]) {
  const i = (y * canvas.w + x) * 3;
  canvas.data[i] = r;
  canvas.data[i + 1] = g;
  canvas.data[i + 2] = b;
}

/** Alpha-blend a colour onto the canvas (canvas is always opaque). */
function blend(canvas, x, y, [r, g, b], coverage) {
  if (x < 0 || y < 0 || x >= canvas.w || y >= canvas.h || coverage <= 0) return;
  const a = Math.min(1, coverage);
  const i = (y * canvas.w + x) * 3;
  canvas.data[i] = r * a + canvas.data[i] * (1 - a);
  canvas.data[i + 1] = g * a + canvas.data[i + 1] * (1 - a);
  canvas.data[i + 2] = b * a + canvas.data[i + 2] * (1 - a);
}

/** Additive light (for glows), clamped to white. */
function addLight(canvas, x, y, [r, g, b], intensity) {
  if (x < 0 || y < 0 || x >= canvas.w || y >= canvas.h || intensity <= 0) return;
  const i = (y * canvas.w + x) * 3;
  canvas.data[i] = Math.min(255, canvas.data[i] + r * intensity);
  canvas.data[i + 1] = Math.min(255, canvas.data[i + 1] + g * intensity);
  canvas.data[i + 2] = Math.min(255, canvas.data[i + 2] + b * intensity);
}

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];

/** Warm top-to-bottom gradient of the V mark: red → orange → yellow. */
function vColour(t) {
  const c = Math.max(0, Math.min(1, t));
  return c < 0.5 ? mix(V_RED, V_ORANGE, c * 2) : mix(V_ORANGE, V_YELLOW, (c - 0.5) * 2);
}

function fillBackground(canvas) {
  for (let y = 0; y < canvas.h; y += 1) {
    const colour = mix(BG_TOP, BG_BOTTOM, y / (canvas.h - 1));
    for (let x = 0; x < canvas.w; x += 1) setPixel(canvas, x, y, colour);
  }
}

function radialGlow(canvas, cx, cy, radius, colour, strength) {
  const min = 0.0015;
  for (let y = Math.max(0, cy - radius); y < Math.min(canvas.h, cy + radius); y += 1) {
    for (let x = Math.max(0, cx - radius); x < Math.min(canvas.w, cx + radius); x += 1) {
      const d = Math.hypot(x - cx, y - cy) / radius;
      if (d >= 1) continue;
      const f = (1 - d) * (1 - d);
      if (f > min) addLight(canvas, x, y, colour, f * strength);
    }
  }
}

/** Distance from point p to segment a→b. */
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Anti-aliased thick stroke whose colour follows the vertical V gradient. */
function strokeV(canvas, ax, ay, bx, by, halfWidth, topY, bottomY) {
  const minX = Math.max(0, Math.floor(Math.min(ax, bx) - halfWidth - 2));
  const maxX = Math.min(canvas.w - 1, Math.ceil(Math.max(ax, bx) + halfWidth + 2));
  const minY = Math.max(0, Math.floor(Math.min(ay, by) - halfWidth - 2));
  const maxY = Math.min(canvas.h - 1, Math.ceil(Math.max(ay, by) + halfWidth + 2));

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const d = distToSegment(x + 0.5, y + 0.5, ax, ay, bx, by);
      const coverage = Math.max(0, Math.min(1, halfWidth - d + 0.5));
      if (coverage > 0) {
        const t = (y - topY) / (bottomY - topY);
        blend(canvas, x, y, vColour(t), coverage);
      }
    }
  }
}

/** Draws the two converging strokes of the V, with an amber glow behind it. */
function drawV(canvas, cx, topY, bottomY, halfSpan, halfStroke) {
  radialGlow(canvas, cx, (topY + bottomY) / 2, (bottomY - topY) * 0.95, AMBER, 0.5);
  strokeV(canvas, cx - halfSpan, topY, cx, bottomY, halfStroke, topY, bottomY);
  strokeV(canvas, cx + halfSpan, topY, cx, bottomY, halfStroke, topY, bottomY);
}

function fillRect(canvas, x0, y0, w, h, colour, coverage = 1) {
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) blend(canvas, x, y, colour, coverage);
  }
}

/* ------------------------------------------------------------------ */
/* 24-bit BMP encoder (bottom-up BGR, 4-byte row padding)              */
/* ------------------------------------------------------------------ */

function encodeBmp(canvas) {
  const { w, h, data } = canvas;
  const rowSize = (w * 3 + 3) & ~3;
  const pixelBytes = rowSize * h;
  const buffer = Buffer.alloc(54 + pixelBytes);

  buffer.write('BM', 0, 'ascii');
  buffer.writeUInt32LE(54 + pixelBytes, 2);
  buffer.writeUInt32LE(54, 10); // pixel data offset
  buffer.writeUInt32LE(40, 14); // DIB header size
  buffer.writeInt32LE(w, 18);
  buffer.writeInt32LE(h, 22); // positive = bottom-up
  buffer.writeUInt16LE(1, 26); // planes
  buffer.writeUInt16LE(24, 28); // bpp
  buffer.writeUInt32LE(pixelBytes, 34);
  buffer.writeInt32LE(2835, 38); // ~72 DPI
  buffer.writeInt32LE(2835, 42);

  let offset = 54;
  for (let y = h - 1; y >= 0; y -= 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 3;
      buffer[offset] = Math.round(Math.max(0, Math.min(255, data[i + 2]))); // B
      buffer[offset + 1] = Math.round(Math.max(0, Math.min(255, data[i + 1]))); // G
      buffer[offset + 2] = Math.round(Math.max(0, Math.min(255, data[i]))); // R
      offset += 3;
    }
    offset += rowSize - w * 3; // row padding
  }
  return buffer;
}

/* ------------------------------------------------------------------ */
/* Compositions                                                        */
/* ------------------------------------------------------------------ */

function buildSidebar() {
  const canvas = createCanvas(164, 314);
  fillBackground(canvas);
  radialGlow(canvas, 82, 30, 150, AMBER, 0.28);
  drawV(canvas, 82, 66, 198, 42, 13);
  // Amber accent rule + a muted 9:16 "portrait" motif echoing the app.
  fillRect(canvas, 34, 244, 96, 2, AMBER, 0.85);
  const fw = 26;
  const fh = 46;
  const fx = 82 - fw / 2;
  const fy = 262;
  const line = mix(BG_BOTTOM, [80, 92, 104], 1);
  fillRect(canvas, fx, fy, fw, 2, line, 0.7);
  fillRect(canvas, fx, fy + fh - 2, fw, 2, line, 0.7);
  fillRect(canvas, fx, fy, 2, fh, line, 0.7);
  fillRect(canvas, fx + fw - 2, fy, 2, fh, line, 0.7);
  return canvas;
}

function buildHeader() {
  const canvas = createCanvas(150, 57);
  fillBackground(canvas);
  drawV(canvas, 122, 13, 45, 17, 5);
  return canvas;
}

/* ------------------------------------------------------------------ */

function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const sidebar = join(OUT_DIR, 'installerSidebar.bmp');
  writeFileSync(sidebar, encodeBmp(buildSidebar()));
  console.log(`[installer] Wrote ${sidebar} (164 x 314)`);

  const header = join(OUT_DIR, 'installerHeader.bmp');
  writeFileSync(header, encodeBmp(buildHeader()));
  console.log(`[installer] Wrote ${header} (150 x 57)`);
}

main();
