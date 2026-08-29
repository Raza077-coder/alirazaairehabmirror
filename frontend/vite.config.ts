import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), wasm()],
  // Base path for GitHub Pages project site (https://<user>.github.io/alirazaairehabmirror/)
  base: "/alirazaairehabmirror/",
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
  optimizeDeps: {
    exclude: ["@mediapipe/tasks-vision"],
  },
});