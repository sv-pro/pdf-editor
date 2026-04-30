import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import PDFEditor from "./PDFEditor.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <PDFEditor />
  </StrictMode>
);
