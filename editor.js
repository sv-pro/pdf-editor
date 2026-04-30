/* =========================================================
   PDF Editor – editor.js
   Uses: PDF.js (rendering) + pdf-lib (saving)
   ========================================================= */

'use strict';

/* ─── PDFRenderer ──────────────────────────────────────────
   Wraps pdfjs-dist for loading and rendering pages.
   ─────────────────────────────────────────────────────── */
class PDFRenderer {
  constructor() {
    this.pdfDoc = null;
    this.totalPages = 0;
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'libs/pdf.worker.min.js';
  }

  async loadFile(arrayBuffer) {
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    this.pdfDoc = await loadingTask.promise;
    this.totalPages = this.pdfDoc.numPages;
    return this.totalPages;
  }

  async getPage(pageNum) {
    if (!this.pdfDoc) throw new Error('No PDF loaded');
    return this.pdfDoc.getPage(pageNum);
  }

  async renderPage(pageNum, canvas, scale) {
    const page = await this.getPage(pageNum);
    const viewport = page.getViewport({ scale });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    return { width: canvas.width, height: canvas.height };
  }

  async renderThumbnail(pageNum, canvas, maxWidth = 140) {
    const page = await this.getPage(pageNum);
    const nativeVP = page.getViewport({ scale: 1 });
    const scale = maxWidth / nativeVP.width;
    const viewport = page.getViewport({ scale });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
  }

  async getPageDimensions(pageNum, scale = 1) {
    const page = await this.getPage(pageNum);
    const viewport = page.getViewport({ scale });
    return { width: viewport.width, height: viewport.height };
  }

  getTotalPages() { return this.totalPages; }
}

/* ─── AnnotationLayer ──────────────────────────────────────
   Stores all annotations keyed by page number.
   Each annotation: { id, type, color, size, pageNum, … }
   ─────────────────────────────────────────────────────── */
class AnnotationLayer {
  constructor() {
    // Map<pageNum, Annotation[]>
    this.pageAnnotations = new Map();
    this._nextId = 1;
  }

  _newId() { return this._nextId++; }

  addAnnotation(ann) {
    ann.id = this._newId();
    const page = ann.pageNum;
    if (!this.pageAnnotations.has(page)) this.pageAnnotations.set(page, []);
    this.pageAnnotations.get(page).push(ann);
    return ann;
  }

  removeAnnotation(id) {
    for (const [page, anns] of this.pageAnnotations) {
      const idx = anns.findIndex(a => a.id === id);
      if (idx !== -1) {
        anns.splice(idx, 1);
        if (anns.length === 0) this.pageAnnotations.delete(page);
        return true;
      }
    }
    return false;
  }

  getPageAnnotations(pageNum) {
    return this.pageAnnotations.get(pageNum) || [];
  }

  // Remove all annotations within eraser radius of (x, y) on pageNum
  eraseAt(x, y, radius, pageNum) {
    const anns = this.pageAnnotations.get(pageNum);
    if (!anns) return false;
    const before = anns.length;
    // Filter out any annotation touched by the eraser
    const filtered = anns.filter(ann => !this._annotationTouches(ann, x, y, radius));
    this.pageAnnotations.set(pageNum, filtered);
    return filtered.length < before;
  }

  _annotationTouches(ann, x, y, r) {
    // Approximate hit-test dimensions for text annotations
    const TEXT_HIT_WIDTH  = 150;
    const TEXT_HIT_HEIGHT = 20;
    switch (ann.type) {
      case 'draw': return ann.points.some(p => dist(p, { x, y }) <= r);
      case 'text':  return x >= ann.x - r && x <= ann.x + TEXT_HIT_WIDTH + r && y >= ann.y - TEXT_HIT_HEIGHT - r && y <= ann.y + r;
      case 'highlight':
      case 'rect':
      case 'circle': {
        const cx = ann.x + ann.w / 2, cy = ann.y + ann.h / 2;
        return dist({ x: cx, y: cy }, { x, y }) <= Math.max(Math.abs(ann.w), Math.abs(ann.h)) / 2 + r;
      }
      case 'line':
      case 'arrow':  return pointToSegmentDist({ x, y }, ann.x1, ann.y1, ann.x2, ann.y2) <= r;
      default: return false;
    }
  }

  // Serialize/deserialize for undo-redo snapshots
  serialize() {
    const obj = {};
    for (const [page, anns] of this.pageAnnotations) {
      obj[page] = JSON.parse(JSON.stringify(anns));
    }
    return obj;
  }

  restore(snapshot) {
    this.pageAnnotations.clear();
    for (const [page, anns] of Object.entries(snapshot)) {
      this.pageAnnotations.set(Number(page), anns);
    }
  }
}

/* ─── HistoryManager ───────────────────────────────────────
   Simple undo / redo stack of serialised annotation states.
   ─────────────────────────────────────────────────────── */
class HistoryManager {
  constructor(maxLen = 50) {
    this.stack = [];
    this.cursor = -1;
    this.maxLen = maxLen;
  }

  push(snapshot) {
    // Discard any redo history
    this.stack = this.stack.slice(0, this.cursor + 1);
    this.stack.push(snapshot);
    if (this.stack.length > this.maxLen) this.stack.shift();
    this.cursor = this.stack.length - 1;
  }

  undo() {
    if (this.cursor <= 0) return null;
    this.cursor--;
    return this.stack[this.cursor];
  }

  redo() {
    if (this.cursor >= this.stack.length - 1) return null;
    this.cursor++;
    return this.stack[this.cursor];
  }

  canUndo() { return this.cursor > 0; }
  canRedo() { return this.cursor < this.stack.length - 1; }
}

/* ─── PDFSaver ─────────────────────────────────────────────
   Uses pdf-lib to embed annotations into the original PDF.
   ─────────────────────────────────────────────────────── */
class PDFSaver {
  async save(originalBytes, annotationLayer, scale) {
    const { PDFDocument, rgb, degrees } = PDFLib;
    const pdfDoc = await PDFDocument.load(originalBytes, { ignoreEncryption: true });
    const pages = pdfDoc.getPages();

    for (let i = 0; i < pages.length; i++) {
      const pageNum = i + 1;
      const anns = annotationLayer.getPageAnnotations(pageNum);
      if (!anns.length) continue;

      const page = pages[i];
      const { width: pdfW, height: pdfH } = page.getSize();

      // Transform canvas coord → pdf coord (pdf Y goes up from bottom)
      const sx = pdfW / (pdfW * scale);  // canvas width = pdfW * scale
      const sy = pdfH / (pdfH * scale);

      const toX = cx => cx * sx;
      const toY = cy => pdfH - cy * sy;
      const toDim = d => d * sx;        // use sx for dimensions (assumes uniform scale)

      for (const ann of anns) {
        const color = hexToRgb(ann.color);
        const strokeColor = rgb(color.r, color.g, color.b);
        const lw = (ann.size || 2) * sx;

        switch (ann.type) {
          case 'draw': {
            if (!ann.points || ann.points.length < 2) break;
            const pts = ann.points;
            let d = `M ${toX(pts[0].x)} ${toY(pts[0].y)}`;
            for (let j = 1; j < pts.length; j++) {
              d += ` L ${toX(pts[j].x)} ${toY(pts[j].y)}`;
            }
            page.drawSvgPath(d, {
              borderColor: strokeColor,
              borderWidth: lw,
              borderOpacity: 1,
              color: undefined,
              opacity: 0,
            });
            break;
          }
          case 'text': {
            const fontSize = Math.max(8, (ann.size || 14) * sx);
            try {
              page.drawText(ann.text || '', {
                x: toX(ann.x),
                y: toY(ann.y),
                size: fontSize,
                color: strokeColor,
              });
            } catch (_) { /* font embedding fallback – skip if unsupported */ }
            break;
          }
          case 'highlight': {
            const x = toX(ann.x);
            const y = toY(ann.y + ann.h); // bottom of rect in pdf coords
            const w = toDim(Math.abs(ann.w));
            const h = toDim(Math.abs(ann.h));
            page.drawRectangle({
              x, y,
              width: w, height: h,
              color: strokeColor,
              opacity: 0.3,
              borderWidth: 0,
            });
            break;
          }
          case 'rect': {
            const x = toX(ann.x);
            const y = toY(ann.y + ann.h);
            const w = toDim(Math.abs(ann.w));
            const h = toDim(Math.abs(ann.h));
            page.drawRectangle({
              x, y,
              width: w, height: h,
              borderColor: strokeColor,
              borderWidth: lw,
              color: undefined,
              opacity: 0,
            });
            break;
          }
          case 'circle': {
            const cx = toX(ann.x + ann.w / 2);
            const cy = toY(ann.y + ann.h / 2);
            const rx = toDim(Math.abs(ann.w) / 2);
            const ry = toDim(Math.abs(ann.h) / 2);
            // Draw as SVG ellipse path
            const ex = cx, ey = cy;
            const ellipsePath = [
              `M ${ex - rx} ${ey}`,
              `A ${rx} ${ry} 0 1 0 ${ex + rx} ${ey}`,
              `A ${rx} ${ry} 0 1 0 ${ex - rx} ${ey}`,
              'Z'
            ].join(' ');
            page.drawSvgPath(ellipsePath, {
              borderColor: strokeColor,
              borderWidth: lw,
              color: undefined,
              opacity: 0,
            });
            break;
          }
          case 'line': {
            page.drawLine({
              start: { x: toX(ann.x1), y: toY(ann.y1) },
              end:   { x: toX(ann.x2), y: toY(ann.y2) },
              color: strokeColor,
              thickness: lw,
            });
            break;
          }
          case 'arrow': {
            // Draw line
            const x1 = toX(ann.x1), y1 = toY(ann.y1);
            const x2 = toX(ann.x2), y2 = toY(ann.y2);
            page.drawLine({
              start: { x: x1, y: y1 },
              end:   { x: x2, y: y2 },
              color: strokeColor,
              thickness: lw,
            });
            // Arrowhead
            const angle = Math.atan2(y2 - y1, x2 - x1);
            const hs = lw * 5;
            const spread = Math.PI / 6;
            const ax1 = x2 - hs * Math.cos(angle - spread);
            const ay1 = y2 - hs * Math.sin(angle - spread);
            const ax2 = x2 - hs * Math.cos(angle + spread);
            const ay2 = y2 - hs * Math.sin(angle + spread);
            const headPath = `M ${x2} ${y2} L ${ax1} ${ay1} L ${ax2} ${ay2} Z`;
            page.drawSvgPath(headPath, {
              color: strokeColor,
              borderColor: strokeColor,
              borderWidth: 0,
              opacity: 1,
            });
            break;
          }
        }
      }
    }

    return pdfDoc.save();
  }
}

/* ─── Geometry helpers ─────────────────────────────────────── */
function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointToSegmentDist(pt, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return dist(pt, { x: x1, y: y1 });
  const t = Math.max(0, Math.min(1, ((pt.x - x1) * dx + (pt.y - y1) * dy) / lenSq));
  return dist(pt, { x: x1 + t * dx, y: y1 + t * dy });
}

function hexToRgb(hex) {
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  const n = parseInt(hex, 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

/* ─── EditorApp ────────────────────────────────────────────
   Wires everything together.
   ─────────────────────────────────────────────────────── */
class EditorApp {
  constructor() {
    this.renderer     = new PDFRenderer();
    this.annotations  = new AnnotationLayer();
    this.history      = new HistoryManager();
    this.saver        = new PDFSaver();

    this.currentPage  = 1;
    this.totalPages   = 0;
    this.scale        = 1.0;
    this.activeTool   = 'select';
    this.strokeColor  = '#e63946';
    this.strokeWidth  = 3;
    this.pdfBytes     = null;
    this.fileName     = 'document.pdf';

    // Drawing state
    this.isDrawing    = false;
    this.drawPoints   = [];
    this.startX = 0; this.startY = 0;
    this.previewAnn   = null;

    // Text input state
    this.pendingTextX = 0;
    this.pendingTextY = 0;

    this._bindElements();
    this._bindEvents();

    // Save initial empty history state
    this.history.push(this.annotations.serialize());
    this._updateUndoRedoButtons();
  }

  /* ── Element references ──────────────────────────────── */
  _bindElements() {
    this.pdfCanvas        = document.getElementById('pdf-canvas');
    this.annCanvas        = document.getElementById('annotation-canvas');
    this.annCtx           = this.annCanvas.getContext('2d');
    this.pageContainer    = document.getElementById('page-container');
    this.dropOverlay      = document.getElementById('drop-overlay');
    this.dropZone         = document.getElementById('drop-zone');
    this.sidebar          = document.getElementById('sidebar');
    this.thumbnailList    = document.getElementById('thumbnail-list');
    this.loadingOverlay   = document.getElementById('loading-overlay');
    this.textInputOverlay = document.getElementById('text-input-overlay');
    this.textInputField   = document.getElementById('text-input-field');
    this.canvasArea       = document.getElementById('canvas-area');

    // Status
    this.statusFile  = document.getElementById('status-file');
    this.statusPage  = document.getElementById('status-page');
    this.statusZoom  = document.getElementById('status-zoom');
    this.statusTool  = document.getElementById('status-tool');

    // Controls
    this.colorPicker  = document.getElementById('color-picker');
    this.strokeSlider = document.getElementById('stroke-width');
    this.zoomDisplay  = document.getElementById('zoom-display');
    this.pageInput    = document.getElementById('page-input');
    this.pageTotal    = document.getElementById('page-total');
    this.btnUndo      = document.getElementById('btn-undo');
    this.btnRedo      = document.getElementById('btn-redo');
    this.btnSave      = document.getElementById('btn-save');
    this.fileInput    = document.getElementById('file-input');
  }

  /* ── Event binding ───────────────────────────────────── */
  _bindEvents() {
    // File open
    document.getElementById('btn-open').addEventListener('click', () => this.fileInput.click());
    document.getElementById('btn-open-file').addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', e => {
      const file = e.target.files[0];
      if (file) this._loadFile(file);
      e.target.value = '';
    });

    // Drag-and-drop on drop zone
    this.dropZone.addEventListener('click', () => this.fileInput.click());
    this.dropZone.addEventListener('dragover', e => {
      e.preventDefault();
      this.dropZone.classList.add('drag-over');
    });
    this.dropZone.addEventListener('dragleave', () => this.dropZone.classList.remove('drag-over'));
    this.dropZone.addEventListener('drop', e => {
      e.preventDefault();
      this.dropZone.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file && file.type === 'application/pdf') this._loadFile(file);
    });

    // Drag-and-drop on entire canvas area (when PDF is loaded)
    this.canvasArea.addEventListener('dragover', e => e.preventDefault());
    this.canvasArea.addEventListener('drop', e => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file && file.type === 'application/pdf') this._loadFile(file);
    });

    // Tool selection
    document.getElementById('tool-buttons').addEventListener('click', e => {
      const btn = e.target.closest('[data-tool]');
      if (btn) this._selectTool(btn.dataset.tool);
    });

    // Style controls
    this.colorPicker.addEventListener('input', e => { this.strokeColor = e.target.value; });
    this.strokeSlider.addEventListener('input', e => { this.strokeWidth = Number(e.target.value); });

    // Zoom
    document.getElementById('btn-zoom-in').addEventListener('click', () => this._zoom(this.scale + 0.25));
    document.getElementById('btn-zoom-out').addEventListener('click', () => this._zoom(Math.max(0.25, this.scale - 0.25)));
    document.getElementById('btn-fit-page').addEventListener('click', () => this._fitPage());
    document.getElementById('btn-fit-width').addEventListener('click', () => this._fitWidth());

    // Page navigation
    document.getElementById('btn-prev-page').addEventListener('click', () => this._goToPage(this.currentPage - 1));
    document.getElementById('btn-next-page').addEventListener('click', () => this._goToPage(this.currentPage + 1));
    this.pageInput.addEventListener('change', () => this._goToPage(Number(this.pageInput.value)));

    // Undo / redo
    this.btnUndo.addEventListener('click', () => this._undo());
    this.btnRedo.addEventListener('click', () => this._redo());

    // Save
    this.btnSave.addEventListener('click', () => this._save());

    // Sidebar toggle
    document.getElementById('btn-toggle-sidebar').addEventListener('click', () => {
      this.sidebar.classList.toggle('collapsed');
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT') return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key === 'z') { e.preventDefault(); this._undo(); }
      if (ctrl && e.key === 'y') { e.preventDefault(); this._redo(); }
      if (ctrl && e.key === 's') { e.preventDefault(); this._save(); }
      if (ctrl && e.key === 'o') { e.preventDefault(); this.fileInput.click(); }
      if (e.key === 'Escape')   this._cancelTextInput();
    });

    // Annotation canvas mouse events
    this.annCanvas.addEventListener('mousedown', e => this._onMouseDown(e));
    this.annCanvas.addEventListener('mousemove', e => this._onMouseMove(e));
    this.annCanvas.addEventListener('mouseup',   e => this._onMouseUp(e));
    this.annCanvas.addEventListener('mouseleave',e => this._onMouseLeave(e));

    // Text input
    this.textInputField.addEventListener('keydown', e => {
      if (e.key === 'Enter') this._commitTextInput();
      if (e.key === 'Escape') this._cancelTextInput();
    });
    this.textInputField.addEventListener('blur', () => this._commitTextInput());
  }

  /* ── File loading ────────────────────────────────────── */
  async _loadFile(file) {
    this.fileName = file.name;
    this._showLoading(true);
    try {
      const arrayBuffer = await file.arrayBuffer();
      this.pdfBytes = new Uint8Array(arrayBuffer);
      this.totalPages = await this.renderer.loadFile(arrayBuffer);
      this.annotations = new AnnotationLayer();
      this.history = new HistoryManager();
      this.history.push(this.annotations.serialize());
      this.currentPage = 1;

      this.dropOverlay.classList.add('hidden');
      this.pageContainer.style.display = 'inline-block';
      this.btnSave.disabled = false;

      await this._renderPage(this.currentPage);
      await this._buildThumbnails();
      this._updatePageControls();
      this._updateUndoRedoButtons();
      this.statusFile.textContent = `📄 ${this.fileName}`;
    } catch (err) {
      console.error('Failed to load PDF:', err);
      alert('Failed to load PDF: ' + err.message);
    } finally {
      this._showLoading(false);
    }
  }

  /* ── Page rendering ──────────────────────────────────── */
  async _renderPage(pageNum) {
    this._showLoading(true);
    try {
      const dims = await this.renderer.renderPage(pageNum, this.pdfCanvas, this.scale);
      // Resize annotation canvas to match
      this.annCanvas.width  = dims.width;
      this.annCanvas.height = dims.height;
      this._redrawAnnotations();
      this._updatePageControls();
      this._highlightThumbnail(pageNum);
    } finally {
      this._showLoading(false);
    }
  }

  /* ── Thumbnail generation ────────────────────────────── */
  async _buildThumbnails() {
    this.thumbnailList.innerHTML = '';
    const total = this.renderer.getTotalPages();
    for (let i = 1; i <= total; i++) {
      const item = document.createElement('div');
      item.className = 'thumb-item';
      item.dataset.page = i;

      const canvas = document.createElement('canvas');
      canvas.className = 'thumb-canvas';

      const label = document.createElement('div');
      label.className = 'thumb-label';
      label.textContent = `Page ${i}`;

      item.appendChild(canvas);
      item.appendChild(label);
      this.thumbnailList.appendChild(item);

      item.addEventListener('click', () => this._goToPage(i));

      // Render thumbnail lazily
      this.renderer.renderThumbnail(i, canvas, 140).catch(() => {});
    }
  }

  _highlightThumbnail(pageNum) {
    document.querySelectorAll('.thumb-item').forEach(el => {
      el.classList.toggle('active', Number(el.dataset.page) === pageNum);
    });
    const active = document.querySelector(`.thumb-item[data-page="${pageNum}"]`);
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  /* ── Navigation ──────────────────────────────────────── */
  async _goToPage(pageNum) {
    if (!this.pdfBytes) return;
    const clamped = Math.max(1, Math.min(this.totalPages, pageNum));
    if (clamped === this.currentPage) return;
    this.currentPage = clamped;
    await this._renderPage(this.currentPage);
  }

  _updatePageControls() {
    this.pageInput.value = this.currentPage;
    this.pageInput.max   = this.totalPages;
    this.pageTotal.textContent = `/ ${this.totalPages}`;
    document.getElementById('btn-prev-page').disabled = this.currentPage <= 1;
    document.getElementById('btn-next-page').disabled = this.currentPage >= this.totalPages;
    this.statusPage.textContent = `Page ${this.currentPage} / ${this.totalPages}`;
    this.statusZoom.textContent = `${Math.round(this.scale * 100)}%`;
  }

  /* ── Zoom ────────────────────────────────────────────── */
  async _zoom(newScale) {
    this.scale = Math.max(0.25, Math.min(4.0, newScale));
    this.zoomDisplay.textContent = `${Math.round(this.scale * 100)}%`;
    if (this.pdfBytes) await this._renderPage(this.currentPage);
  }

  async _fitPage() {
    if (!this.pdfBytes) return;
    const area = this.canvasArea;
    const dims = await this.renderer.getPageDimensions(this.currentPage, 1);
    const sx = (area.clientWidth  - 48) / dims.width;
    const sy = (area.clientHeight - 48) / dims.height;
    await this._zoom(Math.min(sx, sy));
  }

  async _fitWidth() {
    if (!this.pdfBytes) return;
    const area = this.canvasArea;
    const dims = await this.renderer.getPageDimensions(this.currentPage, 1);
    await this._zoom((area.clientWidth - 48) / dims.width);
  }

  /* ── Tool selection ──────────────────────────────────── */
  _selectTool(tool) {
    this.activeTool = tool;
    document.querySelectorAll('#tool-buttons .tool-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tool === tool);
    });
    // Update cursor class on annotation canvas
    this.annCanvas.className = `tool-${tool}`;
    this.statusTool.textContent = `Tool: ${tool}`;
  }

  /* ── Canvas coordinate helper ────────────────────────── */
  _canvasPos(e) {
    const rect = this.annCanvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (this.annCanvas.width  / rect.width),
      y: (e.clientY - rect.top)  * (this.annCanvas.height / rect.height),
    };
  }

  /* ── Mouse handlers ──────────────────────────────────── */
  _onMouseDown(e) {
    if (!this.pdfBytes) return;
    const { x, y } = this._canvasPos(e);
    this.isDrawing = true;
    this.startX = x; this.startY = y;

    if (this.activeTool === 'draw') {
      this.drawPoints = [{ x, y }];
    } else if (this.activeTool === 'text') {
      this._showTextInput(x, y);
      this.isDrawing = false;
    } else if (this.activeTool === 'eraser') {
      this._eraseAt(x, y);
    }
  }

  _onMouseMove(e) {
    if (!this.isDrawing || !this.pdfBytes) return;
    const { x, y } = this._canvasPos(e);

    if (this.activeTool === 'draw') {
      this.drawPoints.push({ x, y });
      this._redrawAnnotations();
      this._drawPreviewPath(this.drawPoints);
    } else if (this.activeTool === 'eraser') {
      this._eraseAt(x, y);
    } else {
      // Shape preview
      this._redrawAnnotations();
      this._drawShapePreview(this.startX, this.startY, x, y);
    }
  }

  _onMouseUp(e) {
    if (!this.isDrawing || !this.pdfBytes) return;
    const { x, y } = this._canvasPos(e);
    this.isDrawing = false;

    if (this.activeTool === 'draw') {
      if (this.drawPoints.length > 1) {
        this._commitAnnotation({
          type: 'draw',
          points: [...this.drawPoints],
          color: this.strokeColor,
          size: this.strokeWidth,
        });
      }
      this.drawPoints = [];
    } else if (this.activeTool !== 'select' && this.activeTool !== 'eraser' && this.activeTool !== 'text') {
      this._commitShapeAnnotation(this.startX, this.startY, x, y);
    }
    this._redrawAnnotations();
  }

  _onMouseLeave(e) {
    if (this.isDrawing) this._onMouseUp(e);
  }

  /* ── Annotation creation ─────────────────────────────── */
  _commitAnnotation(annData) {
    annData.pageNum = this.currentPage;
    this.annotations.addAnnotation(annData);
    this._pushHistory();
    this._redrawAnnotations();
  }

  _commitShapeAnnotation(x1, y1, x2, y2) {
    const tool = this.activeTool;
    let ann = { color: this.strokeColor, size: this.strokeWidth };

    switch (tool) {
      case 'highlight':
        ann = { ...ann, type: 'highlight', x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
        break;
      case 'rect':
        ann = { ...ann, type: 'rect', x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
        break;
      case 'circle':
        ann = { ...ann, type: 'circle', x: Math.min(x1, x2), y: Math.min(y1, y2), w: x2 - x1, h: y2 - y1 };
        break;
      case 'line':
        ann = { ...ann, type: 'line',  x1, y1, x2, y2 };
        break;
      case 'arrow':
        ann = { ...ann, type: 'arrow', x1, y1, x2, y2 };
        break;
      default: return;
    }

    if ((ann.w !== undefined && Math.abs(ann.w) < 2 && Math.abs(ann.h) < 2)) return;
    if ((ann.x1 !== undefined) && dist({ x: x1, y: y1 }, { x: x2, y: y2 }) < 3) return;
    this._commitAnnotation(ann);
  }

  /* ── Text input ──────────────────────────────────────── */
  _showTextInput(x, y) {
    const rect = this.annCanvas.getBoundingClientRect();
    const scaleX = rect.width  / this.annCanvas.width;
    const scaleY = rect.height / this.annCanvas.height;
    this.pendingTextX = x;
    this.pendingTextY = y;

    const overlay = this.textInputOverlay;
    overlay.style.display = 'block';
    overlay.style.left = (rect.left + x * scaleX) + 'px';
    overlay.style.top  = (rect.top  + y * scaleY - 22) + 'px';
    this.textInputField.value = '';
    this.textInputField.style.fontSize = (this.strokeWidth * 4 + 8) + 'px';
    this.textInputField.style.color = this.strokeColor;
    this.textInputField.focus();
  }

  _commitTextInput() {
    const text = this.textInputField.value.trim();
    this.textInputOverlay.style.display = 'none';
    if (text && this.pdfBytes) {
      this._commitAnnotation({
        type: 'text',
        text,
        x: this.pendingTextX,
        y: this.pendingTextY,
        color: this.strokeColor,
        size: this.strokeWidth * 4 + 8,
      });
    }
  }

  _cancelTextInput() {
    this.textInputOverlay.style.display = 'none';
    this.textInputField.value = '';
  }

  /* ── Eraser ──────────────────────────────────────────── */
  _eraseAt(x, y) {
    const r = this.strokeWidth * 6;
    const changed = this.annotations.eraseAt(x, y, r, this.currentPage);
    if (changed) {
      this._pushHistory();
      this._redrawAnnotations();
    }
  }

  /* ── Redraw annotation canvas ────────────────────────── */
  _redrawAnnotations() {
    const ctx = this.annCtx;
    const w = this.annCanvas.width;
    const h = this.annCanvas.height;
    ctx.clearRect(0, 0, w, h);
    this._renderAnnotations(ctx, this.annotations.getPageAnnotations(this.currentPage));
  }

  _renderAnnotations(ctx, anns) {
    for (const ann of anns) {
      this._drawAnnotation(ctx, ann);
    }
  }

  _drawAnnotation(ctx, ann) {
    ctx.save();
    ctx.strokeStyle = ann.color;
    ctx.fillStyle   = ann.color;
    ctx.lineWidth   = ann.size || 2;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';

    switch (ann.type) {
      case 'draw': {
        if (!ann.points || ann.points.length < 2) break;
        ctx.beginPath();
        ctx.moveTo(ann.points[0].x, ann.points[0].y);
        for (let i = 1; i < ann.points.length; i++) {
          ctx.lineTo(ann.points[i].x, ann.points[i].y);
        }
        ctx.stroke();
        break;
      }
      case 'text': {
        ctx.font      = `${ann.size || 16}px system-ui, sans-serif`;
        ctx.fillStyle = ann.color;
        ctx.fillText(ann.text || '', ann.x, ann.y);
        break;
      }
      case 'highlight': {
        ctx.globalAlpha = 0.35;
        ctx.fillRect(ann.x, ann.y, ann.w, ann.h);
        ctx.globalAlpha = 1;
        break;
      }
      case 'rect': {
        ctx.strokeRect(ann.x, ann.y, ann.w, ann.h);
        break;
      }
      case 'circle': {
        ctx.beginPath();
        ctx.ellipse(
          ann.x + ann.w / 2, ann.y + ann.h / 2,
          Math.abs(ann.w / 2), Math.abs(ann.h / 2),
          0, 0, Math.PI * 2
        );
        ctx.stroke();
        break;
      }
      case 'line': {
        ctx.beginPath();
        ctx.moveTo(ann.x1, ann.y1);
        ctx.lineTo(ann.x2, ann.y2);
        ctx.stroke();
        break;
      }
      case 'arrow': {
        ctx.beginPath();
        ctx.moveTo(ann.x1, ann.y1);
        ctx.lineTo(ann.x2, ann.y2);
        ctx.stroke();
        // Arrowhead
        const angle  = Math.atan2(ann.y2 - ann.y1, ann.x2 - ann.x1);
        const hs     = Math.max(8, (ann.size || 2) * 5);
        const spread = Math.PI / 6;
        ctx.beginPath();
        ctx.moveTo(ann.x2, ann.y2);
        ctx.lineTo(ann.x2 - hs * Math.cos(angle - spread), ann.y2 - hs * Math.sin(angle - spread));
        ctx.lineTo(ann.x2 - hs * Math.cos(angle + spread), ann.y2 - hs * Math.sin(angle + spread));
        ctx.closePath();
        ctx.fill();
        break;
      }
    }
    ctx.restore();
  }

  /* ── Shape preview (while dragging) ─────────────────── */
  _drawShapePreview(x1, y1, x2, y2) {
    const ctx = this.annCtx;
    ctx.save();
    ctx.strokeStyle = this.strokeColor;
    ctx.fillStyle   = this.strokeColor;
    ctx.lineWidth   = this.strokeWidth;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.setLineDash([4, 3]);

    switch (this.activeTool) {
      case 'highlight': {
        ctx.globalAlpha = 0.3;
        ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
        ctx.globalAlpha = 1;
        break;
      }
      case 'rect':
        ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
        break;
      case 'circle': {
        const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
        ctx.beginPath();
        ctx.ellipse(cx, cy, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case 'line':
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        break;
      case 'arrow': {
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        const angle  = Math.atan2(y2 - y1, x2 - x1);
        const hs     = Math.max(8, this.strokeWidth * 5);
        const spread = Math.PI / 6;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - hs * Math.cos(angle - spread), y2 - hs * Math.sin(angle - spread));
        ctx.lineTo(x2 - hs * Math.cos(angle + spread), y2 - hs * Math.sin(angle + spread));
        ctx.closePath();
        ctx.fill();
        break;
      }
    }
    ctx.restore();
  }

  _drawPreviewPath(points) {
    const ctx = this.annCtx;
    ctx.save();
    ctx.strokeStyle = this.strokeColor;
    ctx.lineWidth   = this.strokeWidth;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke();
    ctx.restore();
  }

  /* ── Undo / Redo ─────────────────────────────────────── */
  _pushHistory() {
    this.history.push(this.annotations.serialize());
    this._updateUndoRedoButtons();
  }

  _undo() {
    const snapshot = this.history.undo();
    if (snapshot !== null) {
      this.annotations.restore(snapshot);
      this._redrawAnnotations();
      this._updateUndoRedoButtons();
    }
  }

  _redo() {
    const snapshot = this.history.redo();
    if (snapshot !== null) {
      this.annotations.restore(snapshot);
      this._redrawAnnotations();
      this._updateUndoRedoButtons();
    }
  }

  _updateUndoRedoButtons() {
    this.btnUndo.disabled = !this.history.canUndo();
    this.btnRedo.disabled = !this.history.canRedo();
  }

  /* ── Save / Download ─────────────────────────────────── */
  async _save() {
    if (!this.pdfBytes) return;
    this._showLoading(true);
    try {
      const savedBytes = await this.saver.save(this.pdfBytes, this.annotations, this.scale);
      const blob = new Blob([savedBytes], { type: 'application/pdf' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = this.fileName.replace(/\.pdf$/i, '') + '_annotated.pdf';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to save PDF:', err);
      alert('Failed to save PDF: ' + err.message);
    } finally {
      this._showLoading(false);
    }
  }

  /* ── UI helpers ──────────────────────────────────────── */
  _showLoading(visible) {
    this.loadingOverlay.classList.toggle('visible', visible);
  }
}

/* ─── Bootstrap ────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  window.app = new EditorApp();
});
