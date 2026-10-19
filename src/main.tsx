import React from "react";
import { createRoot } from "react-dom/client";
import { installTauriBridge } from "./tauri-bridge";
import PinGate from "./PinGate";
import "./fonts.css";
import "./style.css";

installTauriBridge();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PinGate />
  </React.StrictMode>,
);
