/**
 * Deterministic icon generation.
 *
 * https://github.com/Akalanka1337/NeuraTube
 * 
 * Writes public/icons/icon-{16,32,48,128}.png with no image dependencies: a
 * minimal PNG encoder over Node's built-in zlib. Rationale — an extension that
 * asks users to trust it with API keys should not pull an image-processing tree
 * into its toolchain, and generated icons mean the mark is reproducible from
 * source rather than a binary blob nobody can regenerate.
 *
 * The mark: a rounded square with a violet gradient, a white play triangle, and
 * a small "spark" dot at the upper right (the AI half of the metaphor).
 * Supersampled 4x for anti-aliasing.
 *
 *   node scripts/gen-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public/icons');
const SIZES = [16, 32, 48, 128];
const SUPERSAMPLE = 4;

/* ------------------------------- PNG encoder ------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

/** Encode RGBA pixel data (width * height * 4) as an 8-bit RGBA PNG. */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with a filter-type byte (0 = None).
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* --------------------------------- drawing -------------------------------- */

const ACCENT_A = [124, 92, 255]; // #7c5cff
const ACCENT_B = [176, 108, 255]; // #b06cff

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Signed-distance test for a rounded square, in normalised 0..1 space. */
function insideRoundedSquare(x, y, radius) {
  const dx = Math.max(Math.abs(x - 0.5) - (0.5 - radius), 0);
  const dy = Math.max(Math.abs(y - 0.5) - (0.5 - radius), 0);
  return Math.hypot(dx, dy) <= radius;
}

/** Play triangle pointing right, in normalised space. */
function insideTriangle(x, y) {
  const left = 0.36;
  const right = 0.68;
  const top = 0.28;
  const bottom = 0.72;
  if (x < left || x > right) return false;
  const progress = (x - left) / (right - left);
  const halfHeight = ((bottom - top) / 2) * (1 - progress);
  return Math.abs(y - 0.5) <= halfHeight;
}

/** Spark dot at the upper right. Omitted at 16px, where it reads as noise. */
function insideSpark(x, y, size) {
  if (size < 32) return false;
  return Math.hypot(x - 0.74, y - 0.29) <= 0.075;
}

function renderIcon(size) {
  const ss = size * SUPERSAMPLE;
  const accumulator = new Float32Array(size * size * 4);

  for (let sy = 0; sy < ss; sy++) {
    for (let sx = 0; sx < ss; sx++) {
      const nx = (sx + 0.5) / ss;
      const ny = (sy + 0.5) / ss;

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      if (insideRoundedSquare(nx, ny, size < 32 ? 0.16 : 0.22)) {
        // Diagonal gradient across the tile.
        const t = Math.min(Math.max((nx + ny) / 2, 0), 1);
        r = lerp(ACCENT_A[0], ACCENT_B[0], t);
        g = lerp(ACCENT_A[1], ACCENT_B[1], t);
        b = lerp(ACCENT_A[2], ACCENT_B[2], t);
        a = 255;

        if (insideTriangle(nx, ny) || insideSpark(nx, ny, size)) {
          r = 255;
          g = 255;
          b = 255;
        }
      }

      const px = Math.floor(sx / SUPERSAMPLE);
      const py = Math.floor(sy / SUPERSAMPLE);
      const index = (py * size + px) * 4;
      // Premultiply so partially covered edge pixels do not darken.
      accumulator[index] += r * (a / 255);
      accumulator[index + 1] += g * (a / 255);
      accumulator[index + 2] += b * (a / 255);
      accumulator[index + 3] += a;
    }
  }

  const samples = SUPERSAMPLE * SUPERSAMPLE;
  const rgba = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const alpha = accumulator[i * 4 + 3] / samples;
    const coverage = alpha / 255;
    // Un-premultiply for storage.
    const scale = coverage > 0 ? 1 / coverage : 0;
    rgba[i * 4] = Math.round(Math.min((accumulator[i * 4] / samples) * scale, 255));
    rgba[i * 4 + 1] = Math.round(Math.min((accumulator[i * 4 + 1] / samples) * scale, 255));
    rgba[i * 4 + 2] = Math.round(Math.min((accumulator[i * 4 + 2] / samples) * scale, 255));
    rgba[i * 4 + 3] = Math.round(alpha);
  }

  return encodePng(size, size, rgba);
}

/* ---------------------------------- main ---------------------------------- */

await fs.mkdir(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = path.join(OUT_DIR, `icon-${size}.png`);
  const png = renderIcon(size);
  await fs.writeFile(file, png);
  console.log(`  ${path.relative(ROOT, file).padEnd(28)} ${String(png.length).padStart(6)} bytes`);
}
console.log(`\n  ${SIZES.length} icons written to ${path.relative(ROOT, OUT_DIR)}\n`);
