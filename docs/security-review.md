# GlideComp Security Review

> **Purpose:** living memory for the periodic whole-repo security review
> (`/security-review-repo`). This index is the single source of truth for the
> **current status** of every finding and every standing scope gap. The full
> write-up of each round is archived, verbatim and never rewritten, under
> [security-review/rounds/](security-review/rounds/).

## How this log works

- **A new round adds a file** — `security-review/rounds/<YYYY-MM-DD>.md` —
  containing its methodology, executive summary, new findings (numbered on
  from the register's highest `SEC-NN`), the status **changes** it made, and a
  "re-checked and clean" list. Rounds do not restate the full register.
- **The same round then updates this index**: one new Review Log line, the
  register rows whose status moved, the scope-gap list (stable `G-NN` ids —
  strike a closed gap with the closing round, never renumber or reuse), and
  the "Where to start the next review" section, replaced wholesale.
- **History is immutable.** Earlier rounds are what the reviewer believed at
  the time; corrections happen in a new round and in the register, not by
  editing an archived file.
- Prior to 2026-08-17 the whole log was one file, with each round carrying a
  full status table; the per-round tables in the archived files are snapshots
  of that era, superseded by the register below.

## Review Log

| Date | Round | Headline |
|------|-------|----------|
| 2026-04-20 | [round](security-review/rounds/2026-04-20.md) | Initial full-repo review; SEC-01..09; SEC-01 (reflective CORS w/ credentials) fixed inline |
| 2026-05-04 | [round](security-review/rounds/2026-05-04.md) | SEC-10..14; SEC-10 (internal-header auth bypass) + SEC-11/12/14 fixed inline |
| 2026-05-11 | [round](security-review/rounds/2026-05-11.md) | SEC-15 (public-roster PII) fixed inline |
| 2026-05-18 | [round](security-review/rounds/2026-05-18.md) | User-files + preferences surface; SEC-16 (kysely advisory) fixed inline |
| 2026-05-25 | [round](security-review/rounds/2026-05-25.md) | SEC-17 (qs/ws advisories) fixed inline; SEC-02 (`_headers`) closed |
| 2026-06-01 | [round](security-review/rounds/2026-06-01.md) | SEC-13 (share-target filenames) fixed inline; SEC-03 reclassified Accepted |
| 2026-06-08 | [round](security-review/rounds/2026-06-08.md) | Deps-only window; SEC-04 (IGC shape check) fixed inline |
| 2026-06-11 | [round](security-review/rounds/2026-06-11.md) | SEC-18 (shell-quote) + SEC-08 (rate-limit headers) fixed inline |
| 2026-06-12 | [round](security-review/rounds/2026-06-12.md) | SEC-06 (JSON body-size cap) fixed inline |
| 2026-06-20 | [round](security-review/rounds/2026-06-20.md) | SEC-19 (dirty `bun audit`, 11 advisories) fixed inline |
| 2026-06-21 | [round](security-review/rounds/2026-06-21.md) | Parser fuzzing; SEC-20 (`parseXCTask` TypeError) fixed inline |
| 2026-06-21 (II) | [round](security-review/rounds/2026-06-21-ii.md) | Deflate/polyline fuzzing; SEC-21 fixed inline |
| 2026-06-28 | [round](security-review/rounds/2026-06-28.md) | GAP rewrites + track packer window; no new findings |
| 2026-07-03 | [round](security-review/rounds/2026-07-03.md) | v1 launch window; SEC-22..27; SEC-22 (stored XSS) + 23/24/25 fixed inline |
| 2026-07-05 | [round](security-review/rounds/2026-07-05.md) | Scoring fallbacks + replay window; no new findings |
| 2026-07-06 | [round](security-review/rounds/2026-07-06.md) | React/Base-UI migration deep-dive; SEC-28 (CSV formula injection) documented |
| 2026-07-12 | [round](security-review/rounds/2026-07-12.md) | SSR pages + new mutating endpoints; SEC-29 documented |
| 2026-07-19 | [round](security-review/rounds/2026-07-19.md) | Email-OTP + task analysis; SEC-30 (open redirect) fixed inline; SEC-31 documented |
| 2026-07-26 | [round](security-review/rounds/2026-07-26.md) | Weather + track quality; SEC-32/33 (engine DoS) + SEC-34 documented, SEC-34 part-fixed |
| 2026-07-28 | [round](security-review/rounds/2026-07-28.md) | SSR identity + dev-router; SEC-35 (3dvis cache) fixed inline |
| 2026-07-29 | [round](security-review/rounds/2026-07-29.md) | CIVL rankings + report card; SEC-36 fixed inline; SEC-28 finally fixed |
| 2026-08-05 | [round](security-review/rounds/2026-08-05.md) | Anonymous submission + site search; SEC-37..40 documented; audit 16→10 |
| 2026-08-12 | [round](security-review/rounds/2026-08-12.md) | S7F 2026 + PathFinder; SEC-41 (stored XSS ×8) + 42/43/44 fixed inline; SEC-45/46 documented |
| 2026-08-17 | [round](security-review/rounds/2026-08-17.md) | SEC-47 (stored XSS) fixed inline; SEC-46 fixed with oracle tests; sink-pin guard test added |
| 2026-08-20 | [round](security-review/rounds/2026-08-20.md) | Mobile settings hierarchy + Wing audit rewrite + mobile e2e; no new findings |
| 2026-09-02 | [round](security-review/rounds/2026-09-02.md) | Comp/task-analysis rename + anonymous report-card deep link; SEC-48 (dependency-audit regression) fixed inline; SEC-49 documented |
| 2026-09-09 | [round](security-review/rounds/2026-09-09.md) | Day-difficulty metrics + comp-wide section nav; SEC-50 (dependency-audit regression, 1 critical) + SEC-49 fixed inline |
| 2026-09-16 | [round](security-review/rounds/2026-09-16.md) | Routine dependency-upgrade window only; SEC-50 confirmed held; no new findings |
| 2026-09-23 | [round](security-review/rounds/2026-09-23.md) | Astro 6→7 closes SEC-34/G-16 (`bun audit` now clean); SEC-51 (public waypoint-CSV formula injection) fixed inline |
| 2026-09-30 | [round](security-review/rounds/2026-09-30.md) | `bun audit` regressed to 18 (4 high) — SEC-52 fixed inline (third G-20 recurrence); JWKS session-cookie cache reviewed clean; SEC-53 (Low) + SEC-54 (Info) documented |
| 2026-10-01 | [round](security-review/rounds/2026-10-01.md) | Architecture review. SEC-56 (High: distributed email-OTP brute force) + SEC-55 (default-deny Better Auth surface) fixed inline; SEC-57–62 documented with a proposal table (A1–A12) |

## Findings register

Single source of truth for current status. Severity, evidence, and
remediation detail live in the introducing round; status movements in the
rounds linked here.

| ID | Title | Status @ 2026-10-01 | Introduced | Resolved / last movement |
|----|-------|---------------------|------------|--------------------------|
| SEC-01 | Reflective CORS w/ credentials | Fixed | [2026-04-20](security-review/rounds/2026-04-20.md) | Fixed same round; allowlist now in `web/workers/shared/src/cors.ts` |
| SEC-02 | No security response headers (`_headers`) | Fixed | [2026-04-20](security-review/rounds/2026-04-20.md) | [2026-05-25](security-review/rounds/2026-05-25.md) |
| SEC-03 | Admin emails returned on public comp detail | Accepted (by design) | [2026-04-20](security-review/rounds/2026-04-20.md) | [2026-06-01](security-review/rounds/2026-06-01.md) — do not re-open |
| SEC-04 | IGC upload size/shape — manufacturer-record check | Fixed | [2026-04-20](security-review/rounds/2026-04-20.md) | [2026-06-08](security-review/rounds/2026-06-08.md) |
| SEC-05 | `innerHTML` is the default render primitive | Open — guarded | [2026-04-20](security-review/rounds/2026-04-20.md) | [2026-08-17](security-review/rounds/2026-08-17.md) — `html-sinks.test.ts` pins every sink site |
| SEC-06 | No JSON body-size cap | Fixed | [2026-04-20](security-review/rounds/2026-04-20.md) | [2026-06-12](security-review/rounds/2026-06-12.md) |
| SEC-07 | Dev-only endpoints gated by `BETTER_AUTH_URL` hostname | Verified safe (load-bearing) | [2026-04-20](security-review/rounds/2026-04-20.md) | Re-verify on every deploy |
| SEC-08 | Rate-limit headers not surfaced | Fixed | [2026-04-20](security-review/rounds/2026-04-20.md) | [2026-06-11](security-review/rounds/2026-06-11.md) |
| SEC-09 | `Math.random()` non-security use | Closed (Info) | [2026-04-20](security-review/rounds/2026-04-20.md) | — |
| SEC-10 | Auth bypass via trusted `X-Glidecomp-Internal-User` header | Fixed | [2026-05-04](security-review/rounds/2026-05-04.md) | Fixed same round; `auth-bypass.test.ts` is the tripwire |
| SEC-11 | IGC gzip-bomb decompression | Fixed | [2026-05-04](security-review/rounds/2026-05-04.md) | Fixed same round |
| SEC-12 | `xctsk` body shape/depth/size cap | Fixed | [2026-05-04](security-review/rounds/2026-05-04.md) | Fixed same round; `MAX_XCTSK_TURNPOINTS = 50` also bounds SEC-45's turnpoint axis |
| SEC-13 | Service worker unsanitised share-target filenames | Fixed | [2026-05-04](security-review/rounds/2026-05-04.md) | [2026-06-01](security-review/rounds/2026-06-01.md) |
| SEC-14 | Service-binding trust comment misleads readers | Closed / moot | [2026-05-04](security-review/rounds/2026-05-04.md) | Fixed same round |
| SEC-15 | Unauthenticated PII on public pilot list | Fixed | [2026-05-11](security-review/rounds/2026-05-11.md) | Fixed same round; rule commented in `serializeCompPilotPublic` |
| SEC-16 | Transitive `kysely` JSON-path traversal | Fixed | [2026-05-18](security-review/rounds/2026-05-18.md) | Fixed same round |
| SEC-17 | `qs` (DoS) / `ws` (memory disclosure) | Fixed | [2026-05-25](security-review/rounds/2026-05-25.md) | Fixed same round |
| SEC-18 | Transitive `shell-quote` newline-escaping bypass | Fixed | [2026-06-11](security-review/rounds/2026-06-11.md) | Fixed same round |
| SEC-19 | Dirty `bun audit` — transitive advisories | Superseded by SEC-34 | [2026-06-20](security-review/rounds/2026-06-20.md) | [2026-07-26](security-review/rounds/2026-07-26.md) |
| SEC-20 | `parseXCTask` `TypeError` on untrusted input | Fixed | [2026-06-21](security-review/rounds/2026-06-21.md) | Fixed same round |
| SEC-21 | `parseXCTaskAsync` deflate-path `TypeError` | Fixed | [2026-06-21 (II)](security-review/rounds/2026-06-21-ii.md) | Fixed same round |
| SEC-22 | Stored XSS via unescaped pilot name in score tables + map HUD | Fixed | [2026-07-03](security-review/rounds/2026-07-03.md) | Fixed same round; server-side input validation added 2026-08-21 (issue #232) as defence-in-depth |
| SEC-23 | Replay gaggle tooltip renders turnpoint name into `innerHTML` | Fixed | [2026-07-03](security-review/rounds/2026-07-03.md) | Fixed same round |
| SEC-24 | Super-admin users page interpolates username into `href` | Fixed | [2026-07-03](security-review/rounds/2026-07-03.md) | Fixed same round |
| SEC-25 | `comp-detail.ts` quote-unsafe `escapeHtml` | Closed / moot | [2026-07-03](security-review/rounds/2026-07-03.md) | [2026-07-06](security-review/rounds/2026-07-06.md) — file deleted |
| SEC-26 | 3D-replay packer + task-analysis read path decompress without SEC-11 cap | Open (deferred) | [2026-07-03](security-review/rounds/2026-07-03.md) | Gap G-08 |
| SEC-27 | Super-admin allowlist matches on email alone | Open (Info) | [2026-07-03](security-review/rounds/2026-07-03.md) | [2026-10-01](security-review/rounds/2026-10-01.md) — its email-OTP path was SEC-56's sharpest case; architecture A3 (user-id allowlist, Google/passkey only) |
| SEC-28 | Pilots CSV export writes spreadsheet formula triggers verbatim | Fixed | [2026-07-06](security-review/rounds/2026-07-06.md) | [2026-07-29](security-review/rounds/2026-07-29.md) — shared `csvEscape()` |
| SEC-29 | Quadratic-time GPX/KML client waypoint parsers | Open (deferred) | [2026-07-12](security-review/rounds/2026-07-12.md) | Gap G-12 |
| SEC-30 | Open redirect via backslash-folded `next` in sign-in | Fixed | [2026-07-19](security-review/rounds/2026-07-19.md) | Fixed same round (`safe-next.ts`) |
| SEC-31 | Task-analysis field cap by track count, not bytes | Open (deferred) | [2026-07-19](security-review/rounds/2026-07-19.md) | Gap G-13 |
| SEC-32 | Quadratic-time altitude cleaning on crafted IGC timestamps | Fixed | [2026-07-26](security-review/rounds/2026-07-26.md) | Fixed 2026-08-03 (`SlidingMedian`), verified [2026-08-05](security-review/rounds/2026-08-05.md) |
| SEC-33 | Quadratic-time track-quality glide window | Fixed | [2026-07-26](security-review/rounds/2026-07-26.md) | Fixed 2026-08-03 (monotone deque), verified [2026-08-05](security-review/rounds/2026-08-05.md) |
| SEC-34 | Dirty `bun audit` — dev/build-time advisories | Fixed | [2026-07-26](security-review/rounds/2026-07-26.md) | [2026-09-23](security-review/rounds/2026-09-23.md) — astro 6→7/vite 7→8 (commit `4b48aba`) closed the residual; `bun audit` now reads 0 vulnerabilities; gap G-16 closed |
| SEC-35 | 3D-replay bundle served `Cache-Control: public` to signed-in viewers | Fixed | [2026-07-28](security-review/rounds/2026-07-28.md) | Fixed same round + regression test |
| SEC-36 | CSV formula injection in `civl-rankings.csv` route | Fixed | [2026-07-29](security-review/rounds/2026-07-29.md) | Fixed same round |
| SEC-37 | `registration.ts` missing `test`-comp visibility gate | Fixed | [2026-08-05](security-review/rounds/2026-08-05.md) | Fixed in-window commit `64821cb`, verified [2026-08-12](security-review/rounds/2026-08-12.md) |
| SEC-38 | Signed-in IGC-upload + manual-flight + pilot-status routes missing `test`-comp gate | Fixed | [2026-08-05](security-review/rounds/2026-08-05.md) | Fixed in-window commit `64821cb`, verified [2026-08-12](security-review/rounds/2026-08-12.md) |
| SEC-39 | Anonymous-submission rate-limit budgets chargeable before any legitimacy check | Fixed | [2026-08-05](security-review/rounds/2026-08-05.md) | Fixed 2026-08-06 (peek/charge split), verified [2026-08-12](security-review/rounds/2026-08-12.md) |
| SEC-40 | Unbounded O(k²) clustering in `thermal-shape.ts` | Open (deferred) | [2026-08-05](security-review/rounds/2026-08-05.md) | Gap G-11 |
| SEC-41 | Unescaped waypoint/event names reach `innerHTML` at 8 analysis-page sites | Fixed | [2026-08-12](security-review/rounds/2026-08-12.md) | Fixed same round |
| SEC-42 | Unvalidated external URL in official-results `href` | Fixed | [2026-08-12](security-review/rounds/2026-08-12.md) | Fixed same round (`safeExternalUrl()`) + regression test |
| SEC-43 | Route-editor CSV export missing formula-injection guard | Fixed | [2026-08-12](security-review/rounds/2026-08-12.md) | Fixed same round — shared `csvEscape()` |
| SEC-44 | `PATCH /pilot/:id` omits 3 fields from the audit log | Fixed | [2026-08-12](security-review/rounds/2026-08-12.md) | Fixed same round + regression test |
| SEC-45 | O(fixes)×O(turnpoints²) PathFinder route-optimiser search, reachable via anonymous upload | **Open (deferred) — top open item** | [2026-08-12](security-review/rounds/2026-08-12.md) | Gap G-10 — needs its own oracle-tested PR (rolls the engine generation) |
| SEC-46 | Same-timestamp O(n²) scan in `circle-detector.ts` | Fixed | [2026-08-12](security-review/rounds/2026-08-12.md) | [2026-08-17](security-review/rounds/2026-08-17.md) — persistent pointer + budgeted fallback, oracle tests |
| SEC-47 | `setFlightInfo` renders the pilot name into `innerHTML` unescaped | Fixed | [2026-08-17](security-review/rounds/2026-08-17.md) | Fixed same round |
| SEC-48 | `bun audit` regression: qs/fast-uri/browserslist via unused `shadcn` devDependency, undercounted by a stale `fast-uri` override | Fixed | [2026-09-02](security-review/rounds/2026-09-02.md) | Fixed same round — overrides added/bumped, `bun audit` back to the SEC-34 residual |
| SEC-49 | Account display-name write (`/api/auth/set-name`, `/api/auth/set-username`) skips the SEC-22 defence-in-depth text checks applied everywhere else | Fixed (incomplete until SEC-55) | [2026-09-02](security-review/rounds/2026-09-02.md) | [2026-09-09](security-review/rounds/2026-09-09.md) — both routes; [2026-10-01](security-review/rounds/2026-10-01.md) — Better Auth's own `/update-user` and OTP sign-up `name` still wrote the column, closed by SEC-55; Google-profile name remains (G-27) |
| SEC-50 | `bun audit` regression: hono/js-yaml/sharp/svgo/smol-toml advisories (13 vulnerabilities, 1 critical) via newly-disclosed CVEs against already-locked, range-satisfying versions | Fixed | [2026-09-09](security-review/rounds/2026-09-09.md) | Fixed same round — five overrides bumped/added, `bun audit` back to the SEC-34 residual (now 5, incl. a Critical) |
| SEC-51 | Public waypoint-CSV export (`GET /api/comp/:comp_id/waypoints/csv` + per-task equivalent, both unauthenticated) missing the shared CSV/DDE formula-injection guard | Fixed | [2026-09-23](security-review/rounds/2026-09-23.md) | Fixed same round — `csvFieldGuarded()` in `web/engine/src/waypoint-export.ts`, scoped to the one format actually served as `text/csv`; regression test added |
| SEC-52 | `bun audit` regression: undici/fast-uri/ip-address/brace-expansion (18 advisories, 4 high) via locked, range-satisfying dev/build-time versions | Fixed | [2026-09-30](security-review/rounds/2026-09-30.md) | Fixed same round — four overrides raised/added, `bun audit` clean again |
| SEC-53 | `functions/api/csp-report.ts` enforces its 64 KB cap on `Content-Length` (0 when absent) before buffering the body, so a chunked upload is read in full | Open (Low) | [2026-09-30](security-review/rounds/2026-09-30.md) | Gap G-22 |
| SEC-54 | Revoked/signed-out-elsewhere session keeps working at competition-api + SSR for up to 5 min (session-cookie cache) | Accepted (by design, Info) | [2026-09-30](security-review/rounds/2026-09-30.md) | Documented in `auth.ts`; account deletion reads D1 |
| SEC-55 | Better Auth catch-all served the library's whole endpoint surface (`/update-user` around SEC-49, Google-token endpoints, a second OTP oracle, sign-up `name`/`image`) | Fixed | [2026-10-01](security-review/rounds/2026-10-01.md) | Fixed same round — allowlist in `auth-api/src/endpoints.ts` + `test/endpoints.test.ts`; residual G-27 |
| SEC-56 | Email-OTP sign-in brute-forceable by a distributed guesser: the per-address throttle withheld the email but not the freshly minted code, and nothing counted wrong codes per account | Fixed | [2026-10-01](security-review/rounds/2026-10-01.md) | Fixed same round — per-address send peek + wrong-code budget ahead of Better Auth (`auth-api/src/index.ts`), 7 regression tests; residual ~10 guesses/hour (A8) |
| SEC-57 | An API key is its whole account: no scopes, no expiry, can mint keys and delete the account | Open (Medium) | [2026-10-01](security-review/rounds/2026-10-01.md) | Architecture A3 — refusing key sessions on key management and deletion changes documented behaviour (owner's call) |
| SEC-58 | Every Pages deployment (previews and every historical build) binds production, is a trusted origin for production auth/CORS (+ `oAuthProxy`), and never expires | Open (Medium) | [2026-10-01](security-review/rounds/2026-10-01.md) | Architecture A1 (`docs/preview-environment-plan.md` + Access + pruning); live check G-24 |
| SEC-59 | One account-wide Cloudflare token reachable from every branch's deploy job, behind tag-pinned third-party actions; agent workflow can push into it | Open (Medium) | [2026-10-01](security-review/rounds/2026-10-01.md) | Architecture A6 |
| SEC-60 | Worker API responses carry no hardening headers (production `/api/*` bypasses Pages headers); 500s echo exception text | Open (Low) | [2026-10-01](security-review/rounds/2026-10-01.md) | Architecture A5 |
| SEC-61 | airscore-api's unauthenticated `/internal/cache/*` private only by wrangler's implicit `workers_dev` default; AirScore proxy unthrottled | Open (Low) | [2026-10-01](security-review/rounds/2026-10-01.md) | Explicit `workers_dev`/`preview_urls = false`; live check G-25 |
| SEC-62 | Personal-library task share links (`/api/u/:username/task/:task_code`) are guessable | Open (Info) | [2026-10-01](security-review/rounds/2026-10-01.md) | Random share token, or document as public |

## Standing scope gaps

Stable ids — strike a closed gap with the round that closed it; never
renumber or reuse. (Assigned 2026-08-17 from the last single-file round's
list; earlier rounds' per-round gap numbers do not correspond.)

- **G-01** — Dynamic CSRF PoC against the allowlisted CORS.
- **G-02** — Cookie attribute verification on a live deploy.
- **G-03** — Cloudflare zone settings snapshot (HSTS, TLS min, WAF, bot management).
- **G-04** — Verify the SEC-10 fix on a deployed comp-api endpoint.
- **G-05** — Confirm no legacy `Cookie: test-user=…` acceptance in production (source-level check only so far).
- **G-06** — TOCTOU / idempotency on `/api/user/tracks` + `/api/user/tasks` quota checks (needs a live concurrency test).
- **G-07** — CLOSED 2026-09-27: CSP enforced on every page, SSR'd `/comp*` included (`functions/_middleware.ts`). One definition in `web/frontend/src/security-headers.ts`; `security-headers.test.ts` pins `_headers` to it and scans page sources for inline script; the SSR e2e suite fails on any browser-reported violation; reports reach `functions/api/csp-report.ts`.
- **G-08** — SEC-26: packer/task-analysis decompression cap + test.
- **G-09** — Extend `html-sinks.test.ts` from count-pinning towards content (statement-level escapeHtml check) if a tenth SEC-41-class instance ever appears.
- **G-10** — SEC-45: bound the PathFinder branch-and-bound search; oracle tests + ~60k-fix adversarial regression, in its own PR (`scoring-changes/` note + archive parity measurement owed).
- **G-11** — SEC-40: bound or restructure `findSubCores` in `thermal-shape.ts`.
- **G-12** — SEC-29: parser loop bounds + `file.size` pre-check + regression test.
- **G-13** — SEC-31: byte/fix-based task-analysis cap.
- **G-14** — Turnpoint-count cap in the engine's own `xctsk-parser.ts`/`route-optimizer.ts`, independent of the API-layer Zod schema.
- **G-15** — Email SPF/DKIM/DMARC on a live deploy.
- ~~**G-16** — SEC-34 residual: `astro` 6→7 (with `upgrade-deps`).~~ Closed
  [2026-09-23](security-review/rounds/2026-09-23.md) — commit `4b48aba`;
  `bun audit` now reads 0 vulnerabilities.
- **G-17** — `encodeURIComponent` the ids in `TaskExportButtons.tsx:83-85` and `slugSegment()`'s id half in `lib/slug.ts` (Info-grade); decide whether `fetchWithRetry` should stop retrying non-404 4xx.
- ~~**G-18** — `rateLimit` row expiry (rows never expire; from SEC-39's fix).~~
  Closed [2026-10-01](security-review/rounds/2026-10-01.md) — the nightly
  `purgeExpiredAuthData` (competition-api `data-retention.ts`) deletes rows
  untouched for two days.
- ~~**G-19** — SEC-49: route `POST /api/auth/set-name`/`set-username` through
  the same `nameText()`-shaped control-char/angle-bracket/NFC check
  `validators.ts` applies to every other user-entered name field.~~ Closed
  [2026-09-09](security-review/rounds/2026-09-09.md) — `@glidecomp/
  worker-kit/name-text`.
- **G-20** — `bun install`/bare `bun update <pkg>` preserve an
  already-range-satisfied lockfile resolution rather than advancing to the
  latest matching patch release, so a newly-disclosed CVE against an
  already-pinned version (SEC-50) accumulates silently between rounds
  unless something forces re-resolution (`bun update <pkg> --latest`, or a
  tightened override). Decide whether `upgrade-deps` should routinely
  re-resolve in-range dependencies to latest-patch, or whether relying on
  this review's own `bun audit` step to catch it (twice running now:
  SEC-48, SEC-50) is an accepted tradeoff.
- **G-21** — SEC-51's sibling formats (SeeYou `.cup`, CompeGPS, OziExplorer,
  FS $FormatGEO/$FormatUTM) are deliberately left without the
  formula-injection guard because they are served `application/octet-stream`
  and read literally by flight-instrument software, not opened in a
  spreadsheet app. Re-check that reasoning if any of them ever gains a
  spreadsheet-facing `Content-Type` or a new consumer that hands the file to
  a browser as `text/*`.
- **G-22** — SEC-53: stream-cap (or reject no-`Content-Length`) in `csp-report.ts`.
- **G-23** — Live check that `/api/auth/jwks` answers anonymously and returns public key members only (source review says so; not verified on a deploy).
- **G-24** — SEC-58: list the Pages deployments (`bun run deployments`), check which old `<hash>.glidecomp.pages.dev` builds still answer, and whether an Access policy covers previews and production hash URLs.
- **G-25** — SEC-61: live `workers_dev` / preview-URL state of auth-api, competition-api and airscore-api (is `/internal/cache/clear` reachable anywhere?).
- **G-26** — After the SEC-55 allowlist deploys: Google sign-in on glidecomp.com AND on a branch preview (`/callback/:id/oauth-proxy`). A missing path is one line in `endpoints.ts`.
- **G-27** — SEC-55 residual: run the Google-profile name through `isValidNameText()` at first sign-in (`databaseHooks.user.create.before`, blanking an invalid name so onboarding asks).

## Where to start the next review

1. Commit reviewed up to: **HEAD = `f7b65a1`**, plus the 2026-10-01 round's
   PR. `.github/workflows/` and `functions/` were present; if a future
   sandboxed session lacks `.github/workflows/`, diff with
   `diff <(git show <rev1>:path) <(git show <rev2>:path)`, not a `git diff`
   pathspec. The session's clone was shallow (50 commits); fetch more history
   before relying on `git log` for dates older than ~2026-08-22.
2. **G-26 on the first deploy after the SEC-55 allowlist**: Google sign-in on
   glidecomp.com and on a branch preview.
3. **The three architecture findings with the most leverage**: SEC-58 (A1:
   isolate previews, Access, pruning, then trust only `https://glidecomp.com`),
   SEC-59 (A6: split tokens, protected environment, SHA-pinned actions) and
   SEC-57 (A3: scoped, expiring API keys; needs the owner's call on
   documented behaviour and Settings copy). Live checks G-24/G-25 alongside
   G-02/G-03/G-04/G-15/G-23.
4. **SEC-56 residual, owner's call**: the sign-in page shows its per-IP 429
   text ("Too many tries in a row. Wait a minute, then try again.") for the
   new per-address lockout, which lasts up to an hour. Proposed wording for
   that case only: "Too many wrong codes for this address. Try again in an
   hour, or sign in with Google." Consider an 8-digit code or Turnstile (A8).
5. **SEC-45 (G-10)** remains the top open engine-DoS item, eight rounds
   running; A7 is the class-level answer for it and SEC-26/29/31/40.
6. `bun audit` read clean twice running; G-20 is still undecided (A6
   proposes a scheduled audit).
7. Fix SEC-53 (G-22, small); SEC-60 (A5) is a similarly small,
   self-contained PR.
8. Do NOT re-open SEC-03 (accepted by design).
