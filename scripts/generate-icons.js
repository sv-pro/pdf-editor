const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

function generateIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Blue rounded background
  ctx.fillStyle = '#1a73e8';
  ctx.beginPath();
  const r = size * 0.15;
  ctx.roundRect(0, 0, size, size, r);
  ctx.fill();

  // Document shape
  const margin   = size * 0.15;
  const docW     = size - margin * 2;
  const docH     = docW * 1.3;
  const docX     = margin;
  const docY     = (size - docH) / 2;
  const foldSize = docW * 0.25;

  ctx.fillStyle = 'white';
  ctx.beginPath();
  ctx.moveTo(docX, docY);
  ctx.lineTo(docX + docW - foldSize, docY);
  ctx.lineTo(docX + docW, docY + foldSize);
  ctx.lineTo(docX + docW, docY + docH);
  ctx.lineTo(docX, docY + docH);
  ctx.closePath();
  ctx.fill();

  // Fold triangle
  ctx.fillStyle = '#c5d9f7';
  ctx.beginPath();
  ctx.moveTo(docX + docW - foldSize, docY);
  ctx.lineTo(docX + docW, docY + foldSize);
  ctx.lineTo(docX + docW - foldSize, docY + foldSize);
  ctx.closePath();
  ctx.fill();

  // "PDF" text (only for larger icons)
  if (size >= 32) {
    ctx.fillStyle = '#1a73e8';
    ctx.font = `bold ${Math.floor(size * 0.2)}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('PDF', size / 2, docY + docH * 0.68);
  }

  return canvas.toBuffer('image/png');
}

const iconsDir = path.join(__dirname, '..', 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });

[16, 32, 48, 128].forEach(size => {
  const buf = generateIcon(size);
  fs.writeFileSync(path.join(iconsDir, `icon${size}.png`), buf);
  console.log(`Generated icon${size}.png`);
});
