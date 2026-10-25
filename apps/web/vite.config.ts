import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  root: ".",
  server: {
    host: "0.0.0.0",
    port: 5173,
  },
  resolve: {
    alias: {
      "@paper-irl/rules": path.resolve(__dirname, "../../packages/rules/src/index.ts"),
    },
  },
  publicDir: "public",
});
