import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { outDir: "dist" },
  optimizeDeps: {
    entries: ["index.html"],
  },
  server: {
    host: host || "127.0.0.1",
    port: 5173,
    strictPort: true,
    hmr: host ? { protocol: "ws", host, port: 5173 } : undefined,
    watch: {
      ignored: ["**/src-tauri/**", "**/temp/**", "**/release/**"],
    },
  },
});
