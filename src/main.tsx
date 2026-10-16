import React from "react";
import { createRoot } from "react-dom/client";
import { installTauriBridge } from "./tauri-bridge";
import App from "./App";
import "./style.css";

installTauriBridge();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
