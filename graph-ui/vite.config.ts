import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:9749",
      // R26 (Bug #2 fix): proxy WebSocket connections to the backend.
      // Without this, useWebSocket tries to connect to localhost:5173 (Vite)
      // instead of localhost:9749 (UiServer), and real-time updates never work.
      // The `ws: true` flag tells Vite to upgrade HTTP to WebSocket.
      "/ws": {
        target: "ws://127.0.0.1:9749",
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
