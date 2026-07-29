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

### F2 — `/api/auth/me` is fetched twice on every page load — **FIXED**

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

**Landed**, both parts, plus the analysis page's two further independent
resolvers (`analysis/main.ts` and the storage layer's own `init()`), which made
that page ask three times. The shared flight now lives in `auth/client.ts` and
is seeded at module load from `__SSR_DATA__`, so it is answered before the
preferences-sync bootstrap — which runs during import — can race ahead of the
entry point.

Three encoding/ordering details are load-bearing:

- **Absent `user` ≠ `"user":null`.** `undefined` (a classic SPA boot, or an
  auth-worker blip) means *unknown, go and ask*; `null` means a known
  signed-out visitor. `JSON.stringify` drops the key for `undefined`, which is
  exactly the wire format wanted. Collapsing the two would render signed-in
  visitors as signed out whenever the auth call failed.
- **The seed lives in `auth/client.ts` at module scope, not in the entry.**
  `preferences-sync` bootstraps on import, so an entry-point seed would
  sometimes lose the race. Window-guarded so it stays inert in workerd.
- **`user` is deliberately not read by `InitialDataProvider`**, which retires
  its value on the first client-side navigation. Who you are outlives the page
  you landed on.

Measured: the ten-page journey drops from 61 wire requests to **43**, with
**zero** `/api/auth/me`. Verified separately that a signed-in visitor gets
their identity server-rendered (no signed-out flash), `private, no-store`, no
auth round trip and no hydration error; that an anonymous visitor keeps a
public, cacheable page carrying `"user":null`; and that the non-SSR routes
(`/settings`, `/signin`) correctly still make exactly one call. Full
`test:e2e:ssr` (27 tests incl. 8 hydration checks), `test:e2e` (24) and
`bun run test` (1121) pass.

### F3 — Four to six separate font files on every page — **FIXED**

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


**Landed.** One variable file (`@fontsource-variable`) spans the whole 200–800
axis, declared in a shared `src/fonts.css` that both `react/globals.css` (which
Astro and the analysis page also reuse) and `replay.css` import.

The `@font-face` rules are hand-written rather than an `@import` of the
package's CSS so the family keeps its **existing name**. @fontsource-variable
publishes as "Atkinson Hyperlegible Next Variable", and the name is referenced
from places a rename breaks *silently*: the 3D replay's canvas labels, the two
`document.fonts.load()` calls, the Mapbox label font and the analysis HUD. A
mistyped family in a canvas context does not throw — it just renders in a
fallback face.

Also preloaded, since a CSS-declared font is only discovered once the
stylesheet has parsed. Astro gets it via a `?url` import; the SPA shell needs a
small Vite plugin, because the filename is content-hashed and therefore only
knowable from the finished bundle. Only the upright latin file is preloaded —
preloading italic and latin-ext would fetch faces most pages never use.

Measured: 4–6 font requests per page → **1** (2 on a page that uses italics).

### F4 — The home page ships 2.85 MB of PNG (97% of the page) — **FIXED**

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


**Landed.** The screenshots moved from `static/public/` into
`static/src/assets/` so Astro's image pipeline can transcode them, and the page
now uses `<Picture>` — AVIF with a WebP fallback and a srcset per display
width. Still prerendered: `<picture>` needs no JavaScript.

Two traps worth recording. Astro **upscales** if a requested width exceeds the
source, and a re-encoded upscale is bigger than the original — a 1712px chart
asked for at 2048 came out larger than the file it came from, so the widths are
clamped per image against its own intrinsic width. And the default PNG fallback
variants were the biggest files in the whole build (2.7 MB for one hero
variant); `fallbackFormat="webp"` drops them.

Measured, the whole page: **2917 KB → 151 KB, 10 requests → 7.** The hero alone
is 2440 KB → 48 KB.

### F5 — Unauthenticated `/u/me` does a full page reload to reach `/signin` — **FIXED**

`goToSignIn()` in `src/react/lib/user.tsx` calls `window.location.assign()`.
`/signin` is a route in the *same* SPA, so this discards the loaded application
and re-boots it from scratch. Server log for one anonymous `/u/me` load:

```
GET /u/me → … → GET /signin → 4 × GET /api/auth/me
```

A react-router `navigate()` makes the transition free and drops the auth calls
to (post-F2) one. The `window.location.reload()` in the preview-role branch
above it is legitimate and should stay.


**Landed** as a `useGoToSignIn()` hook (the callers are all components under
the router). The preview-role branch keeps its `window.location.reload()` — the
role is read from sessionStorage at boot.

Safe in this direction **only**. The reverse hop, SignIn → `next` after a
successful sign-in, must stay a full page load: the current user is resolved
once per page load, so a client-side navigation would carry the stale
signed-out answer into the signed-in page. That asymmetry is now commented at
both ends.

### F6 — Mapbox costs 764 KB on two public pages — **PARTLY FIXED**

`/comp/:id/waypoints` (1312 KB) and `…/pilot/:id` (1401 KB) against a ~545 KB
SPA baseline. `mapbox-gl` (508 KB br) plus `mapbox-provider` (250 KB br) are
correctly `lazy()`-imported — `CompWaypoints.tsx:57`, `PilotScoreDetail.tsx:67`
— but they load unconditionally as soon as the component mounts.

Gate the dynamic import on an `IntersectionObserver` (or an explicit "show map"
control) so the majority of readers who never scroll to the map never pay for
it. The route map is already a `<Suspense>` boundary, so the change is local.


**Partly landed, and the audit over-promised here.** The maps are now gated
behind an IntersectionObserver (`lib/use-in-view.ts`, latching and SSR-safe).

But the predicted "−764 KB on two public pages" **does not materialise**, and
measurement says so plainly: mapbox loads at both a 1280px and a 390px
viewport, on both pages. The audit assumed the maps were below the fold. They
are not — the pilot page's map is a full-height side panel, and the waypoints
map is `order-1` on mobile, i.e. the *first* thing on the page. A gate cannot
skip what the visitor is looking at.

What it does deliver is real but smaller: the map can no longer contend with
first paint, because an observer can only fire after layout. On the pilot page
FCP is 212 ms and mapbox now starts at 325 ms — after the content, where
before it was requested as soon as the component mounted.

Getting the bytes back needs a **product** decision, not a technical one:
require an explicit tap to open the map on small screens. That trades a
core feature's immediacy for ~764 KB and is the owner's call, so it is left
open here.

### F7 — `app.js` is 1.4 MB raw / 429 KB Brotli and is not route-split — **FIXED**

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


**Landed** for the eight non-SSR routes — dashboard, settings, onboarding,
sign-in, the two admin screens, the Tabulator-backed pilots roster and
`/scores`. The eight server-rendered routes stay static imports, with a comment
saying why: a lazy boundary the server resolved but the client hasn't fetched
is what makes hydration discard the SSR markup.

Entry bundle **1399 KB → 1146 KB raw, 439 KB → 358 KB gzip**.

### F8 — `/replay` fetches a 3.0 MB JSON payload with `max-age=300` — **FIXED**

`/api/comp/sample-3dvis` is a fixed sample dataset served with a five-minute
TTL, so a returning viewer re-downloads 3 MB. Since the payload is derived from
a specific task, a longer TTL (or a URL keyed by the task id, which is then
effectively immutable) makes repeat views free.


**Landed**, but as an **ETag rather than a longer TTL**. The audit's suggestion
was wrong on inspection: the URL is stable while the content is not — upload a
track and the same URL must answer differently — so a long max-age would serve
a stale replay through a live comp. The bundle is already content-addressed by
a cache key, which makes a perfect ETag: a repeat view revalidates and gets a
~200-byte 304 instead of 3 MB, with freshness unchanged. A matching
If-None-Match also skips the multi-megabyte KV read entirely.

### F9 — Minor: bare comp ids 301-redirect

`/comp/dwnx` → `/comp/corryong-cup-2026-dwnx` costs an extra round trip. This is
correct canonicalisation and all internal links already emit the slug form; it
only affects hand-typed or legacy URLs. No action, noted so the extra hop isn't
mistaken for a bug when it appears in a trace.

---

## 3. Recommended order

| # | Change | Status | Measured effect |
|---|---|---|---|
| 1 | `_headers`: `immutable` on `/assets/*`, `/_astro/*` | done | −47 requests on the journey; all 47 were 304s returning no data |
| 2 | Dedupe `/api/auth/me`; embed user in `__SSR_DATA__` | done | 61 → 43 requests; zero auth round trips on public pages |
| 3 | AVIF/WebP + `srcset` on the home screenshots | done | home page **2917 KB → 151 KB**, 10 requests → 7 |
| 4 | Variable font + preload | done | 4–6 font requests per page → 1 |
| 5 | `navigate()` instead of `location.assign()` | done | removes a full SPA re-boot from the signed-out path |
| 6 | Route-`lazy()` the non-SSR routes | done | entry bundle 439 → 358 KB gzip |
| 7 | Defer Mapbox until in view | partial | off the critical path (FCP 212 ms, map starts 325 ms) — but **not** the predicted −764 KB; see F6 |
| 8 | ETag on the 3dvis bundle | done | repeat replay views revalidate for ~200 bytes instead of 3 MB |

Cumulative on the ten-page journey: **108 → 38 wire requests**, and the home
page — the one that decides whether a visitor tries GlideComp — went from
2.9 MB to 151 KB.

The one thing left open is F6's remaining bytes, which needs a product
decision rather than a technical one.

Every item above shipped with `bun run test:e2e:ssr` passing (30 tests,
including 10 hydration checks) — route-splitting and the SSR tree are the two
places where a regression would be silent rather than loud.

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
