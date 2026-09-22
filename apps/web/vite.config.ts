import { defineConfig } from "vite";

// noVNC's core modules use top-level await, which the default Vite target (es2020) rejects.
// The cloud console is a browser-only app served over TLS, so a modern target is appropriate.
export default defineConfig({
  build: { target: "esnext", outDir: "dist", emptyOutDir: true },
  esbuild: { target: "esnext" },
  optimizeDeps: { esbuildOptions: { target: "esnext" } }
});
