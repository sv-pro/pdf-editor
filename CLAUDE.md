# CLAUDE.md

## Project Overview

Chrome Manifest V3 extension that lets users open, annotate, and export PDFs locally in the browser. No backend — entirely client-side.

**Stack:** React 18.3 · Vite 5.4 · JavaScript (JSX, no TypeScript) · pdf-lib 1.17.1 · pdfjs-dist 4.10.38

**Node requirement:** 18+

---

## Development Commands

```bash
npm install          # install all dependencies
npm run dev          # Vite dev server (HMR) — for iterating on the React UI
npm run build        # generate icons + Vite bundle → dist/
```

`npm run build` runs two steps in sequence:
1. `node scripts/generate-icons.js` — creates `icons/icon{16,32,48,128}.png` via node-canvas
2. `vite build` — bundles `editor.html` + `src/` into `dist/`, then the `copyExtensionFiles` Vite plugin copies `manifest.json`, `popup.html/js/css`, `background.js`, and the icons into `dist/`

To load the extension locally: open `chrome://extensions`, enable Developer mode, click "Load unpacked", select `dist/`.

---

## Repository Structure

```
pdf-editor/
├── src/
│   ├── main.jsx          # React entry — mounts <PDFEditor />
│   └── PDFEditor.jsx     # Entire editor UI (~644 lines, monolithic by design)
├── editor.html           # Vite HTML entry point
├── popup.html/js/css     # Extension toolbar popup (opens editor tab)
├── background.js         # Service worker — opens editor.html on icon click
├── manifest.json         # Chrome Manifest V3
├── vite.config.mjs       # Vite config + copyExtensionFiles plugin
├── scripts/
│   └── generate-icons.js # Generates PNG icons via canvas API
└── .github/workflows/
    └── release.yml       # CI/CD: build + GitHub Release
```

Generated (not committed): `dist/`, `icons/*.png`

---

## Architecture

### Extension anatomy

| File | Role |
|------|------|
| `background.js` | Service worker — listens for extension icon click, opens a new tab pointing at `editor.html` |
| `popup.html/js/css` | Minimal toolbar popup with a single "Open PDF Editor" button |
| `editor.html` + `src/` | Full-screen React app — the actual editor |
| `manifest.json` | Declares permissions (`storage`, `downloads`), icons, service worker, popup |

### Source layout

`src/PDFEditor.jsx` is intentionally monolithic — do not break it into sub-files without strong reason. It contains:

- `invertMatrix` / `applyMatrix` — 2D matrix helpers for screen↔PDF coordinate conversion
- `Thumb` — mini component for sidebar page thumbnails
- `Btn` / `Divider` — small UI primitives used throughout
- `PDFEditor` — the main exported component with all state, event handlers, and render logic

`src/main.jsx` does nothing except create the React root and render `<PDFEditor />`.

---

## PDF Workflow

```
Load (PDF.js)  →  Edit (React state)  →  Export (pdf-lib)
```

1. **Load:** `pdfjsLib.getDocument(bytes)` parses the file; original bytes stored in `origBytes` state
2. **Render:** `doc.getPage(n)` → `page.getViewport({ scale, rotation })` → `page.render({ canvasContext, viewport })` onto a `<canvas>` element
3. **Annotations:** stored as objects in `annots` state; displayed as HTML `<div>`s overlaid on the canvas during editing
4. **Export:** `PDFDocument.create()` via pdf-lib, pages copied in current `pageOrder`, rotations applied via `page.setRotation()`, text annotations written via `page.drawText()`, result downloaded as a blob

PDF.js worker is bundled locally (no CDN): `import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url"` — do not change this to a CDN URL.

---

## Key State & Data Shapes

### Annotation object
```js
{
  id: number,          // Date.now() timestamp
  orderIdx: number,    // 0-based index into pageOrder
  x: number,           // canvas pixel x where user clicked
  y: number,           // canvas pixel y where user clicked
  transform: number[], // 6-element viewport matrix from PDF.js at time of click
  text: string,
  fontSize: number,
  color: string,       // hex "#rrggbb"
  bold: boolean,
}
```

### Page state
- `pageOrder: number[]` — array of original 1-based page numbers in display order; reorder/delete manipulate this array
- `rotations: { [origPageNum]: degrees }` — extra rotation per original page (0/90/180/270)
- `cur: number` — 0-based index into `pageOrder` for the currently visible page
- `zoom: number` — scale factor (0.3–3.0)

### Key refs
- `canvasRef` — the main render canvas
- `renderRef` — current PDF.js render task (cancelled on page change)
- `fileInputRef` — hidden `<input type="file">` for the file picker
- `textInputRef` — focused `<input>` for in-canvas text entry

---

## Conventions

### Styling
- All styles are **inline CSS objects** — no external CSS files (except `popup.css` for the popup), no Tailwind, no CSS-in-JS library
- Dark theme palette: background `#0a0a0c`, surface `#16161a`, accent/active `#00e5ff` (cyan), danger `#ff4444`, muted text `#999`
- Use the existing `Btn` component for toolbar buttons; pass `accent`, `active`, or `danger` props as appropriate

### Language
- JavaScript (JSX) only — do not introduce TypeScript or add `tsconfig.json`
- Destructured React hook imports: `import { useState, useEffect, ... } from "react"`
- PDF.js imported as namespace: `import * as pdfjsLib from "pdfjs-dist"`

### Page numbering
- **1-based** in the UI and in PDF.js API (`doc.getPage(1)` = first page)
- **0-based** internally for `pageOrder` array indexing (`cur` state, `orderIdx` on annotations)

### Section comments
Major logical sections in `PDFEditor.jsx` are separated with: `/* ─── Section name ─── */`

---

## CI/CD & Releases

**Workflow:** `.github/workflows/release.yml`

| Trigger | Result |
|---------|--------|
| Push a tag matching `v*` (e.g. `v1.2.0`) | Full GitHub Release created with `pdf-editor-extension.zip` attached |
| Manual `workflow_dispatch` | Build runs, zip uploaded as 30-day artifact — no release created |

**Release process:**
1. Bump `version` in `manifest.json` and `package.json`
2. Commit and push
3. Tag: `git tag v1.x.x && git push origin v1.x.x`

The workflow uses Node 20, runs `npm ci` + `npm run build`, then zips `dist/`.

---

## What Does Not Exist

- **No tests** — no test framework, no test files; do not assume a test command works
- **No linting or formatting** — no ESLint, Prettier, or pre-commit hooks
- **No environment variables** — no `.env` files, no `process.env` / `import.meta.env` usage
- **No backend or API calls** — all operations are local; no `fetch`/`axios` to any server
- **No TypeScript** — the codebase is plain JSX
- **No routing** — single-page app, no React Router or similar
- **No external state management** — only React's built-in `useState`/`useRef`/`useEffect`
