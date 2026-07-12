# Per-Branch Preview Environments

**Status: implemented** (2026-07-12; superseding the 2026-07-05 shared-preview
proposal — see "History" at the bottom).

Every non-master branch push deploys a **fully isolated, per-branch stack**:
its own D1 database, R2 bucket, and auth/competition workers, seeded with the
bundled sample comps, fronted by the branch's Pages preview at a stable URL
that works from any device:

```
https://<slug>.glidecomp.pages.dev        slug = branch name lowercased,
                                          non-alphanumerics → '-', 28 chars max
```

The three requirements this design serves:

1. **Environment isolation** — a preview can never read or write production.
   Preview workers live on `workers.dev` only (no `glidecomp.com` routes), and
   the Pages *Preview* environment's service bindings point at a 503-only
   `preview-blackhole` worker, so even an accidental binding call fails loudly
   instead of touching production (the pre-2026-07 behaviour, where branch
   previews called the production workers and mutated the production DB, is
   structurally impossible now).
2. **Branch isolation** — concurrent long-running branches (e.g. several
   Claude Code sessions) each get their own database, bucket, and workers;
   one branch's schema migrations or test data never affect another's.
3. **Simple URL** — the existing Pages branch alias is the one URL to open on
   any phone/tablet/desktop; the per-branch backend hides behind it.

## Anatomy of a stack

| Piece | Name | Notes |
| --- | --- | --- |
| D1 database | `glidecomp-pv-<slug>` | auth + competition tables, migrated + seeded |
| R2 bucket | `glidecomp-pv-<slug>` | IGC track objects |
| Auth worker | `auth-api-pv-<slug>` | `workers.dev` only; `BETTER_AUTH_URL` = the branch alias URL; `ENABLE_TEST_LOGIN=1` |
| Competition worker | `competition-api-pv-<slug>` | `workers.dev` only; service-binds the branch auth worker + shared airscore |
| Frontend | `https://<slug>.glidecomp.pages.dev` | ordinary Pages branch preview |

Shared across all stacks (branch-agnostic, read-only, never destroyed):
`airscore-api-preview` (cache of xc.highcloud.net, using the existing
`preview_id` KV twin), `preview-blackhole`, and the scores/3dvis preview KV
namespace (safe to share: its cache key hashes each track's seed-time
`uploaded_at`, so branches can't collide).

## How a branch reaches *its* backend

Cloudflare Pages has exactly two runtime environments (Production, Preview),
and the Preview environment's service bindings are **one fixed set shared by
every branch** — bindings cannot route per branch. What *is* per-branch is the
Functions bundle: each `wrangler pages deploy` carries its own copy of
`functions/`. So:

- `web/scripts/preview/deploy-stack.ts` writes
  **`functions/lib/preview-backends.ts`** (committed state: `null`) with the
  branch workers' public URLs before the Pages deploy.
- The API proxy Functions (`functions/api/*`), the SSR Function
  (`functions/comp/[[path]].ts`) and the sitemap check that module: non-null →
  `fetch()` the branch worker by URL (headers/cookies/body pass through, same
  as the binding); null (production, local) → service binding, zero-cost.
- The Preview environment's bindings (root `wrangler.toml`
  `[[env.preview.services]]`) point at `preview-blackhole`, which only ever
  answers 503 — the guarantee behind requirement 1.

The workers.dev hop adds ~50–150 ms per API call versus a service binding.
Fine for previews; production is unaffected.

## CI flow (`.github/workflows/branch-deploy.yml`)

On every push to a non-master branch, after tests:

1. `bun web/scripts/preview/deploy-stack.ts <branch>` — idempotently ensures
   the D1 database + R2 bucket exist, generates `wrangler.preview.json`
   configs (from the checked-in TOMLs — names/bindings swapped, vars and
   compatibility settings copied, **no routes**), deploys the shared workers
   then the branch workers, ensures a per-stack `BETTER_AUTH_SECRET`
   (generated once, so sessions survive redeploys), applies D1 migrations,
   and writes `preview-backends.ts`.
2. Seeds the sample comps (Corryong Cup + Big Chip) — only when the database
   was just created, or on demand via **`[reseed]` in the commit message**
   (the seed is idempotent per comp and leaves other comps on the stack
   alone).
3. Builds the frontend with `VITE_ENABLE_TEST_LOGIN=1` (shows the dev sign-in
   button) and runs `wrangler pages deploy --branch=<branch>`.
4. Smoke-tests: SPA routes + git-sha, `/api/comp` answers 200 through the
   branch worker (a 503 would mean the blackholed binding was hit), and
   dev-login **works** (the inverse of production's smoke test in
   `deploy.yml`, which still asserts dev-login is blocked).
5. Posts/updates the PR comment with the branch alias URL.

Deploys are serialized per branch (`concurrency: preview-deploy-<branch>`);
different branches deploy independently — that's the point.

A note on schema migrations: each branch migrates only its own database, so a
migration branch no longer poisons anyone else. Production migrations still
first run in CI e2e (local D1) and on every preview stack before `deploy.yml`
applies them to production.

## Auth on previews

Google OAuth cannot work per-branch (a per-branch hostname can't be a
registered redirect URI), so preview stacks use the **dev-login flow**:
`ENABLE_TEST_LOGIN=1` on the branch auth worker enables email/password +
`POST /api/auth/dev-login` (`isTestLoginEnabled()` in
`web/workers/auth-api/src/auth.ts`), and preview frontend builds show the
"Sign in (dev)" button. The default identity matches `SUPER_ADMIN_EMAILS`, so
the tester has admin rights on the throwaway stack. The `oAuthProxy` plugin is
omitted whenever test-login is on, so a preview sign-in can never bounce
through the production auth worker.

Accepted trade-off: anyone who discovers a preview URL can sign in to that
branch's **throwaway, sample-seeded** database. Production is untouched by
design, and `deploy.yml`'s smoke test still fails the deploy if dev-login ever
answers on glidecomp.com. If prod-like OAuth on previews is ever wanted, the
path is a stable extra redirect URI (e.g. a fixed preview auth worker) plus a
configurable `oAuthProxy.productionURL` — deliberately not built yet.

## Lifecycle & free-tier budget

`.github/workflows/preview-cleanup.yml` destroys a branch's stack on **branch
delete** and **PR close**, and a **weekly sweep** (also `workflow_dispatch`)
removes stacks whose branch no longer exists. Manual controls:

```sh
bun run preview:deploy <branch-name>     # create/update a stack (needs CF creds)
bun run preview:destroy -- --branch <branch-name>
gh workflow run preview-cleanup.yml      # sweep now
```

The free plan allows **10 D1 databases** per account; production uses one, so
roughly **8 concurrent preview branches** fit. `deploy-stack.ts` fails with an
actionable message when the quota is hit (destroy a stale stack or upgrade to
Workers Paid, which lifts the cap to 50k). Workers (~2/branch), R2 buckets and
KV are nowhere near their limits.

## One-time setup

- `CLOUDFLARE_API_TOKEN` (repo secret) needs, on top of the existing
  Workers/Pages/D1 permissions: **Workers R2 Storage: Edit** (bucket + object
  lifecycle) — regenerate the token if preview deploys fail on R2 calls.
- The `delete`/`schedule` triggers of `preview-cleanup.yml` only fire once the
  workflow file exists on `master` (i.e. after this lands).
- Existing branch previews deployed *before* this change bound to the
  production workers; once the Preview environment bindings flip to
  `preview-blackhole` their API calls return 503. Intentional — re-push the
  branch to give it a proper stack.

## Config drift rule (part of "done")

The preview worker configs are *generated* by
`web/scripts/preview/lib.ts` (`generateStackConfigs`) — vars, compatibility
settings and KV preview ids are copied from the checked-in `wrangler.toml`s
automatically. When you add a **new kind** of binding (queue, DO, extra KV,
extra secret) to a worker, teach the generator about it in the same change,
and if the auth worker gains a secret, set it in `deploy-stack.ts` alongside
`BETTER_AUTH_SECRET`. Otherwise previews silently stop being a trustworthy
rehearsal of production.

## History

The 2026-07-05 proposal (one *shared* preview backend for all branches, via
`[env.preview]` blocks) fixed environment isolation but not branch isolation:
all branches would share one database, so concurrent sessions and migration
branches would trample each other. It was superseded by this per-branch design
before implementation. Two of its mechanisms were kept: the preview KV
`preview_id` twins, and the "previews must be structurally unable to touch
production" framing (now enforced by the blackhole bindings + generated
route-less configs). Tunnelling a local dev server out of a Claude Code cloud
session remains impossible for anonymous tunnels (egress is TLS-only on 443;
cloudflared needs port 7844) — though an authenticated ngrok over the
session's CONNECT proxy is untested but plausible; deploying a real stack is
the supported path either way.
