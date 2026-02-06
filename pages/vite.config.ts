import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'path';
import tailwindcss from '@tailwindcss/vite';

function airscoreWorkerCheck(): Plugin {
  return {
    name: 'airscore-worker-check',
    configureServer() {
      if (process.env.VITE_AIRSCORE_URL) {
        console.log(`\n  AirScore API → ${process.env.VITE_AIRSCORE_URL}\n`);
        return;
      }
      const workerUrl = 'http://localhost:8787/';
      fetch(workerUrl).then(() => {
        console.log(`\n  AirScore API worker running at ${workerUrl}\n`);
      }).catch(() => {
        console.warn(
          `\n  ⚠ AirScore API worker is not running at ${workerUrl}` +
          `\n  AirScore features will not work. To fix, either:` +
          `\n    • Start the worker:  bun run --filter airscore-api dev` +
          `\n    • Use production:    VITE_AIRSCORE_URL=https://taskscore.shonky.info/api/airscore bun run dev\n`
        );
      });
    },
  };
}

export default defineConfig({
  root: 'src',
  envDir: resolve(__dirname, '..'),
  publicDir: '../public',
  plugins: [
    tailwindcss(),
    airscoreWorkerCheck(),
  ],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/index.html'),
        analysis: resolve(__dirname, 'src/analysis.html'),
      },
    },
  },
  server: {
    port: 3000,
  },
});
