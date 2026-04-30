# PDF Editor — Chrome Extension

A single-page, dark-themed PDF editor packaged as a Chrome (Manifest V3) extension.
Built with React, Vite, [PDF.js](https://mozilla.github.io/pdf.js/) and [pdf-lib](https://pdf-lib.js.org/).

## Features

- **Open** a PDF via drag-and-drop or the file picker
- **Text annotations** — click anywhere on the page to place styled text
  - Configurable font size, colour and bold
- **Page management**
  - Rotate left / right (90°)
  - Reorder pages (move up / down in the sidebar)
  - **Delete a page** (toolbar "✕ Del Page" button; disabled when only one page remains)
- **Export** — downloads the annotated PDF (page deletions, reordering, rotations and text annotations are all baked in)
- **Zoom** — +/−/1:1 controls, keyboard `+`/`-`
- **Keyboard shortcuts**: `T` toggle text tool · `+`/`-` zoom · `←`/`→` navigate pages · `Delete` remove selected annotation · `Esc` cancel

## Install a pre-built release

1. Go to the [Releases](../../releases) page and download `pdf-editor-extension.zip` from the latest release.
2. Unzip it — you get a folder called `dist/`.
3. Open Chrome → `chrome://extensions` → enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the unzipped `dist/` folder.
5. Click the extension icon in the toolbar to open the editor.

## Build locally

**Requirements:** Node.js 18+

```bash
npm install        # install dependencies
npm run build      # generates icons, bundles with Vite → dist/
```

Load `dist/` as an unpacked extension (step 3–5 above).

## CI / CD — GitHub Actions

Every push of a `vX.Y.Z` tag triggers the [Build & Release workflow](.github/workflows/release.yml):

1. Installs dependencies (`npm ci`)
2. Runs `npm run build` (icon generation + Vite bundle → `dist/`)
3. Zips `dist/` → `pdf-editor-extension.zip`
4. Attaches the zip to a new **GitHub Release** (auto-generated release notes included)

To release a new version:

```bash
git tag v1.2.3
git push origin v1.2.3
```

The workflow also runs on `workflow_dispatch` (manual trigger from the Actions tab) for test builds, uploading the zip as a workflow artifact without creating a Release.

## Project structure

```
.
├── src/
│   ├── main.jsx          # React entry point
│   └── PDFEditor.jsx     # Full editor component
├── editor.html           # Vite HTML entry point
├── popup.html/js/css     # Extension toolbar popup
├── background.js         # Service worker (opens editor tab)
├── manifest.json         # Chrome Manifest V3
├── scripts/
│   └── generate-icons.js # Generates icons/ PNGs via node-canvas
├── vite.config.mjs       # Vite config (React plugin + extension file copy)
├── .github/
│   └── workflows/
│       └── release.yml   # Build & Release CI workflow
└── package.json
```

`dist/` and `icons/*.png` are generated at build time and are not committed.
