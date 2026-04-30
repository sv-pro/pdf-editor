const fs   = require('fs');
const path = require('path');

// Step 1: Generate icons
console.log('Generating icons...');
require('./generate-icons');

// Step 2: Copy library files from node_modules into libs/
console.log('\nCopying library files...');

const libsDir = path.join(__dirname, '..', 'libs');
if (!fs.existsSync(libsDir)) fs.mkdirSync(libsDir, { recursive: true });

const root = path.join(__dirname, '..');

const copies = [
  ['pdfjs-dist/build/pdf.min.js',        'libs/pdf.min.js'],
  ['pdfjs-dist/build/pdf.worker.min.js', 'libs/pdf.worker.min.js'],
  ['pdf-lib/dist/pdf-lib.min.js',        'libs/pdf-lib.min.js'],
];

copies.forEach(([src, dest]) => {
  const srcPath  = path.join(root, 'node_modules', src);
  const destPath = path.join(root, dest);
  if (!fs.existsSync(srcPath)) {
    console.error(`  ERROR: Source not found: ${srcPath}`);
    process.exit(1);
  }
  fs.copyFileSync(srcPath, destPath);
  const sizeKB = Math.round(fs.statSync(destPath).size / 1024);
  console.log(`  Copied ${src} → ${dest} (${sizeKB} KB)`);
});

console.log('\nBuild complete ✓');
