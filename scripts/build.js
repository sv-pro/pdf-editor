#!/usr/bin/env node
/**
 * scripts/build.js
 *
 * Builds the extension and website into dist/:
 *
 *   dist/extension/   – ready-to-load Chrome extension
 *   dist/website/     – static website with download link
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT  = path.resolve(__dirname, '..');
const DIST  = path.join(ROOT, 'dist');
const EXT   = path.join(DIST, 'extension');
const SITE  = path.join(DIST, 'website');

// ── Utility helpers ──────────────────────────────────────────────────────────

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(src, dest) {
  mkdirp(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest) {
  mkdirp(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath  = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      copyFile(srcPath, destPath);
    }
  }
}

function resolvePackage(name) {
  // Walk up from the package's package.json to find node_modules
  return path.dirname(require.resolve(`${name}/package.json`));
}

// ── PNG icon generator (pure Node.js, no external deps) ─────────────────────

function makeCRC32Table() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }
  return table;
}

const CRC32_TABLE = makeCRC32Table();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const len       = Buffer.allocUnsafe(4);
  len.writeUInt32BE(data.length);
  const crcInput = Buffer.concat([typeBytes, data]);
  const crcBuf   = Buffer.allocUnsafe(4);
  crcBuf.writeUInt32BE(crc32(crcInput));
  return Buffer.concat([len, typeBytes, data, crcBuf]);
}

/**
 * Generate a solid-colour PNG image.
 * @param {number} size   Width and height in pixels
 * @param {number} r      Red   0-255
 * @param {number} g      Green 0-255
 * @param {number} b      Blue  0-255
 * @returns {Buffer}
 */
function createSolidPNG(size, r, g, b) {
  // PNG signature
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR
  const ihdrData = Buffer.allocUnsafe(13);
  ihdrData.writeUInt32BE(size, 0);
  ihdrData.writeUInt32BE(size, 4);
  ihdrData[8]  = 8;  // bit depth
  ihdrData[9]  = 2;  // colour type: RGB
  ihdrData[10] = 0;  // compression
  ihdrData[11] = 0;  // filter
  ihdrData[12] = 0;  // interlace
  const ihdr = pngChunk('IHDR', ihdrData);

  // Raw image data: one filter byte (0 = None) + RGB pixels per scanline
  const scanline = Buffer.allocUnsafe(1 + size * 3);
  scanline[0] = 0; // filter = None
  for (let x = 0; x < size; x++) {
    scanline[1 + x * 3]     = r;
    scanline[1 + x * 3 + 1] = g;
    scanline[1 + x * 3 + 2] = b;
  }
  const raw = Buffer.concat(Array.from({ length: size }, () => scanline));
  const compressed = zlib.deflateSync(raw);
  const idat = pngChunk('IDAT', compressed);

  // IEND
  const iend = pngChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdr, idat, iend]);
}

// ── Main build ───────────────────────────────────────────────────────────────

function buildExtension() {
  console.log('Building extension…');

  // 1. Clean and copy source
  if (fs.existsSync(EXT)) fs.rmSync(EXT, { recursive: true });
  copyDir(path.join(ROOT, 'src', 'extension'), EXT);

  // 2. Copy pdfjs-dist UMD builds → dist/extension/lib/
  const lib = path.join(EXT, 'lib');
  mkdirp(lib);

  const pdfjsDir = resolvePackage('pdfjs-dist');
  copyFile(path.join(pdfjsDir, 'build', 'pdf.min.mjs'),        path.join(lib, 'pdf.min.mjs'));
  copyFile(path.join(pdfjsDir, 'build', 'pdf.worker.min.mjs'), path.join(lib, 'pdf.worker.min.mjs'));

  // 3. Copy pdf-lib ESM build → dist/extension/lib/
  const pdfLibDir = resolvePackage('pdf-lib');
  const pdfLibEsm = path.join(pdfLibDir, 'dist', 'pdf-lib.esm.min.js');
  if (fs.existsSync(pdfLibEsm)) {
    copyFile(pdfLibEsm, path.join(lib, 'pdf-lib.esm.min.js'));
  } else {
    // Fallback: use the UMD build and rename to match import path
    const pdfLibPkg  = JSON.parse(fs.readFileSync(path.join(pdfLibDir, 'package.json'), 'utf8'));
    const pdfLibMain = path.join(pdfLibDir, pdfLibPkg.browser || pdfLibPkg.main);
    copyFile(pdfLibMain, path.join(lib, 'pdf-lib.esm.min.js'));
  }

  // 4. Generate icons
  const iconsDir = path.join(EXT, 'icons');
  mkdirp(iconsDir);
  // Brand colour: PDF-editor blue #3182ce → rgb(49,130,206)
  for (const size of [16, 32, 48, 128]) {
    const png = createSolidPNG(size, 49, 130, 206);
    fs.writeFileSync(path.join(iconsDir, `icon${size}.png`), png);
  }

  console.log('  ✓ Extension → dist/extension/');
}

function buildWebsite() {
  console.log('Building website…');

  if (fs.existsSync(SITE)) fs.rmSync(SITE, { recursive: true });
  copyDir(path.join(ROOT, 'src', 'website'), SITE);

  // Create placeholder download directory (populated by pack.js)
  mkdirp(path.join(SITE, 'download'));

  console.log('  ✓ Website → dist/website/');
}

// ── Run ──────────────────────────────────────────────────────────────────────

buildExtension();
buildWebsite();
console.log('\nBuild complete. Run `npm run pack` to create the downloadable zip.');
