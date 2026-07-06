import { defineConfig, searchForWorkspaceRoot, type Plugin, type Connect } from 'vite';
import { resolve } from 'path';
import { readFileSync, existsSync, cpSync } from 'fs';
import { execSync } from 'child_process';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';

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

const SAMPLES_COMPS_DIR = resolve(__dirname, '..', 'samples', 'comps');

/** Serve sample comp files from /data/comps/ in dev */
function sampleCompFiles(): Plugin {
  return {
    name: 'sample-comp-files',
    configureServer(server) {
      server.middlewares.use((req: Connect.IncomingMessage, res, next) => {
        const match = req.url?.match(/^\/data\/comps\/([a-z0-9-]+)\/([a-zA-Z0-9_\-\.]+)$/);
        if (!match) return next();

        const [, compId, filename] = match;
        const filePath = resolve(SAMPLES_COMPS_DIR, compId, filename);

        if (!existsSync(filePath)) {
          (res as any).statusCode = 404;
          (res as any).end('Not found');
          return;
        }

        const content = readFileSync(filePath);
        const ext = filename.split('.').pop()?.toLowerCase();
        (res as any).setHeader('Content-Type', ext === 'xctsk' ? 'application/json' : 'text/plain');
        (res as any).end(content);
      });
    },
  };
}

/** Copy sample comp files to dist/data/comps/ for production */
function copySampleComps(): Plugin {
  return {
    name: 'copy-sample-comps',
    closeBundle() {
      const dest = resolve(__dirname, 'dist', 'data', 'comps');
      cpSync(SAMPLES_COMPS_DIR, dest, { recursive: true });
    },
  };
}

const GIT_SHA = (() => {
  try { return execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim(); }
  catch { return 'unknown'; }
})();

// The static content pages (home, about, legal, scoring/*) are built by the
// sibling Astro app in ./static and, in production, merged into dist/ as real
// HTML. In dev they're served by `astro dev` (started alongside vite by the
// `dev` script) under a `/_static` base so Astro's own Vite asset/HMR
// namespace can't collide with this server's. We proxy both that namespace and
// the clean page URLs there so everything is seamless on one origin (:3000).
const ASTRO_ORIGIN = process.env.ASTRO_ORIGIN || 'http://localhost:4321';
const ASTRO_DEV_BASE = '/_static';
const STATIC_PAGE_ROUTES = new Set([
  '/',
  '/about',
  '/legal',
  '/scoring',
  '/scoring/gap',
  '/scoring/open-distance',
]);

// Root-level Vite dev module URLs that both this server and Astro's dev server
// emit; disambiguated by referer (see the dev middleware below).
const VITE_DEV_INTERNAL = /^\/(@vite\/|@id\/|@fs\/|@react-refresh|src\/|node_modules\/)/;

/** True when a request's referer is one of the Astro-served static pages. */
function refererIsStaticPage(referer: string | undefined): boolean {
  if (!referer) return false;
  try {
    const p = new URL(referer).pathname;
    return p === ASTRO_DEV_BASE || p.startsWith(ASTRO_DEV_BASE + '/') || STATIC_PAGE_ROUTES.has(p);
  } catch {
    return false;
  }
}

/** Forward a dev request to the Astro dev server and stream the reply back. */
async function proxyToAstro(req: Connect.IncomingMessage, res: any, astroPath: string): Promise<void> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers[k] = v;
    else if (Array.isArray(v)) headers[k] = v.join(', ');
  }
  delete headers.host;
  try {
    const upstream = await fetch(ASTRO_ORIGIN + astroPath, {
      method: req.method,
      headers,
      redirect: 'manual',
    });
    res.statusCode = upstream.status;
    upstream.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      if (k === 'content-encoding' || k === 'content-length' || k === 'transfer-encoding') return;
      res.setHeader(key, value);
    });
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    res.statusCode = 502;
    res.end('Astro dev server not reachable at ' + ASTRO_ORIGIN + ' — is `astro dev` running?');
  }
}

export default defineConfig({
  root: 'src',
  envDir: resolve(__dirname, '../..'),
  publicDir: '../public',
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  define: {
    __GIT_SHA__: JSON.stringify(GIT_SHA),
  },
  plugins: [
    tailwindcss(),
    react(),
    airscoreWorkerCheck(),
    sampleCompFiles(),
    copySampleComps(),
    {
      // Emit the build's git SHA as <meta name="git-sha"> in every HTML entry
      // so the post-deploy smoke test can read the deployed version from the
      // raw HTML. The footer's data-git-sha is client-rendered by React and so
      // invisible to curl.
      name: 'inject-git-sha-meta',
      transformIndexHtml() {
        return [{ tag: 'meta', attrs: { name: 'git-sha', content: GIT_SHA }, injectTo: 'head' as const }];
      },
    },
    {
      // Dev routing (mirrors the production _redirects + Astro/Vite split):
      //   /_static/* and the static page URLs  -> Astro dev server
      //   SPA routes                            -> the React app shell (app.html)
      //   old *.html URLs                       -> 301 to their clean URL
      name: 'rewrite-spa-routes',
      configureServer(server) {
        server.middlewares.use((req: Connect.IncomingMessage, _res, next) => {
          // SPA (React) routes are served by the app shell at /app.html.
          // Module/asset requests (they contain a dot) pass through untouched.
          const path = req.url?.split('?')[0] ?? '';
          const isSpaRoute =
            !path.includes('.') &&
            (path.startsWith('/u/') ||
              path === '/comp' ||
              /^\/comp\/[a-z]+(\/|\/task\/[a-z]+\/?)?$/.test(path) ||
              path === '/scores' ||
              /^\/(profile|settings|onboarding)\/?$/.test(path) ||
              /^\/admin\/(users|cache)\/?$/.test(path));
          // Old static-page URLs 301 to their clean SPA/Astro routes.
          const movedTo: Record<string, string> = {
            '/about.html': '/about',
            '/legal.html': '/legal',
            '/scoring.html': '/scoring',
            '/scoring-gap.html': '/scoring/gap',
            '/scoring-open-distance.html': '/scoring/open-distance',
            '/theme-editor': '/',
            '/kitchensink.html': '/',
          };
          if (movedTo[path]) {
            _res.statusCode = 301;
            _res.setHeader('Location', movedTo[path]);
            _res.end();
            return;
          }
          // Astro's own asset/HMR namespace (served under the /_static base).
          if (path === ASTRO_DEV_BASE || path.startsWith(ASTRO_DEV_BASE + '/')) {
            void proxyToAstro(req, _res, req.url ?? '/');
            return;
          }
          // Clean static page URLs -> the same page under Astro's /_static base.
          if (STATIC_PAGE_ROUTES.has(path)) {
            void proxyToAstro(req, _res, ASTRO_DEV_BASE + (req.url ?? '/'));
            return;
          }
          // Astro serves some dev module URLs at the root (/@vite, /@id, /@fs,
          // /src, /node_modules/.vite) rather than under /_static — these
          // collide with this server's own Vite. A static page and the SPA are
          // never open at once, so route by the referring page: assets loaded
          // by a static page belong to Astro.
          if (VITE_DEV_INTERNAL.test(path) && refererIsStaticPage(req.headers.referer)) {
            void proxyToAstro(req, _res, req.url ?? '/');
            return;
          }
          if (isSpaRoute) {
            req.url = '/app.html';
          } else if (req.url === '/replay' || req.url === '/replay/') {
            req.url = '/replay.html';
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
        // The React SPA shell. Served at /app.html; the static Astro Home owns
        // /index.html. Clean SPA routes rewrite here via _redirects.
        app: resolve(__dirname, 'src/app.html'),
        analysis: resolve(__dirname, 'src/analysis.html'),
        replay: resolve(__dirname, 'src/replay.html'),
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
        target: process.env.AUTH_API_URL || 'http://localhost:8788',
        changeOrigin: true,
      },
      '/api/comp': {
        target: process.env.COMP_API_URL || 'http://localhost:8789',
        changeOrigin: true,
      },
      '/api/user': {
        target: process.env.COMP_API_URL || 'http://localhost:8789',
        changeOrigin: true,
      },
      '/api/u/': {
        target: process.env.COMP_API_URL || 'http://localhost:8789',
        changeOrigin: true,
      },
      '/api/admin': {
        target: process.env.COMP_API_URL || 'http://localhost:8789',
        changeOrigin: true,
      },
      // When AIRSCORE_API_URL is set (e.g. in Docker), proxy airscore through
      // Vite so the browser doesn't need direct access to the worker.
      ...(process.env.AIRSCORE_API_URL ? {
        '/api/airscore': {
          target: process.env.AIRSCORE_API_URL,
          changeOrigin: true,
        },
      } : {}),
    },
  },
});
