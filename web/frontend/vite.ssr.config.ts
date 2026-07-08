/**
 * Separate Vite build for the SSR bundle (src/react/entry-server.tsx →
 * ../dist-ssr/entry-server.js), imported by the Pages Function
 * functions/comp/[[path]].ts. Kept apart from the main app build so it has no
 * HTML inputs and no dev middleware.
 *
 * Targets workerd: the `workerd` export condition resolves react-dom/server to
 * its edge build (renderToReadableStream, web streams, no node:stream). Heavy,
 * browser-only modules (mapbox, three, leaflet, tabulator) sit behind
 * lazy()/dynamic import, so they tree-shake out of this bundle. `noExternal`
 * makes the output self-contained for the Functions esbuild step.
 */
import { defineConfig } from "vite";
import { resolve } from "path";
import { execSync } from "child_process";
import react from "@vitejs/plugin-react";

const GIT_SHA = (() => {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
})();

export default defineConfig({
  root: "src",
  envDir: resolve(__dirname, "../.."),
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
    conditions: ["workerd", "worker", "browser"],
  },
  define: {
    __GIT_SHA__: JSON.stringify(GIT_SHA),
  },
  plugins: [react()],
  build: {
    ssr: "react/entry-server.tsx",
    outDir: "../dist-ssr",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Keep lazy()/dynamic imports (the map, tabulator grids) as separate
        // chunks the server never imports, so mapbox/three/leaflet/tabulator —
        // which touch `window` at module scope — stay out of the entry the
        // Pages Function executes.
        inlineDynamicImports: false,
        entryFileNames: "entry-server.js",
        chunkFileNames: "chunks/[name]-[hash].js",
      },
    },
  },
  ssr: {
    noExternal: true,
    target: "webworker",
    // The SSR resolve has its own condition list. `workerd` must be active AND
    // first among matched conditions so react-dom/server resolves to its edge
    // build (renderToReadableStream, web streams) rather than the browser build
    // (which needs MessageChannel — undefined in workerd).
    resolve: {
      conditions: ["workerd", "worker", "browser"],
      externalConditions: ["workerd", "worker", "browser"],
    },
  },
});
