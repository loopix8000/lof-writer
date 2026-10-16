import React from "react";
import { createRoot } from "react-dom/client";
import { installTauriBridge } from "./tauri-bridge";
import PinGate from "./PinGate";
import "./style.css";

installTauriBridge();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PinGate />
  </React.StrictMode>,
);
