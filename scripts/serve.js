#!/usr/bin/env node
/**
 * scripts/serve.js
 *
 * Starts a local HTTP server for the website at dist/website/.
 * Usage:  node scripts/serve.js [port]   (default port: 3000)
 */

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT    = parseInt(process.argv[2], 10) || 3000;
const ROOT    = path.resolve(__dirname, '..');
const SITE    = path.join(ROOT, 'dist', 'website');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.zip':  'application/zip',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

if (!fs.existsSync(SITE)) {
  console.error(`Website not built. Run "npm run build" first.\n  (expected: ${SITE})`);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  const filePath = path.join(SITE, urlPath);

  // Prevent path traversal
  if (!filePath.startsWith(SITE)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }

  const ext  = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  console.log(`PDF Editor website running at http://localhost:${PORT}`);
  console.log('Press Ctrl+C to stop.');
});
