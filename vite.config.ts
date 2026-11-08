import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri serves the frontend from a fixed port in dev and from ../dist in release.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  base: "./",
  build: { target: "es2022", sourcemap: false },
});
