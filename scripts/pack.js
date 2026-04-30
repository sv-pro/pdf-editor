#!/usr/bin/env node
/**
 * scripts/pack.js
 *
 * 1. Runs the build (if dist/extension/ is missing or --rebuild flag given).
 * 2. Zips dist/extension/ → dist/pdf-editor.zip
 * 3. Copies the zip into dist/website/download/ so the website can link to it.
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const archiver = require('archiver');

const ROOT     = path.resolve(__dirname, '..');
const DIST     = path.join(ROOT, 'dist');
const EXT_DIR  = path.join(DIST, 'extension');
const ZIP_OUT  = path.join(DIST, 'pdf-editor.zip');
const SITE_DL  = path.join(DIST, 'website', 'download');

async function main() {
  // Ensure the extension is built
  if (!fs.existsSync(EXT_DIR) || process.argv.includes('--rebuild')) {
    console.log('Extension not built yet – running build first…\n');
    require('./build');
    console.log('');
  }

  console.log('Packing extension…');

  // Remove old zip if present
  if (fs.existsSync(ZIP_OUT)) fs.unlinkSync(ZIP_OUT);

  await zipDirectory(EXT_DIR, ZIP_OUT);

  // Copy zip into the website download folder
  fs.mkdirSync(SITE_DL, { recursive: true });
  fs.copyFileSync(ZIP_OUT, path.join(SITE_DL, 'pdf-editor.zip'));

  const sizeKB = Math.round(fs.statSync(ZIP_OUT).size / 1024);
  console.log(`  ✓ dist/pdf-editor.zip (${sizeKB} KB)`);
  console.log('  ✓ dist/website/download/pdf-editor.zip');
  console.log('\nPacking complete. The website in dist/website/ now has a download link.');
}

/**
 * Zip the contents of a directory into a zip file.
 * @param {string} sourceDir
 * @param {string} outPath
 */
function zipDirectory(sourceDir, outPath) {
  return new Promise((resolve, reject) => {
    const output  = fs.createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);

    // Add all files from the directory with the directory name as the root
    archive.directory(sourceDir, 'pdf-editor');
    archive.finalize();
  });
}

main().catch((err) => { console.error(err); process.exit(1); });
