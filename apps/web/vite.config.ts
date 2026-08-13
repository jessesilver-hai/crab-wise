import { defineConfig } from "vite";

// WebContainers require cross-origin isolation. COEP `credentialless` (rather
// than `require-corp`) keeps direct fetches to api.anthropic.com working.
export const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};

export default defineConfig({
  server: {
    headers: isolationHeaders,
    port: 5173,
    proxy: {
      "/api": "http://localhost:8080",
      "/ws": { target: "ws://localhost:8080", ws: true },
    },
  },
  preview: {
    headers: isolationHeaders,
  },
  build: {
    target: "es2022",
  },
});
