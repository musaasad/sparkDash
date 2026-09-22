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
    host: "0.0.0.0",
    port: 5173,
    // Allow HMR when opened via LAN IP / Docker
    watch: {
      usePolling: process.env.CHOKIDAR_USEPOLLING === "1",
    },
    // Dev API target. Default matches the server default port; point at a dev
    // instance (e.g. http://127.0.0.1:5556) when the default port is occupied
    // by something else — never accidentally proxy to another machine.
    proxy: (() => {
      const target = process.env.VITE_API_TARGET || "http://127.0.0.1:5555";
      return {
        "/api": target,
        "/ws": { target: target.replace(/^http/, "ws"), ws: true },
      };
    })(),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});