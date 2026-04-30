'use strict';

import * as pdfjsLib from '../lib/pdf.min.mjs';
import { PDFDocument } from '../lib/pdf-lib.esm.min.js';

// ── Globals ───────────────────────────────────────────────────────────────────

/** @type {import('pdfjs-dist').PDFDocumentProxy|null} */
let pdfDoc = null;
let currentPage = 1;
let totalPages = 0;
let scale = 1.5;

// Tool state
let currentTool = 'pen';
let penColor = '#e53e3e';
let penSize = 3;
let isDrawing = false;
let lastPoint = null;

// Per-page annotation storage: pageNum → ImageData (nullable)
const annotationCache = {};
// Per-page undo stack: pageNum → ImageData[]
const undoStack = {};

let pdfCanvas, pdfCtx, annotCanvas, annotCtx;
let textInput, dropZone, canvasWrapper;
let originalFileName = 'document';

// ── Bootstrap ─────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  pdfCanvas      = document.getElementById('pdf-canvas');
  annotCanvas    = document.getElementById('annotation-canvas');
  pdfCtx         = pdfCanvas.getContext('2d');
  annotCtx       = annotCanvas.getContext('2d');
  textInput      = document.getElementById('text-input');
  dropZone       = document.getElementById('drop-zone');
  canvasWrapper  = document.getElementById('canvas-wrapper');

  // Set the PDF.js worker (copied to lib/ by the build script)
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    '../lib/pdf.worker.min.mjs',
    import.meta.url
  ).href;

  setupToolbar();
  setupCanvasEvents();
  setupDragDrop();

  const params = new URLSearchParams(window.location.search);
  const pdfUrl  = params.get('url');
  if (pdfUrl) {
    openUrl(pdfUrl);
    const parts = pdfUrl.split('/');
    originalFileName = parts[parts.length - 1].replace(/\.pdf$/i, '') || 'document';
  }
});

// ── Toolbar wiring ─────────────────────────────────────────────────────────────

function setupToolbar() {
  // Open file
  const fileInput = document.getElementById('file-input');
  document.getElementById('btn-open').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      originalFileName = file.name.replace(/\.pdf$/i, '');
      openBlob(file);
    }
    fileInput.value = '';
  });

  // Tool buttons
  document.querySelectorAll('.tool-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tool-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentTool = btn.dataset.tool;
      annotCanvas.classList.toggle('text-cursor', currentTool === 'text');
      hideTextInput();
    });
  });

  // Color / size
  document.getElementById('color-picker').addEventListener('input', (e) => {
    penColor = e.target.value;
  });
  document.getElementById('size-picker').addEventListener('input', (e) => {
    penSize = Number(e.target.value);
  });

  // Page navigation
  document.getElementById('btn-prev').addEventListener('click', () => goToPage(currentPage - 1));
  document.getElementById('btn-next').addEventListener('click', () => goToPage(currentPage + 1));

  // Zoom
  document.getElementById('zoom-select').addEventListener('change', (e) => {
    scale = parseFloat(e.target.value);
    if (pdfDoc) renderPage(currentPage);
  });

  // Undo / clear / download
  document.getElementById('btn-undo').addEventListener('click', undo);
  document.getElementById('btn-clear').addEventListener('click', clearPage);
  document.getElementById('btn-download').addEventListener('click', downloadPDF);
}

// ── Canvas events ─────────────────────────────────────────────────────────────

function setupCanvasEvents() {
  annotCanvas.addEventListener('mousedown', onMouseDown);
  annotCanvas.addEventListener('mousemove', onMouseMove);
  annotCanvas.addEventListener('mouseup',   onMouseUp);
  annotCanvas.addEventListener('mouseleave', onMouseUp);

  // Touch support
  annotCanvas.addEventListener('touchstart', (e) => { e.preventDefault(); onMouseDown(touchToMouse(e)); }, { passive: false });
  annotCanvas.addEventListener('touchmove',  (e) => { e.preventDefault(); onMouseMove(touchToMouse(e)); }, { passive: false });
  annotCanvas.addEventListener('touchend',   (e) => { e.preventDefault(); onMouseUp();                 }, { passive: false });
}

function touchToMouse(e) {
  const t = e.touches[0];
  return { clientX: t.clientX, clientY: t.clientY };
}

function canvasPoint(e) {
  const rect = annotCanvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (annotCanvas.width  / rect.width),
    y: (e.clientY - rect.top)  * (annotCanvas.height / rect.height),
  };
}

function onMouseDown(e) {
  if (!pdfDoc) return;

  if (currentTool === 'text') {
    placeTextInput(e);
    return;
  }

  pushUndo();
  isDrawing = true;
  lastPoint = canvasPoint(e);

  if (currentTool === 'pen' || currentTool === 'eraser') {
    annotCtx.beginPath();
    annotCtx.moveTo(lastPoint.x, lastPoint.y);
  }
}

function onMouseMove(e) {
  if (!isDrawing) return;
  const pt = canvasPoint(e);

  if (currentTool === 'pen') {
    annotCtx.lineTo(pt.x, pt.y);
    annotCtx.strokeStyle = penColor;
    annotCtx.lineWidth   = penSize;
    annotCtx.lineCap     = 'round';
    annotCtx.lineJoin    = 'round';
    annotCtx.globalCompositeOperation = 'source-over';
    annotCtx.stroke();
  } else if (currentTool === 'eraser') {
    annotCtx.lineTo(pt.x, pt.y);
    annotCtx.strokeStyle = 'rgba(0,0,0,1)';
    annotCtx.lineWidth   = penSize * 4;
    annotCtx.lineCap     = 'round';
    annotCtx.lineJoin    = 'round';
    annotCtx.globalCompositeOperation = 'destination-out';
    annotCtx.stroke();
  } else if (currentTool === 'highlight') {
    // Re-draw from saved state so the highlight rect doesn't compound
    restoreAnnotation(currentPage);
    const start = lastPoint;
    annotCtx.fillStyle = hexToRgba(penColor, 0.35);
    annotCtx.globalCompositeOperation = 'source-over';
    annotCtx.fillRect(start.x, start.y, pt.x - start.x, pt.y - start.y);
  }

  lastPoint = pt;
}

function onMouseUp() {
  if (!isDrawing) return;
  isDrawing = false;
  annotCtx.globalCompositeOperation = 'source-over';
  saveAnnotation(currentPage);
}

// ── Text tool ─────────────────────────────────────────────────────────────────

function placeTextInput(e) {
  hideTextInput();
  const rect  = annotCanvas.getBoundingClientRect();
  textInput.style.left   = (e.clientX - rect.left + canvasWrapper.offsetLeft) + 'px';
  textInput.style.top    = (e.clientY - rect.top  + canvasWrapper.offsetTop)  + 'px';
  textInput.style.display = 'block';
  textInput.style.fontSize = `${Math.max(12, penSize * 4)}px`;
  textInput.style.color = penColor;
  textInput.value = '';
  textInput.focus();

  textInput.onkeydown = (ev) => {
    if (ev.key === 'Escape') hideTextInput();
    if (ev.key === 'Enter' && !ev.shiftKey) {
      commitTextInput();
      ev.preventDefault();
    }
  };
}

function hideTextInput() {
  textInput.style.display = 'none';
}

function commitTextInput() {
  const text = textInput.value.trim();
  if (!text) { hideTextInput(); return; }

  const rect    = annotCanvas.getBoundingClientRect();
  const wrapRect = canvasWrapper.getBoundingClientRect();
  const left     = parseFloat(textInput.style.left) - (wrapRect.left - rect.left);
  const top      = parseFloat(textInput.style.top)  - (wrapRect.top  - rect.top);
  const x = left  * (annotCanvas.width  / rect.width);
  const y = top   * (annotCanvas.height / rect.height);

  pushUndo();
  annotCtx.font         = `${Math.max(12, penSize * 4)}px sans-serif`;
  annotCtx.fillStyle    = penColor;
  annotCtx.globalCompositeOperation = 'source-over';

  text.split('\n').forEach((line, i) => {
    annotCtx.fillText(line, x, y + i * Math.max(14, penSize * 5));
  });

  saveAnnotation(currentPage);
  hideTextInput();
}

// ── Annotation persistence ─────────────────────────────────────────────────────

function saveAnnotation(page) {
  annotationCache[page] = annotCtx.getImageData(0, 0, annotCanvas.width, annotCanvas.height);
}

function restoreAnnotation(page) {
  annotCtx.clearRect(0, 0, annotCanvas.width, annotCanvas.height);
  if (annotationCache[page]) {
    annotCtx.putImageData(annotationCache[page], 0, 0);
  }
}

function pushUndo() {
  if (!undoStack[currentPage]) undoStack[currentPage] = [];
  undoStack[currentPage].push(
    annotCtx.getImageData(0, 0, annotCanvas.width, annotCanvas.height)
  );
  if (undoStack[currentPage].length > 30) undoStack[currentPage].shift();
}

function undo() {
  if (!undoStack[currentPage] || undoStack[currentPage].length === 0) return;
  const prev = undoStack[currentPage].pop();
  annotCtx.putImageData(prev, 0, 0);
  saveAnnotation(currentPage);
}

function clearPage() {
  pushUndo();
  annotCtx.clearRect(0, 0, annotCanvas.width, annotCanvas.height);
  saveAnnotation(currentPage);
}

// ── PDF loading ───────────────────────────────────────────────────────────────

async function openUrl(url) {
  showLoading(true);
  try {
    const loadingTask = pdfjsLib.getDocument({ url });
    pdfDoc = await loadingTask.promise;
    totalPages = pdfDoc.numPages;
    currentPage = 1;
    dropZone.classList.add('hidden');
    await renderPage(currentPage);
    updatePageInfo();
  } catch (err) {
    alert(`Failed to load PDF: ${err.message}`);
  } finally {
    showLoading(false);
  }
}

async function openBlob(file) {
  const arrayBuffer = await file.arrayBuffer();
  showLoading(true);
  try {
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    pdfDoc = await loadingTask.promise;
    totalPages = pdfDoc.numPages;
    currentPage = 1;
    dropZone.classList.add('hidden');
    await renderPage(currentPage);
    updatePageInfo();
  } catch (err) {
    alert(`Failed to load PDF: ${err.message}`);
  } finally {
    showLoading(false);
  }
}

async function renderPage(pageNum) {
  const page     = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale });

  pdfCanvas.width  = viewport.width;
  pdfCanvas.height = viewport.height;
  annotCanvas.width  = viewport.width;
  annotCanvas.height = viewport.height;

  await page.render({ canvasContext: pdfCtx, viewport }).promise;
  restoreAnnotation(pageNum);
  updatePageInfo();
}

async function goToPage(pageNum) {
  if (!pdfDoc) return;
  if (pageNum < 1 || pageNum > totalPages) return;
  currentPage = pageNum;
  await renderPage(currentPage);
}

function updatePageInfo() {
  document.getElementById('page-info').textContent =
    pdfDoc ? `${currentPage} / ${totalPages}` : '– / –';
  document.getElementById('btn-prev').disabled = currentPage <= 1;
  document.getElementById('btn-next').disabled = currentPage >= totalPages;
}

// ── Drag & drop ───────────────────────────────────────────────────────────────

function setupDragDrop() {
  const container = document.getElementById('canvas-container');

  container.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('active'); });
  container.addEventListener('dragleave', () => dropZone.classList.remove('active'));
  container.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('active');
    const file = e.dataTransfer.files[0];
    if (file && file.type === 'application/pdf') {
      originalFileName = file.name.replace(/\.pdf$/i, '');
      openBlob(file);
    }
  });
}

// ── Download (annotated PDF) ───────────────────────────────────────────────────

async function downloadPDF() {
  if (!pdfDoc) { alert('No PDF open.'); return; }

  showLoading(true);
  try {
    // Save current page annotation before downloading
    saveAnnotation(currentPage);

    const srcBytes = await pdfDoc.getData();
    const doc      = await PDFDocument.load(srcBytes);
    const pages    = doc.getPages();

    for (let i = 1; i <= totalPages; i++) {
      const imageData = annotationCache[i];
      if (!imageData) continue;

      // Check if the annotation layer has any non-transparent pixels
      const hasContent = imageData.data.some((v, idx) => idx % 4 === 3 && v > 0);
      if (!hasContent) continue;

      // Render annotation to a temporary canvas and export as PNG
      const tmpCanvas = document.createElement('canvas');
      tmpCanvas.width  = imageData.width;
      tmpCanvas.height = imageData.height;
      tmpCanvas.getContext('2d').putImageData(imageData, 0, 0);

      const pngDataUrl = tmpCanvas.toDataURL('image/png');
      const pngBytes   = base64ToUint8Array(pngDataUrl.split(',')[1]);
      const pngImage   = await doc.embedPng(pngBytes);

      const pdfPage = pages[i - 1];
      const { width, height } = pdfPage.getSize();

      pdfPage.drawImage(pngImage, {
        x: 0, y: 0,
        width, height,
        opacity: 1,
      });
    }

    const pdfBytes = await doc.save();
    triggerDownload(pdfBytes, `${originalFileName}-annotated.pdf`, 'application/pdf');
  } catch (err) {
    alert(`Save failed: ${err.message}`);
  } finally {
    showLoading(false);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function showLoading(visible) {
  let el = document.getElementById('loading');
  if (!el) {
    el = document.createElement('div');
    el.id = 'loading';
    el.textContent = 'Loading…';
    document.body.appendChild(el);
  }
  el.className = visible ? '' : 'hidden';
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function triggerDownload(bytes, filename, mimeType) {
  const blob = new Blob([bytes], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
