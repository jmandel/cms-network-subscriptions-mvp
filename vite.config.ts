import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "demo",
  base: process.env.BASE_PATH ?? "/",
  plugins: [react()],
  resolve: {
    dedupe: ["react", "react-dom"],
  },
  optimizeDeps: {
    force: true,
  },
  build: {
    outDir: "dist",
  },
});
