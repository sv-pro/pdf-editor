import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import path from "path";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

/** Copy static extension files into dist after Vite finishes bundling. */
function copyExtensionFiles() {
  return {
    name: "copy-extension-files",
    closeBundle() {
      const distDir = "dist";
      const staticFiles = [
        "manifest.json",
        "popup.html",
        "popup.js",
        "popup.css",
        "background.js",
      ];
      staticFiles.forEach((f) => {
        if (fs.existsSync(f)) {
          fs.copyFileSync(f, path.join(distDir, f));
          console.log(`  copied ${f} → dist/${f}`);
        }
      });

      const iconsDir = path.join(distDir, "icons");
      if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });
      [16, 32, 48, 128].forEach((s) => {
        const src = `icons/icon${s}.png`;
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(iconsDir, `icon${s}.png`));
        }
      });
      console.log("  copied icons/ → dist/icons/");
    },
  };
}

export default defineConfig({
  plugins: [react(), copyExtensionFiles()],

  // Relative asset paths so the extension works from chrome-extension://...
  base: "./",

  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, "editor.html"),
    },
  },
});
