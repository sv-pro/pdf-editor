# PDF Editor

A Chrome extension for annotating and editing PDF files directly in your browser — no upload, no cloud, 100 % private.

## Features

- ✏️ **Freehand pen** – draw on any page in any colour
- 🖊️ **Highlight** – semi-transparent colour rectangles
- **T Text** – type notes anywhere on the page
- ↩ **Undo** – up to 30 steps per page
- ⬇ **Save as PDF** – export the annotated file
- 🔒 **Private** – everything runs locally in your browser

## Project structure

```
src/
  extension/    # Chrome extension source
    manifest.json
    background.js
    editor/     # Full-page PDF editor (PDF.js + annotation canvas)
    popup/      # Toolbar icon popup
  website/      # One-page landing site with download link
scripts/
  build.js      # Builds dist/extension/ and dist/website/
  pack.js       # Zips the extension → dist/pdf-editor.zip
  serve.js      # Local HTTP server for the website
```

## Getting started

### Install dependencies

```bash
npm install
```

### Build

```bash
npm run build
```

Produces `dist/extension/` (the unpacked extension) and `dist/website/` (the website).

### Pack

```bash
npm run pack
```

Creates `dist/pdf-editor.zip` and copies it into `dist/website/download/` so the website's download link works.

### Preview the website locally

```bash
npm run serve        # listens on http://localhost:3000
npm run serve 8080   # custom port
```

### Clean

```bash
npm run clean
```

## Installing the extension in Chrome

1. Run `npm run pack` to build the zip, then unzip `dist/pdf-editor.zip`.
2. Open Chrome and go to `chrome://extensions`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the unzipped `pdf-editor/` folder.
5. The PDF Editor icon appears in your toolbar. Navigate to any PDF and click it!

## Using the editor

| Tool      | How to use |
|-----------|------------|
| ✏️ Pen    | Click-drag to draw freehand |
| 🖊️ Highlight | Click-drag to draw a semi-transparent rectangle |
| T Text    | Click to place a text box, press Enter to commit |
| ⬜ Eraser | Click-drag to erase annotations |
| ⬇ Save   | Downloads the PDF with annotations baked in |

You can also drag-and-drop a local PDF onto the editor page, or open one via the **Open** button.
