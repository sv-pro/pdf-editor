import { useState, useEffect, useRef, useCallback } from "react";
import * as pdfjsLib from "pdfjs-dist";
import { PDFDocument, rgb, degrees as pdfDegrees, StandardFonts } from "pdf-lib";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

// Point PDF.js at the locally-bundled worker (no CDN needed in the extension)
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/* ─── Matrix helpers for coordinate transform ─── */
function invertMatrix([a, b, c, d, e, f]) {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}
function applyMatrix([a, b, c, d, e, f], [x, y]) {
  return [a * x + c * y + e, b * x + d * y + f];
}

/* ─── Page thumbnail ─── */
function Thumb({ doc, origPageNum, extraRot, active, onClick }) {
  const cvRef = useRef(null);
  useEffect(() => {
    if (!doc || !cvRef.current) return;
    let alive = true;
    (async () => {
      const page = await doc.getPage(origPageNum);
      const vp = page.getViewport({ scale: 0.16, rotation: extraRot || 0 });
      if (!alive || !cvRef.current) return;
      const cv = cvRef.current;
      cv.width = vp.width;
      cv.height = vp.height;
      const ctx = cv.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, cv.width, cv.height);
      page.render({ canvasContext: ctx, viewport: vp }).promise.catch(() => {});
    })();
    return () => { alive = false; };
  }, [doc, origPageNum, extraRot]);

  return (
    <div
      onClick={onClick}
      title={`Page ${origPageNum}`}
      style={{
        cursor: "pointer", padding: 5, borderRadius: 6, marginBottom: 6,
        border: `2px solid ${active ? "#00e5ff" : "transparent"}`,
        background: active ? "#0a2030" : "#16161a",
        display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
        transition: "all 0.14s",
      }}
    >
      <div style={{ background: "#fff", lineHeight: 0, boxShadow: "0 2px 6px #00000088" }}>
        <canvas ref={cvRef} style={{ display: "block", maxWidth: 90 }} />
      </div>
      <span style={{ fontSize: 9, color: active ? "#00e5ff" : "#444", fontFamily: "monospace", letterSpacing: 1 }}>
        {origPageNum}
      </span>
    </div>
  );
}

/* ─── Button component ─── */
function Btn({ children, onClick, accent, danger, active, disabled, title, small }) {
  const bg = danger ? "#ff444416" : accent || active ? "#00e5ff14" : "transparent";
  const border = danger ? "#ff4444" : accent || active ? "#00e5ff" : "#2a2a35";
  const col = disabled ? "#333" : danger ? "#ff6666" : accent || active ? "#00e5ff" : "#999";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        padding: small ? "3px 7px" : "5px 11px",
        borderRadius: 5,
        border: `1px solid ${border}`,
        background: bg,
        color: col,
        cursor: disabled ? "not-allowed" : "pointer",
        fontSize: 11,
        fontFamily: "monospace",
        whiteSpace: "nowrap",
        transition: "all 0.12s",
        letterSpacing: 0.5,
      }}
    >
      {children}
    </button>
  );
}

/* ─── Divider ─── */
const Divider = () => (
  <div style={{ width: 1, height: 20, background: "#2a2a35", margin: "0 2px", flexShrink: 0 }} />
);

/* ══════════════════════════════════════════════════════════════════
   MAIN PDF EDITOR
══════════════════════════════════════════════════════════════════ */
export default function PDFEditor() {
  const [fileName, setFileName] = useState("");
  const [origBytes, setOrigBytes] = useState(null);
  const [pdfJs, setPdfJs] = useState(null);

  // Page state
  const [pageOrder, setPageOrder] = useState([]);   // 1-based original page numbers
  const [rotations, setRotations] = useState({});   // { origPageNum: extraDegrees }
  const [cur, setCur] = useState(1);                // 1-based index into pageOrder
  const [zoom, setZoom] = useState(1.2);

  // Tool state
  const [tool, setTool] = useState("select");
  const [fontSize, setFontSize] = useState(16);
  const [fontColor, setFontColor] = useState("#000000");
  const [bold, setBold] = useState(false);

  // Annotations: { id, orderIdx, x, y, transform, text, fontSize, color, bold }
  const [annots, setAnnots] = useState([]);
  const [pending, setPending] = useState(null);     // { x, y, transform }
  const [inputVal, setInputVal] = useState("");
  const [selectedAnnot, setSelectedAnnot] = useState(null);

  // UI state
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyMsg, setBusyMsg] = useState("");

  const canvasRef = useRef(null);
  const renderRef = useRef(null);
  const vpTransformRef = useRef(null);
  const fileInputRef = useRef(null);
  const textInputRef = useRef(null);
  const sidebarRef = useRef(null);

  /* ── Load PDF from raw bytes (used for pre-loaded PDFs from session storage) ── */
  const loadBytes = useCallback(async (bytes, name) => {
    setBusy(true);
    setBusyMsg("Loading PDF...");
    try {
      setFileName(name);
      setOrigBytes(bytes);
      const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      setPdfJs(doc);
      const n = doc.numPages;
      setPageOrder(Array.from({ length: n }, (_, i) => i + 1));
      setRotations({});
      setAnnots([]);
      setSelectedAnnot(null);
      setCur(1);
      setTool("select");
    } catch (err) {
      console.error(err);
      alert("Failed to load PDF. Please try opening the file manually.");
    }
    setBusy(false);
    setBusyMsg("");
  }, []);

  /* ── Load PDF file ── */
  const loadFile = useCallback(async (file) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      alert("Please select a PDF file.");
      return;
    }
    const buf = await file.arrayBuffer();
    await loadBytes(new Uint8Array(buf), file.name);
  }, [loadBytes]);

  /* ── Auto-load PDF pre-fetched by the background service worker ── */
  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome.storage?.session) return;
    const key = new URLSearchParams(window.location.search).get("pdfKey");
    if (!key) return;
    (async () => {
      const data = await chrome.storage.session.get(key);
      await chrome.storage.session.remove(key);
      if (!data[key]) return;
      const { bytes, fileName: name } = data[key];
      await loadBytes(new Uint8Array(bytes), name);
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Render current page ── */
  useEffect(() => {
    if (!pdfJs || !canvasRef.current) return;
    const origNum = pageOrder[cur - 1];
    if (!origNum) return;

    let alive = true;
    if (renderRef.current) { try { renderRef.current.cancel(); } catch {} }

    (async () => {
      const page = await pdfJs.getPage(origNum);
      const rot = rotations[origNum] || 0;
      const vp = page.getViewport({ scale: zoom, rotation: rot });
      vpTransformRef.current = [...vp.transform];

      if (!alive || !canvasRef.current) return;
      const cv = canvasRef.current;
      cv.width = vp.width;
      cv.height = vp.height;
      const ctx = cv.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, cv.width, cv.height);

      const task = page.render({ canvasContext: ctx, viewport: vp });
      renderRef.current = task;
      try { await task.promise; } catch {}
    })();

    return () => { alive = false; };
  }, [pdfJs, cur, pageOrder, rotations, zoom]);

  /* ── Focus input when pending ── */
  useEffect(() => {
    if (pending && textInputRef.current) textInputRef.current.focus();
  }, [pending]);

  /* ── Canvas click (place text) ── */
  const handleCanvasClick = (e) => {
    if (tool !== "text" || pending) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setPending({ x, y, transform: vpTransformRef.current ? [...vpTransformRef.current] : null });
    setInputVal("");
  };

  /* ── Commit text annotation ── */
  const commitText = useCallback(() => {
    if (!pending) return;
    const txt = inputVal.trim();
    if (txt) {
      setAnnots((prev) => [
        ...prev,
        {
          id: Date.now(),
          orderIdx: cur - 1,
          x: pending.x,
          y: pending.y,
          transform: pending.transform,
          text: txt,
          fontSize,
          color: fontColor,
          bold,
        },
      ]);
    }
    setPending(null);
    setInputVal("");
  }, [pending, inputVal, cur, fontSize, fontColor, bold]);

  /* ── Page operations ── */
  const rotatePage = (delta) => {
    const orig = pageOrder[cur - 1];
    setRotations((prev) => ({ ...prev, [orig]: ((prev[orig] || 0) + delta + 360) % 360 }));
  };

  const deletePage = () => {
    if (pageOrder.length <= 1) return;
    const idx = cur - 1;
    setPageOrder((prev) => prev.filter((_, i) => i !== idx));
    setAnnots((prev) =>
      prev
        .filter((a) => a.orderIdx !== idx)
        .map((a) => ({ ...a, orderIdx: a.orderIdx > idx ? a.orderIdx - 1 : a.orderIdx }))
    );
    setCur((c) => Math.min(c, pageOrder.length - 1));
  };

  const movePage = (dir) => {
    const i = cur - 1;
    const j = i + dir;
    if (j < 0 || j >= pageOrder.length) return;
    const newOrder = [...pageOrder];
    [newOrder[i], newOrder[j]] = [newOrder[j], newOrder[i]];
    setAnnots((prev) =>
      prev.map((a) => ({
        ...a,
        orderIdx: a.orderIdx === i ? j : a.orderIdx === j ? i : a.orderIdx,
      }))
    );
    setPageOrder(newOrder);
    setCur(j + 1);
  };

  /* ── Export PDF ── */
  const exportPDF = async () => {
    if (!origBytes) return;
    setBusy(true);
    setBusyMsg("Exporting...");
    try {
      const srcDoc = await PDFDocument.load(origBytes);
      const newDoc = await PDFDocument.create();

      // Copy pages in current order
      const copied = await newDoc.copyPages(srcDoc, pageOrder.map((n) => n - 1));
      copied.forEach((p) => newDoc.addPage(p));

      // Apply rotations
      const newPages = newDoc.getPages();
      pageOrder.forEach((origNum, i) => {
        const addRot = rotations[origNum] || 0;
        if (addRot) {
          const p = newPages[i];
          p.setRotation(pdfDegrees((p.getRotation().angle + addRot) % 360));
        }
      });

      // Embed fonts
      const fontRegular = await newDoc.embedFont(StandardFonts.Helvetica);
      const fontBold    = await newDoc.embedFont(StandardFonts.HelveticaBold);

      // Add text annotations
      for (const ann of annots) {
        const p = newPages[ann.orderIdx];
        if (!p) continue;

        let pdfX, pdfY;
        if (ann.transform) {
          // Precise coordinate transform via viewport matrix inverse
          const inv = invertMatrix(ann.transform);
          const [px, py] = applyMatrix(inv, [ann.x, ann.y]);
          pdfX = px;
          pdfY = py - ann.fontSize;
        } else {
          const { height: ph } = p.getSize();
          pdfX = ann.x / zoom;
          pdfY = ph - ann.y / zoom - ann.fontSize;
        }

        const hex = ann.color.replace("#", "");
        const r = parseInt(hex.slice(0, 2), 16) / 255;
        const g = parseInt(hex.slice(2, 4), 16) / 255;
        const b = parseInt(hex.slice(4, 6), 16) / 255;

        p.drawText(ann.text, {
          x: Math.max(0, pdfX),
          y: Math.max(0, pdfY),
          size: ann.fontSize,
          font: ann.bold ? fontBold : fontRegular,
          color: rgb(r, g, b),
        });
      }

      const outBytes = await newDoc.save();
      const url = URL.createObjectURL(new Blob([outBytes], { type: "application/pdf" }));
      const a = Object.assign(document.createElement("a"), {
        href: url,
        download: fileName.replace(/\.pdf$/i, "_edited.pdf"),
      });
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Export error:", err);
      alert("Export failed: " + err.message);
    }
    setBusy(false);
    setBusyMsg("");
  };

  /* ── Drag & drop ── */
  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    loadFile(e.dataTransfer.files[0]);
  };

  /* ── Keyboard shortcuts ── */
  useEffect(() => {
    const onKey = (e) => {
      if (!pdfJs) return;
      if (e.target.tagName === "INPUT") return;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") setCur((c) => Math.min(pageOrder.length, c + 1));
      if (e.key === "ArrowLeft"  || e.key === "ArrowUp")   setCur((c) => Math.max(1, c - 1));
      if (e.key === "t" || e.key === "T") setTool((t) => (t === "text" ? "select" : "text"));
      if (e.key === "+" || e.key === "=") setZoom((z) => Math.min(3, +(z + 0.2).toFixed(1)));
      if (e.key === "-") setZoom((z) => Math.max(0.3, +(z - 0.2).toFixed(1)));
      if (e.key === "Delete" && selectedAnnot !== null) {
        setAnnots((prev) => prev.filter((a) => a.id !== selectedAnnot));
        setSelectedAnnot(null);
      }
      if (e.key === "Escape") { setPending(null); setSelectedAnnot(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pdfJs, pageOrder.length, selectedAnnot]);

  /* ── Annotations for current page ── */
  const curAnnots = annots.filter((a) => a.orderIdx === cur - 1);
  const hasFile = !!pdfJs;
  const totalPages = pageOrder.length;

  /* ─────────────────────────────────────────────────────────────────
     RENDER
  ───────────────────────────────────────────────────────────────── */
  return (
    <div
      style={{ display: "flex", flexDirection: "column", height: "100vh", background: "#0a0a0c", color: "#c8c8d0", fontFamily: "monospace", overflow: "hidden", fontSize: 12 }}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false); }}
      onDrop={handleDrop}
    >
      {/* ── TOP BAR ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 14px", background: "#0f0f13", borderBottom: "1px solid #1e1e28", flexShrink: 0, minHeight: 42 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: "#00e5ff", fontSize: 13, fontWeight: "bold", letterSpacing: 3 }}>PDF</span>
          <span style={{ color: "#2a4a5a", fontSize: 13, fontWeight: "bold", letterSpacing: 3 }}>EDITOR</span>
        </div>
        {fileName && (
          <span style={{ color: "#3a3a50", fontSize: 10, letterSpacing: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 260 }}>
            /{fileName}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {busy && (
          <span style={{ color: "#00e5ff88", fontSize: 10, letterSpacing: 2 }}>
            {busyMsg}
          </span>
        )}
        <Btn onClick={() => fileInputRef.current.click()} accent>Open PDF</Btn>
        {hasFile && <Btn onClick={exportPDF} disabled={busy} accent>Export PDF ↓</Btn>}
        <input ref={fileInputRef} type="file" accept=".pdf" style={{ display: "none" }}
          onChange={(e) => loadFile(e.target.files[0])} />
      </div>

      {!hasFile ? (
        /* ── DROP ZONE ── */
        <div
          onClick={() => fileInputRef.current.click()}
          style={{
            flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            gap: 20, cursor: "pointer", transition: "all 0.2s",
            background: dragging ? "#001824" : "transparent",
          }}
        >
          <div style={{
            border: `2px dashed ${dragging ? "#00e5ff" : "#1e2030"}`,
            borderRadius: 16, padding: "60px 80px",
            display: "flex", flexDirection: "column", alignItems: "center", gap: 16,
            transition: "all 0.2s",
            background: dragging ? "#00e5ff08" : "transparent",
          }}>
            <div style={{ fontSize: 52, opacity: 0.3 }}>&#x2B21;</div>
            <div style={{ color: "#3a4060", fontSize: 13, letterSpacing: 2, textTransform: "uppercase" }}>
              {dragging ? "Release to open" : "Drop PDF here"}
            </div>
            <div style={{ color: "#252535", fontSize: 10, letterSpacing: 1 }}>or click to browse</div>
          </div>
          <div style={{ color: "#1e2030", fontSize: 10, letterSpacing: 1 }}>
            Shortcuts: T = text tool &middot; +/- = zoom &middot; arrow keys = navigate
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

          {/* ── SIDEBAR ── */}
          <div ref={sidebarRef} style={{
            width: 116, background: "#0d0d11", borderRight: "1px solid #1a1a24",
            display: "flex", flexDirection: "column", flexShrink: 0, overflow: "hidden",
          }}>
            {/* Page reorder controls */}
            <div style={{ padding: "8px 6px 4px", display: "flex", gap: 3, borderBottom: "1px solid #1a1a24" }}>
              <Btn small onClick={() => movePage(-1)} disabled={cur <= 1} title="Move page up">&#x2191; Up</Btn>
              <Btn small onClick={() => movePage(1)} disabled={cur >= totalPages} title="Move page down">&#x2193; Dn</Btn>
            </div>
            {/* Thumbnails */}
            <div style={{ flex: 1, overflowY: "auto", padding: "6px 6px", scrollbarWidth: "thin", scrollbarColor: "#2a2a35 transparent" }}>
              {pageOrder.map((origN, i) => (
                <Thumb
                  key={`${origN}-${i}`}
                  doc={pdfJs}
                  origPageNum={origN}
                  extraRot={rotations[origN] || 0}
                  active={i + 1 === cur}
                  onClick={() => setCur(i + 1)}
                />
              ))}
            </div>
            {/* Page counter */}
            <div style={{ padding: "6px 8px", borderTop: "1px solid #1a1a24", color: "#333", fontSize: 9, letterSpacing: 1, textAlign: "center" }}>
              {cur} / {totalPages} pages
            </div>
          </div>

          {/* ── CENTER COLUMN ── */}
          <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>

            {/* ── TOOLBAR ── */}
            <div style={{
              display: "flex", alignItems: "center", gap: 6, padding: "5px 10px",
              background: "#0d0d11", borderBottom: "1px solid #1a1a24", flexShrink: 0,
              flexWrap: "wrap", minHeight: 36,
            }}>
              {/* Tool selector */}
              <span style={{ color: "#2a3050", fontSize: 9, letterSpacing: 2 }}>TOOL</span>
              <Btn active={tool === "select"} onClick={() => { setTool("select"); setPending(null); }}>Select</Btn>
              <Btn active={tool === "text"} onClick={() => setTool("text")} title="Add text (T)">T Add Text</Btn>
              <Divider />

              {/* Text properties — shown only when text tool is active */}
              {tool === "text" && (
                <>
                  <span style={{ color: "#2a3050", fontSize: 9, letterSpacing: 2 }}>TEXT</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <input
                      type="number" value={fontSize} min={6} max={96}
                      onChange={(e) => setFontSize(Math.max(6, Math.min(96, Number(e.target.value))))}
                      style={{ width: 40, background: "#16161e", border: "1px solid #2a2a35", color: "#c8c8d0", borderRadius: 4, padding: "3px 5px", fontSize: 11, fontFamily: "monospace" }}
                      title="Font size"
                    />
                    <span style={{ color: "#333", fontSize: 9 }}>px</span>
                    <input
                      type="color" value={fontColor}
                      onChange={(e) => setFontColor(e.target.value)}
                      style={{ width: 26, height: 22, border: "1px solid #2a2a35", borderRadius: 4, background: "none", cursor: "pointer", padding: 1 }}
                      title="Text color"
                    />
                    <Btn active={bold} onClick={() => setBold((b) => !b)} title="Toggle bold" small>
                      <strong>B</strong>
                    </Btn>
                  </div>
                  <Divider />
                </>
              )}

              {/* Page operations */}
              <span style={{ color: "#2a3050", fontSize: 9, letterSpacing: 2 }}>PAGE</span>
              <Btn small onClick={() => rotatePage(-90)} title="Rotate left 90°">&#x21BA; L</Btn>
              <Btn small onClick={() => rotatePage(90)}  title="Rotate right 90°">&#x21BB; R</Btn>
              <Btn
                small danger
                onClick={deletePage}
                disabled={pageOrder.length <= 1}
                title={pageOrder.length <= 1 ? "Cannot delete the only page" : "Delete current page (permanent)"}
              >
                &#x2715; Del Page
              </Btn>
              <Divider />

              {/* Zoom */}
              <span style={{ color: "#2a3050", fontSize: 9, letterSpacing: 2 }}>ZOOM</span>
              <Btn small onClick={() => setZoom((z) => Math.max(0.3, +(z - 0.2).toFixed(1)))} title="Zoom out (-)">&#x2212;</Btn>
              <span style={{ color: "#555", fontSize: 10, minWidth: 36, textAlign: "center" }}>{Math.round(zoom * 100)}%</span>
              <Btn small onClick={() => setZoom((z) => Math.min(3, +(z + 0.2).toFixed(1)))} title="Zoom in (+)">+</Btn>
              <Btn small onClick={() => setZoom(1)} title="Reset to 100%">1:1</Btn>
            </div>

            {/* ── CANVAS AREA ── */}
            <div
              style={{
                flex: 1, overflow: "auto", display: "flex", alignItems: "flex-start", justifyContent: "center",
                padding: 20, background: "#141418",
                scrollbarWidth: "thin", scrollbarColor: "#2a2a35 transparent",
              }}
            >
              <div style={{ position: "relative", lineHeight: 0, boxShadow: "0 4px 32px #000000cc" }}>
                {/* PDF render canvas */}
                <canvas
                  ref={canvasRef}
                  onClick={handleCanvasClick}
                  style={{ display: "block", cursor: tool === "text" ? "crosshair" : "default" }}
                />

                {/* Text annotation overlays */}
                {curAnnots.map((ann) => (
                  <div
                    key={ann.id}
                    onClick={() => {
                      if (tool === "select") setSelectedAnnot(ann.id === selectedAnnot ? null : ann.id);
                    }}
                    style={{
                      position: "absolute",
                      left: ann.x,
                      top: ann.y - ann.fontSize,
                      fontSize: ann.fontSize,
                      color: ann.color,
                      fontWeight: ann.bold ? "bold" : "normal",
                      fontFamily: "Helvetica, Arial, sans-serif",
                      whiteSpace: "pre",
                      cursor: tool === "select" ? "pointer" : "default",
                      userSelect: "none",
                      outline: ann.id === selectedAnnot ? "1px dashed #00e5ff" : "none",
                      padding: 2,
                    }}
                  >
                    {ann.text}
                    {ann.id === selectedAnnot && (
                      <span
                        onClick={(ev) => {
                          ev.stopPropagation();
                          setAnnots((prev) => prev.filter((a) => a.id !== ann.id));
                          setSelectedAnnot(null);
                        }}
                        style={{ marginLeft: 4, color: "#ff4444", cursor: "pointer", fontSize: 11 }}
                        title="Delete annotation"
                      >
                        &#x2715;
                      </span>
                    )}
                  </div>
                ))}

                {/* Pending text input */}
                {pending && (
                  <div style={{ position: "absolute", left: pending.x, top: pending.y - fontSize, zIndex: 10 }}>
                    <input
                      ref={textInputRef}
                      value={inputVal}
                      onChange={(e) => setInputVal(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitText(); }
                        if (e.key === "Escape") { setPending(null); setInputVal(""); }
                      }}
                      onBlur={commitText}
                      style={{
                        fontSize,
                        color: fontColor,
                        fontWeight: bold ? "bold" : "normal",
                        fontFamily: "Helvetica, Arial, sans-serif",
                        background: "rgba(0,229,255,0.07)",
                        border: "1px dashed #00e5ff",
                        outline: "none",
                        padding: 2,
                        minWidth: 80,
                        borderRadius: 2,
                      }}
                      placeholder="Type text, Enter to confirm"
                    />
                  </div>
                )}
              </div>
            </div>

            {/* ── STATUS BAR ── */}
            <div style={{
              background: "#0a0a0c", borderTop: "1px solid #1a1a24", padding: "4px 14px",
              display: "flex", alignItems: "center", gap: 12, flexShrink: 0, fontSize: 10,
            }}>
              <span style={{ color: "#2a3050", letterSpacing: 1 }}>
                PAGE <span style={{ color: "#555" }}>{cur}</span> / <span style={{ color: "#555" }}>{totalPages}</span>
              </span>
              <span style={{ color: "#2a3050", letterSpacing: 1 }}>
                ZOOM <span style={{ color: "#555" }}>{Math.round(zoom * 100)}%</span>
              </span>
              <span style={{ color: "#2a3050", letterSpacing: 1 }}>
                ANNOTATIONS <span style={{ color: "#555" }}>{curAnnots.length}</span>
              </span>
              <div style={{ flex: 1 }} />
              <span style={{ color: "#1e2030" }}>
                T=text &middot; +/-=zoom &middot; arrows=navigate &middot; Del=delete annot &middot; Esc=cancel
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
