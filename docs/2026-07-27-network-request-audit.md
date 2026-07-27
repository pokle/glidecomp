# Network request audit — 27 July 2026

Measured against a **production build** (`bun run build`) served through the real
Pages runtime (`wrangler pages dev web/frontend/dist`) bound to the local
Workers, with the bundled sample comps seeded. Vite's dev server is useless for
this — it serves unbundled ES modules, so a dev-mode waterfall is hundreds of
requests that do not exist in production.

Two instruments were used, because they answer different questions:

- **Browser resource timing** (`performance.getEntriesByType`) in a cold
  Playwright context, per page type — gives per-request bytes, initiator and
  timing.
- **The Pages server's own request log** — ground truth for *wire* requests.
  Chromium reports cache hits as "responses" to Playwright and reports
  `transferSize: 0` for several cache/preload states, so counting browser-side
  events overstates network traffic. Anything below labelled "wire requests" is
  counted from the server log.

Note `page.reload()` is not a valid warm-cache probe: Chromium revalidates
unconditionally on reload. Repeat-visit behaviour is measured here as a
multi-page *journey* in one context, which is also what a real visitor does.

---

## 1. What a cold load costs today

Per page type, first-ever visit, no warm cache. "reqs" is browser-observed
requests; KB is transferred (Brotli on the wire).

| Page type | Route | reqs | KB | of which JS | font files |
|---|---|---:|---:|---:|---:|
| Home (static Astro) | `/` | 10 | **2917** | 0 | 4 |
| About / Scoring index (static) | `/about`, `/scoring` | 8 | 65 | 0 | 4 |
| Scoring GAP (static, KaTeX) | `/scoring/gap` | 14 | 161 | 0 | 9 |
| Comp list (SSR) | `/comp` | 11 | 525 | 462 | 3 |
| Comp hub (SSR) | `/comp/:id` | 13 | 545 | 462 | 4 |
| Comp scores (SSR) | `/comp/:id/scores` | 12 | 548 | 462 | 4 |
| Comp waypoints (SSR) | `/comp/:id/waypoints` | 22 | **1312** | 1226 | 4 |
| Task detail (SSR) | `/comp/:id/task/:id` | 13 | 546 | 462 | 4 |
| Pilot score (SSR) | `…/pilot/:id` | 23 | **1401** | 1226 | 4 |
| Comp field analysis (SSR) | `/comp/:id/analysis` | 12 | 566 | 462 | 4 |
| Task field analysis (SSR) | `/comp/:id/analysis/task/:id` | 16 | 680 | 462 | 6 |
| Sign in (SPA) | `/signin` | 11 | 523 | 462 | 3 |
| Settings (SPA) | `/settings` | 12 | 535 | 462 | 4 |
| Analysis (vanilla TS) | `/analysis` | ~20 | ~330 | 144 | 4 |
| 3D replay | `/replay` | 11 | **3256** | 174 | 2 |

**The request *count* is not the problem.** 8–23 requests per page is
unremarkable. The problems are (a) repeat-visit revalidation traffic, (b) a
handful of duplicated calls, and (c) bytes.

---

## 2. Findings, in priority order

### F1 — Content-hashed assets are not marked immutable (biggest win, zero code) — **FIXED**

Production serves every `/assets/*` and `/_astro/*` file with:

```
cache-control: public, max-age=14400, must-revalidate
```

That is Cloudflare Pages' default. But these filenames *contain a content hash*
(`app-CHvJv1_e.js`) — they are immutable by construction and can never need
revalidation. `must-revalidate` additionally forbids serving stale while
revalidating.

`public/_headers` currently sets security headers only; it sets no cache rules.

**Measured.** A ten-page visitor journey (home → comp list → comp hub → scores →
task → pilot score → waypoints → field analysis → task analysis → back to comp
hub), one browser context, normal navigations:

| | wire requests | of which `304 Not Modified` |
|---|---:|---:|
| As shipped | **108** | **47** |
| With `max-age=31536000, immutable` on `/assets/*` + `/_astro/*` | **61** | **0** |

**−47 requests, −44%, from four lines in `public/_headers`.** Every one of the
47 was a round trip that returned no data.

```
/assets/*
  Cache-Control: public, max-age=31536000, immutable

/_astro/*
  Cache-Control: public, max-age=31536000, immutable
```

Safe because both directories contain only build-hashed filenames — a content
change produces a new URL. Do **not** extend this to `/screenshots/*`,
`/icon.svg`, `/manifest.webmanifest` or `/data/*`, which are unhashed; those
want a moderate `max-age` instead. (Screenshots are best handled alongside F4,
which changes those filenames anyway.)

**Landed** in `web/frontend/public/_headers`. Verified against a fresh
production build: all 130 files in `dist/assets` (48) and `dist/_astro` (82) are
content-hashed and are `.js`/`.css`/`.woff2`/`.woff`/`.ttf` only; the unhashed
paths and the HTML pages keep the default; and the `/*` security headers still
merge onto `/assets/*` (Pages applies every matching rule). Re-measured journey:
61 wire requests, zero 304s.

### F2 — `/api/auth/me` is fetched twice on every page load

After F1, this is **18 of the 61 remaining wire requests (30%)** in that journey
— two per page, on every page, including fully public ones.

There are two independent callers:

- `src/react/lib/user.tsx:76` — `UserProvider`, which *does* dedupe correctly
  via a module-level `mePromise`.
- `src/auth/preferences-sync.ts:298` — an auto-bootstrap that runs on import and
  calls `getCurrentUser()` **directly**, bypassing that dedupe. It is pulled in
  transitively via `src/analysis/config.ts`, which every React page imports —
  which is why an anonymous visitor to `/comp` pays two auth round trips before
  seeing anything.

Two fixes, worth doing both:

- **Hoist the dedupe into `src/auth/client.ts`** (`getCurrentUserOnce()`) and
  have both callers use it. One-line-ish; 18 → 9 requests. The comment at
  `user.tsx:69` already explains why a single flight matters (concurrent calls
  can race to `user: null` under load) — the second caller silently defeats it.
- **Embed the user in `window.__SSR_DATA__`.** `functions/comp/[[path]].ts`
  already forwards the visitor's cookie to the API and already serialises
  `__SSR_DATA__`. Adding the current user there takes the six SSR'd public pages
  to **zero** auth round trips. This does not harm edge caching: an anonymous
  visitor sends no cookie, so `pageCacheControl()` still returns the public
  value and the embedded user is simply `null`.

### F3 — Four to six separate font files on every page

Every page fetches 4 woff2 files (~50 KB); the task field-analysis page fetches
6 (~75 KB). They are CSS-discovered, so they start late — on the comp hub the
first font request begins at t+2140 ms, after the CSS has parsed. There is no
`<link rel=preload>`.

`src/react/globals.css` also `@import`s weights 400/500/600/700 **twice** (lines
19–22, then again at 28–32). CSS `@import` dedupes so this costs nothing at
runtime, but the two blocks have diverging comments and one of them should go.

`@fontsource-variable/atkinson-hyperlegible-next@5.3.0` exists on npm. Switching
to it collapses 4–5 requests into 1 and, with a single `preload` hint in
`app.html` and the Astro `Base` layout, removes the late-discovery stall.

### F4 — The home page ships 2.85 MB of PNG (97% of the page)

`static/public/screenshots/pilot-explain.png` is **2400×1600, 2.44 MB**, marked
`fetchpriority="high"` in `static/src/pages/index.astro:47`. It is the LCP
element of the site's primary SEO page. Two more screenshots (223 KB, 183 KB)
are fetched eagerly with no `loading="lazy"` despite being below the fold.

- Encode to AVIF with WebP fallback, at 2× the CSS display width rather than
  2400px. Expect ~150–250 KB for all three — roughly a **10× reduction** on the
  page that matters most for acquisition.
- Add `loading="lazy"` + `decoding="async"` to the two below-the-fold shots.
- Keep `fetchpriority="high"` on the hero only.
- Give `/screenshots/*` a real `max-age` in `_headers` (they are unhashed, so
  something like a day, not a year).

### F5 — Unauthenticated `/u/me` does a full page reload to reach `/signin`

`goToSignIn()` in `src/react/lib/user.tsx` calls `window.location.assign()`.
`/signin` is a route in the *same* SPA, so this discards the loaded application
and re-boots it from scratch. Server log for one anonymous `/u/me` load:

```
GET /u/me → … → GET /signin → 4 × GET /api/auth/me
```

A react-router `navigate()` makes the transition free and drops the auth calls
to (post-F2) one. The `window.location.reload()` in the preview-role branch
above it is legitimate and should stay.

### F6 — Mapbox costs 764 KB on two public pages

`/comp/:id/waypoints` (1312 KB) and `…/pilot/:id` (1401 KB) against a ~545 KB
SPA baseline. `mapbox-gl` (508 KB br) plus `mapbox-provider` (250 KB br) are
correctly `lazy()`-imported — `CompWaypoints.tsx:57`, `PilotScoreDetail.tsx:67`
— but they load unconditionally as soon as the component mounts.

Gate the dynamic import on an `IntersectionObserver` (or an explicit "show map"
control) so the majority of readers who never scroll to the map never pay for
it. The route map is already a `<Suspense>` boundary, so the change is local.

### F7 — `app.js` is 1.4 MB raw / 429 KB Brotli and is not route-split

`src/react/routes.tsx` statically imports all twenty page components, and the
whole SPA contains only two `lazy()` calls (both map components, F6). So an
anonymous visitor to `/comp` downloads Settings, Dashboard, AdminUsers,
AdminCache, Onboarding and CompPilotsPage (80 KB of source between them) plus
the entire field-analysis report UI (400 KB of source) in order to render a list
of competitions.

Route-level `lazy()` on the auth-only and admin routes is the standard fix.

**Constraint worth stating explicitly:** the six SSR'd public routes must stay
eagerly imported, or the server and client trees diverge and hydration breaks.
Split the *non*-SSR routes — `/settings`, `/u/:username`, `/admin/*`,
`/onboarding`, `/signin`, `/comp/:id/pilots`. Those are exactly the ones no
anonymous visitor needs.

Tabulator (450 KB) and the date picker (134 KB) are *already* separate chunks —
that part is working.

### F8 — `/replay` fetches a 3.0 MB JSON payload with `max-age=300`

`/api/comp/sample-3dvis` is a fixed sample dataset served with a five-minute
TTL, so a returning viewer re-downloads 3 MB. Since the payload is derived from
a specific task, a longer TTL (or a URL keyed by the task id, which is then
effectively immutable) makes repeat views free.

### F9 — Minor: bare comp ids 301-redirect

`/comp/dwnx` → `/comp/corryong-cup-2026-dwnx` costs an extra round trip. This is
correct canonicalisation and all internal links already emit the slug form; it
only affects hand-typed or legacy URLs. No action, noted so the extra hop isn't
mistaken for a bug when it appears in a trace.

---

## 3. Recommended order

| # | Change | Effort | Effect |
|---|---|---|---|
| 1 | ~~`_headers`: `immutable` on `/assets/*`, `/_astro/*`~~ **done** | trivial | **−44% requests** on a repeat-visit journey (measured) |
| 2 | Dedupe `/api/auth/me`; embed user in `__SSR_DATA__` | small | −9 to −18 requests per journey; removes a boot round trip from every public page |
| 3 | AVIF/WebP + `srcset` + lazy on home screenshots | small | **−2.6 MB** on the primary SEO page |
| 4 | Variable font + one `preload` | small | −3 to −5 requests/page, earlier text paint |
| 5 | `navigate()` instead of `location.assign()` in `goToSignIn` | trivial | removes a full SPA re-boot from the signed-out path |
| 6 | Route-`lazy()` the non-SSR routes | medium | cuts the 429 KB entry bundle for anonymous visitors |
| 7 | Defer Mapbox until the map is in view | medium | −764 KB on two public pages |
| 8 | Longer TTL for `/api/comp/*/3dvis` | small | −3 MB on repeat replay views |

Items 1–5 are low-risk and independently shippable. Items 6–7 touch the SSR
hydration boundary and the map lifecycle, so each wants its own PR and an
`bun run test:e2e:ssr` pass.

## 4. Reproducing

```bash
bun run build
bunx wrangler pages dev web/frontend/dist --port 3100 \
  --compatibility-date=2025-03-10 --compatibility-flags=nodejs_compat \
  --service COMPETITION_API=competition-api --service AUTH_API=auth-api
```

with `bun run dev:workers` and `bun run seed` already up. Count wire requests
from the `wrangler pages dev` log rather than from browser events, and use
distinct navigations rather than `reload()` to exercise the cache.
