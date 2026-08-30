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

## Findings register

Single source of truth for current status. Severity, evidence, and
remediation detail live in the introducing round; status movements in the
rounds linked here.

| ID | Title | Status @ 2026-08-17 | Introduced | Resolved / last movement |
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
| SEC-27 | Super-admin allowlist matches on email alone | Open (Info) | [2026-07-03](security-review/rounds/2026-07-03.md) | — |
| SEC-28 | Pilots CSV export writes spreadsheet formula triggers verbatim | Fixed | [2026-07-06](security-review/rounds/2026-07-06.md) | [2026-07-29](security-review/rounds/2026-07-29.md) — shared `csvEscape()` |
| SEC-29 | Quadratic-time GPX/KML client waypoint parsers | Open (deferred) | [2026-07-12](security-review/rounds/2026-07-12.md) | Gap G-12 |
| SEC-30 | Open redirect via backslash-folded `next` in sign-in | Fixed | [2026-07-19](security-review/rounds/2026-07-19.md) | Fixed same round (`safe-next.ts`) |
| SEC-31 | Task-analysis field cap by track count, not bytes | Open (deferred) | [2026-07-19](security-review/rounds/2026-07-19.md) | Gap G-13 |
| SEC-32 | Quadratic-time altitude cleaning on crafted IGC timestamps | Fixed | [2026-07-26](security-review/rounds/2026-07-26.md) | Fixed 2026-08-03 (`SlidingMedian`), verified [2026-08-05](security-review/rounds/2026-08-05.md) |
| SEC-33 | Quadratic-time track-quality glide window | Fixed | [2026-07-26](security-review/rounds/2026-07-26.md) | Fixed 2026-08-03 (monotone deque), verified [2026-08-05](security-review/rounds/2026-08-05.md) |
| SEC-34 | Dirty `bun audit` — dev/build-time advisories | Open — 3 residual (`astro` ×3) | [2026-07-26](security-review/rounds/2026-07-26.md) | [2026-08-12](security-review/rounds/2026-08-12.md) — 10→3; gap G-16 |
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
- **G-07** — Flip CSP from Report-Only to enforced (nonce/hash the four inline-script blocks first).
- **G-08** — SEC-26: packer/task-analysis decompression cap + test.
- **G-09** — Extend `html-sinks.test.ts` from count-pinning towards content (statement-level escapeHtml check) if a tenth SEC-41-class instance ever appears.
- **G-10** — SEC-45: bound the PathFinder branch-and-bound search; oracle tests + ~60k-fix adversarial regression, in its own PR (`scoring-changes/` note + archive parity measurement owed).
- **G-11** — SEC-40: bound or restructure `findSubCores` in `thermal-shape.ts`.
- **G-12** — SEC-29: parser loop bounds + `file.size` pre-check + regression test.
- **G-13** — SEC-31: byte/fix-based task-analysis cap.
- **G-14** — Turnpoint-count cap in the engine's own `xctsk-parser.ts`/`route-optimizer.ts`, independent of the API-layer Zod schema.
- **G-15** — Email SPF/DKIM/DMARC on a live deploy.
- **G-16** — SEC-34 residual: `astro` 6→7 (with `upgrade-deps`).
- **G-17** — `encodeURIComponent` the ids in `TaskExportButtons.tsx:83-85` and `slugSegment()`'s id half in `lib/slug.ts` (Info-grade); decide whether `fetchWithRetry` should stop retrying non-404 4xx.
- **G-18** — `rateLimit` row expiry (rows never expire; from SEC-39's fix).

## Where to start the next review

1. Commit reviewed up to: **HEAD = `9bc5d1d`** (`9bc5d1d0ddce798df16035a4f3e3a6710cfdd8cc`; base `b5a558f3`). Unshallow before diffing if the clone is shallow (see the [2026-08-12 round](security-review/rounds/2026-08-12.md)'s process note). Note: the sandboxed review session used for the 2026-08-20 round had no `.github/workflows/` in its working tree (checked out repo excludes it) — diff that file with `diff <(git show <rev1>:path) <(git show <rev2>:path)`, not a `git diff` pathspec, which silently returns empty there.
2. **SEC-45 (G-10) is the only open engine-DoS finding of its class and the top open item — now two rounds running with no fix PR started.** It needs its own PR: oracle tests over the S7F 2026 suite, a bound on `computeBestProgress`'s `exactAt()` evaluations (or a time-based Lipschitz prune), a ~60k-fix adversarial wandering track under a hard timeout, a `scoring-changes/` note, and archive parity measurement. The SEC-46 fix ([2026-08-17](security-review/rounds/2026-08-17.md)) is the template at smaller scale.
3. Verify the SEC-46 and SEC-47 fixes held (`circle-detector-adversarial.test.ts` and `html-sinks.test.ts` are the tripwires) — both re-confirmed unchanged in the [2026-08-20 round](security-review/rounds/2026-08-20.md).
4. `bun audit`: check whether `upgrade-deps` has taken astro to 7 (G-16) — still `6.4.8` / 3 dev-time advisories as of 2026-08-20.
5. Chase SEC-26/29/31/40 (G-08/G-12/G-13/G-11) — none moved across the 2026-08-17 or 2026-08-20 rounds.
6. The CSP flip (G-07) still needs the four-block inline-script inventory first.
7. Do NOT re-open SEC-03 (accepted by design).
