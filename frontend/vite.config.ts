import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: __dirname,
  base: "/app/",
  plugins: [react()],
  build: {
    outDir: "../web-dist",
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022",
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/downloads": "http://127.0.0.1:8787",
    },
  },
});
