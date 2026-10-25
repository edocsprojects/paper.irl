import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import path from "node:path";

// `vite --mode phone` serves HTTPS on the LAN: phone browsers only allow GPS
// on secure origins (plain http works on localhost only).
export default defineConfig(({ mode }) => ({
  root: ".",
  envDir: path.resolve(__dirname, "../.."),
  plugins: mode === "phone" ? [basicSsl()] : [],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      // Same-origin API so HTTPS pages can reach the local server.
      "/api": {
        target: "http://localhost:3001",
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
  resolve: {
    alias: {
      "@paper-irl/rules": path.resolve(__dirname, "../../packages/rules/src/index.ts"),
    },
  },
  publicDir: "public",
}));
