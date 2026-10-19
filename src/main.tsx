import React from "react";
import { createRoot } from "react-dom/client";
import { installTauriBridge } from "./tauri-bridge";
import PinGate from "./PinGate";
import { preloadRememberedFonts } from "./font-loader";
import "./fonts.css";
import "./style.css";

installTauriBridge();
preloadRememberedFonts();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PinGate />
  </React.StrictMode>,
);
