import { defineConfig, searchForWorkspaceRoot, type Plugin, type Connect } from 'vite';
import { resolve } from 'path';
import { readFileSync, existsSync, cpSync } from 'fs';
import { execSync } from 'child_process';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { buildScoresCsv, scoresCsvFilename, type ScoresCsvInput } from './src/scores-csv';
import { idFromSegment } from './src/react/lib/slug';

// Where /api/* is proxied in dev: the dev-router Worker started by
// `bun run dev:workers` (all Workers, one wrangler session — see
// web/scripts/dev-workers.sh). DEV_API_ORIGIN / DEV_API_PORT override it for a
// setup that puts the Workers somewhere else.
const DEV_API_ORIGIN =
  process.env.DEV_API_ORIGIN || `http://localhost:${process.env.DEV_API_PORT || 8790}`;

function workersCheck(): Plugin {
  return {
    name: 'workers-check',
    configureServer() {
      // Vite is ready in under a second; a cold `wrangler dev` session takes
      // ~20, so a single probe under `bun run dev` (which starts both at once)
      // would always cry wolf. Poll for a while before complaining.
      void (async () => {
        for (let i = 0; i < 40; i++) {
          try {
            // /__ready is 503 until every Worker in the session answers.
            const res = await fetch(`${DEV_API_ORIGIN}/__ready`);
            if (res.ok) {
              console.log(`\n  API Workers running at ${DEV_API_ORIGIN}\n`);
              return;
            }
            await new Promise((r) => setTimeout(r, 1000));
          } catch {
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
        console.warn(
          `\n  ⚠ API Workers are not running at ${DEV_API_ORIGIN}` +
          `\n  Sign-in, competitions and AirScore features will not work. To fix:` +
          `\n    • Start them:  bun run dev:workers   (or just \`bun run dev\`)\n`
        );
      })();
    },
  };
}

/**
 * Dev stand-in for the /comp/:id/scores.csv Pages Function
 * (functions/comp/[[path]].ts). Dev serves no Functions, so without this the
 * scores page's Download → CSV link 404s on :3000 — and a link that only works
 * in production is a link nobody tests. Same builder, same bytes; the visitor's
 * cookie is forwarded so a hidden comp behaves as it does in prod.
 */
function scoresCsvDev(): Plugin {
  return {
    name: 'scores-csv-dev',
    configureServer(server) {
      server.middlewares.use((req: Connect.IncomingMessage, res: any, next) => {
        const match = (req.url?.split('?')[0] ?? '').match(/^\/comp\/([^/]+)\/scores\.csv$/);
        if (!match) return next();
        const compId = idFromSegment(match[1]);
        const headers = req.headers.cookie ? { cookie: req.headers.cookie } : undefined;
        void (async () => {
          try {
            const [compRes, scoresRes] = await Promise.all([
              fetch(`${DEV_API_ORIGIN}/api/comp/${compId}`, { headers }),
              fetch(`${DEV_API_ORIGIN}/api/comp/${compId}/scores`, { headers }),
            ]);
            if (!compRes.ok) {
              res.statusCode = compRes.status === 404 || compRes.status === 400 ? 404 : 502;
              res.end('Competition not found\n');
              return;
            }
            const comp = (await compRes.json()) as { name: string };
            const scores = scoresRes.ok
              ? ((await scoresRes.json()) as ScoresCsvInput)
              : { comp_id: compId, tasks: [], scores: [] };
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader(
              'Content-Disposition',
              `attachment; filename="${scoresCsvFilename(comp.name)}"`
            );
            res.end(
              buildScoresCsv(scores, {
                compName: comp.name,
                // Same rule as the Function: link back to where this came from.
                origin: `http://${req.headers.host ?? 'localhost:3000'}`,
              })
            );
          } catch {
            res.statusCode = 502;
            res.end(`API Workers not reachable at ${DEV_API_ORIGIN}\n`);
          }
        })();
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

// GIT_SHA env wins so builds that run without the .git directory — the
// container preview stages source over a read-only mount — can still stamp the
// real commit rather than falling back to 'unknown'.
const GIT_SHA = (() => {
  if (process.env.GIT_SHA) return process.env.GIT_SHA;
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
// Keep in sync with the Astro pages under static/src/pages/ — a page missing
// here 404s in dev (it still works in prod, where _routes.json hands /scoring/*
// to the built files).
const STATIC_PAGE_ROUTES = new Set([
  '/',
  '/about',
  '/legal',
  '/scoring',
  '/scoring/gap',
  '/scoring/open-distance',
  '/scoring/data-cleaning',
  '/scoring/track-validity',
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
    workersCheck(),
    scoresCsvDev(),
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
      // Preload the body face. It is declared in CSS (src/fonts.css), so
      // without a hint the browser only learns the URL once the stylesheet has
      // parsed — two serial round trips before any text can paint. The
      // filename is content-hashed, so the name is only knowable from the
      // finished bundle; hence a plugin rather than a literal in app.html.
      // Build-only: in dev there is no bundle and the unhashed path is served
      // directly, so the hint would be redundant.
      //
      // Only the `latin` upright file is preloaded. Preloading italic or
      // latin-ext would download faces most pages never use, which costs more
      // than the discovery it saves — unicode-range keeps them on demand.
      name: 'preload-body-font',
      enforce: 'post' as const,
      transformIndexHtml(_html: string, ctx: { bundle?: Record<string, unknown> }) {
        if (!ctx.bundle) return;
        const file = Object.keys(ctx.bundle).find((f) =>
          /atkinson-hyperlegible-next-latin-wght-normal-[^/]*\.woff2$/.test(f)
        );
        if (!file) return;
        return [
          {
            tag: 'link',
            attrs: {
              rel: 'preload',
              href: `/${file}`,
              as: 'font',
              type: 'font/woff2',
              crossorigin: '',
            },
            injectTo: 'head' as const,
          },
        ];
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
              // All /comp* routes serve the shell, mirroring production where
              // _routes.json hands /comp* to the Pages Function (SSR with an
              // SPA-shell fallback). Covers every comp sub-route registered in
              // src/react/routes.tsx (waypoints, task, pilot, ...).
              path === '/comp' ||
              path.startsWith('/comp/') ||
              path === '/scores' ||
              /^\/(submit|profile|settings|onboarding|signin)\/?$/.test(path) ||
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
    // Overridable so two git worktrees can run side by side. Without it the
    // second one silently reuses the first's dev server and every e2e
    // assertion is made against the wrong code. Matches DEV_API_PORT, which
    // the API origin above already honours.
    port: Number(process.env.DEV_FRONTEND_PORT) || 3000,
    // Set TUNNEL=1 when exposing the dev server via `cloudflared tunnel`:
    //  - allowedHosts: let the random *.trycloudflare.com hostname through
    //    (leading dot matches the domain and all subdomains).
    //  - hmr.clientPort 443: the tunnel terminates TLS at :443, so the HMR
    //    websocket must target that, not the raw dev port, or live reload
    //    silently fails over the tunnel.
    // Gated so normal localhost HMR (which needs the real port) is unaffected.
    ...(process.env.TUNNEL ? {
      allowedHosts: ['.trycloudflare.com'] as string[],
      hmr: { clientPort: 443 },
    } : {}),
    fs: {
      allow: [
        searchForWorkspaceRoot(process.cwd()),
      ],
    },
    // One rule for the whole API surface: it all goes to the dev-router Worker,
    // which dispatches to auth-api / competition-api / airscore-api over
    // service bindings exactly as the Pages Functions in functions/api/ do in
    // production. There is no /api/* path this dev server serves itself, and
    // the per-prefix table this replaced was a second place to forget to update
    // (`/api/u/` — public track links — was once missing from it). See
    // web/scripts/dev-workers.sh for why there is only one target now.
    proxy: {
      '/api': { target: DEV_API_ORIGIN, changeOrigin: true },
      // /civl-rankings.csv is a Pages Function in production
      // (functions/civl-rankings.csv.ts), and Pages Functions don't run under
      // `bun run dev`. Rewriting to the worker path it forwards to keeps the
      // one public URL working in dev too, so verifying an import doesn't
      // require a `wrangler pages dev` build.
      '/civl-rankings.csv': {
        target: DEV_API_ORIGIN,
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\//, '/api/'),
      },
    },
  },
});
