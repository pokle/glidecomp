import { defineConfig, searchForWorkspaceRoot, type Plugin, type Connect } from 'vite';
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
          `\n    • Use production:    VITE_AIRSCORE_URL=https://glidecomp.com/api/airscore bun run dev\n`
        );
      });
    },
  };
}

export default defineConfig({
  root: 'src',
  envDir: resolve(__dirname, '../..'),
  publicDir: '../public',
  plugins: [
    tailwindcss(),
    airscoreWorkerCheck(),
    {
      // Rewrite /u/* to /dashboard.html in dev (mirrors Cloudflare Pages _redirects)
      name: 'rewrite-u-routes',
      configureServer(server) {
        server.middlewares.use((req: Connect.IncomingMessage, _res, next) => {
          if (req.url?.startsWith('/u/')) {
            req.url = '/dashboard.html';
          }
          next();
        });
      },
    },
  ],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/index.html'),
        analysis: resolve(__dirname, 'src/analysis.html'),
        onboarding: resolve(__dirname, 'src/onboarding.html'),
        dashboard: resolve(__dirname, 'src/dashboard.html'),
        about: resolve(__dirname, 'src/about.html'),
      },
    },
  },
  server: {
    port: 3000,
    fs: {
      allow: [
        searchForWorkspaceRoot(process.cwd()),
      ],
    },
    proxy: {
      '/api/auth': {
        target: 'http://localhost:8788',
        changeOrigin: true,
      },
    },
  },
});
