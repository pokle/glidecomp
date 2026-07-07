# Preview Environment Plan

**Status: proposed — not yet implemented.** (2026-07-05)

A fixed, isolated **preview** backend (workers + D1 + R2 + KV) that every branch
deploy binds to, so "deploy a preview" becomes "push a branch": CI deploys the
branch to a public per-branch URL that works from any device, backed by real
Cloudflare infrastructure, with production code, routes, and data untouchable.

## Problem

- Each worker has a single fixed `name` in its `wrangler.toml`, so `wrangler
  deploy` from any branch **overwrites the production worker**. The configs also
  hard-code production routes (`glidecomp.com/api/...`) and production data
  bindings (D1 `taskscore-auth`, R2 `glidecomp`), so even a renamed worker would
  still touch production data.
- `branch-deploy.yml` already gives every non-master branch a public Pages
  preview URL (`<branch>.glidecomp.pages.dev`, posted as a PR comment) — but it
  deploys **only the frontend**. Branch previews run against whatever the Pages
  *Preview* environment service bindings point at today: the production workers
  and production database.
- `wrangler dev` gives full local isolation but only on `localhost`. Tunneling a
  dev server out of a Claude Code cloud session was tested (2026-07-05) and is
  not possible: the sandbox egress is a TLS-re-terminating HTTPS proxy on port
  443 only. cloudflared needs QUIC/TCP 7844 (blocked), SSH-over-443 tunnels
  (pinggy) are killed because the tunneled bytes aren't TLS, and the proxy
  policy explicitly rules out WebSocket upgrades and cert-pinned clients
  (ngrok). Deploying previews is the supported path; `api.cloudflare.com` is
  reachable and wrangler works from cloud sessions (with `NODE_USE_ENV_PROXY=1`).

## Key mechanism

Cloudflare Pages has exactly two runtime environments: **Production**
(deployments where `--branch` equals the production branch, `master`) and
**Preview** (every other branch). Service bindings are configured per
environment. The existing `wrangler pages deploy --branch=<branch>` command in
`branch-deploy.yml` therefore already lands in the Preview environment — no new
selection logic is needed. The work is to give Preview its own backend and point
the Preview bindings at it.

Naming convention: each worker gains a `[env.preview]` section, which wrangler
deploys as `<name>-preview` (`competition-api-preview`, `auth-api-preview`,
`airscore-api-preview`). Preview data resources are suffixed the same way.

| Resource | Production | Preview |
| --- | --- | --- |
| Workers | `competition-api`, `auth-api`, `airscore-api` | same + `-preview` suffix |
| Routes | `glidecomp.com/api/...` | none (`workers_dev = true` only) |
| D1 | `taskscore-auth` | `taskscore-auth-preview` (new) |
| R2 | `glidecomp` | `glidecomp-preview` (new) |
| KV (3dvis replay-bundle cache; scores moved to D1) | `dcf6eb84…` | `fc7d966c…` (existing `preview_id`, reused) |
| KV (airscore cache) | `587aa703…` | `824da107…` (existing `preview_id`, reused) |
| Frontend | `glidecomp.com` (Pages Production) | `<branch>.glidecomp.pages.dev` (Pages Preview) |

The two KV namespaces already have `preview_id` twins (created for `wrangler dev`
remote previews, currently unused in deploys) — the preview env reuses them
instead of creating new ones.

## Step 1 — one-time: create preview resources

```sh
bunx wrangler d1 create taskscore-auth-preview     # note the database_id for step 2
bunx wrangler r2 bucket create glidecomp-preview

# after step 2's config lands:
cd web/workers/auth-api
bunx wrangler d1 migrations apply taskscore-auth-preview --env preview --remote

# secrets (auth-api-preview) — see "Auth on previews" for which values
bunx wrangler secret put GOOGLE_CLIENT_ID --env preview
bunx wrangler secret put GOOGLE_CLIENT_SECRET --env preview
bunx wrangler secret put BETTER_AUTH_SECRET --env preview
```

All within the free tier (10 D1 databases, 100 workers, 10 GB R2).

## Step 2 — worker `wrangler.toml` `[env.preview]` blocks

Wrangler gotcha that shapes all three files: **named environments inherit
almost nothing** — bindings, vars, and routes must all be redeclared per env.
That non-inheritance is also the safety property: no `[[routes]]` in
`[env.preview]` means a preview deploy *cannot* attach to `glidecomp.com`.

`web/workers/competition-api/wrangler.toml` (the fullest example):

```toml
[env.preview]                      # deploys as "competition-api-preview"
workers_dev = true                 # → competition-api-preview.<account>.workers.dev

[env.preview.placement]
mode = "smart"                     # keep parity with production

[[env.preview.d1_databases]]
binding = "DB"
database_name = "taskscore-auth-preview"
database_id = "<from step 1>"
migrations_dir = "../../db/migrations"

[[env.preview.r2_buckets]]
binding = "R2"
bucket_name = "glidecomp-preview"

[[env.preview.services]]
binding = "AUTH_API"
service = "auth-api-preview"

[[env.preview.services]]
binding = "AIRSCORE_API"
service = "airscore-api-preview"

[env.preview.vars]
SQIDS_ALPHABET = "abcdefghijklmnopqrstuvwxyz"

[[env.preview.kv_namespaces]]
binding = "glidecomp_scores_cache"
id = "fc7d966cba2c40fdb52c83c7a88c217e"   # the existing preview_id namespace
```

`auth-api/wrangler.toml`: same pattern — D1 binding `glidecomp_auth` →
`taskscore-auth-preview`, R2 → `glidecomp-preview`, no routes, and
`[env.preview.vars]` `BETTER_AUTH_URL` per the auth decision below.

`airscore-api/wrangler.toml`: KV → `824da1077c3b4299af9caab8a7d62ae3`, copy the
`AIRSCORE_BASE_URL`/TTL vars, no routes. (The frontend never calls
`/api/airscore/*` directly — only competition-api does, via its service binding —
so no Pages proxy function is needed for it.)

**Config-drift rule (part of "done" for future changes):** any new binding,
var, or secret added to a worker's top-level config must be added to its
`[env.preview]` section in the same change, and new secrets set for both
workers. Otherwise preview silently diverges and stops being a trustworthy
rehearsal of production.

## Step 3 — point Pages Preview at the preview workers

The Pages project's service bindings live in the **root `wrangler.toml`**
(`name = "glidecomp"`, `pages_build_output_dir`), and deploys go through
`wrangler pages deploy`, so this is a code change, not a dashboard task. Pages
configs support exactly two named environments; top-level values apply to both
unless overridden:

```toml
# root wrangler.toml — append:
[[env.preview.services]]
binding = "AUTH_API"
service = "auth-api-preview"

[[env.preview.services]]
binding = "COMPETITION_API"
service = "competition-api-preview"
```

Verify after the first deploy (dashboard → Pages → glidecomp → Settings →
Bindings, per environment) that Production still binds `auth-api` /
`competition-api` and Preview binds the `-preview` pair. If wrangler's Pages
env-override behaviour surprises us here, the fallback is setting the Preview
bindings once in the dashboard — same result, just not code-managed.

## Step 4 — seed preview data

`web/scripts/seed-sample-comp.ts` hard-codes `DB_NAME = 'taskscore-auth'` and
targets local state or `--remote` (production). Add a `--preview` flag that:

- passes `--env preview` (with the existing `--config
  web/workers/competition-api/wrangler.toml`) to wrangler commands so R2/D1
  resolve to the preview bindings, and
- swaps `DB_NAME` to `taskscore-auth-preview` for the `d1` commands.

Then `bun run seed:sample --preview` (and `--preview big-chip`) populates the
preview stack with the bundled comps so previews have data to render.

## Step 5 — CI: extend `branch-deploy.yml`

Mirror the worker steps from `deploy.yml`'s deploy job, targeting preview,
before the existing Pages deploy step. Order matters: workers first (service
bindings require the target workers to exist), Pages last.

```yaml
  deploy:
    name: Deploy Preview
    needs: test
    concurrency:                 # all branches share one preview backend;
      group: preview-deploy      # don't interleave two branch deploys
      cancel-in-progress: true
    steps:
      # ... existing checkout/setup/build steps unchanged ...

      - name: Deploy AirScore API Worker (preview)
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          workingDirectory: web/workers/airscore-api
          command: deploy --env preview

      - name: Apply D1 Migrations (preview)
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          workingDirectory: web/workers/auth-api
          command: d1 migrations apply taskscore-auth-preview --env preview --remote

      - name: Deploy Auth API Worker (preview)
        # ... command: deploy --env preview

      - name: Deploy Competition API Worker (preview)
        # ... command: deploy --env preview

      # existing "Deploy to Cloudflare Pages (Branch Preview)" step unchanged
```

Same secrets, same action, same trigger as today. The existing smoke tests
(`data-git-sha` match, dev-login blocked) run against the preview URL unchanged.
A nice side effect: schema migrations now hit the preview D1 on every branch
push **before** they ever reach production — a free canary.

Optional additions:
- `workflow_dispatch:` trigger for manual re-deploys of the preview backend.
- A paths filter to skip worker deploys when only the frontend changed —
  probably not worth it; worker deploys are fast and idempotent.

Also add convenience scripts to `package.json` (`deploy:preview`,
`deploy:preview:auth`, …) mirroring the production `deploy:*` scripts with
`--env preview`, for deploying preview outside CI.

## Auth on previews — decision needed

Current facts:
- `trustedOrigins` already includes `https://*.glidecomp.pages.dev`, so preview
  origins are accepted.
- `dev-login` is gated by `isLocalDev()` (hostname of `BETTER_AUTH_URL` ==
  `localhost`), so it stays off in preview as long as `BETTER_AUTH_URL` isn't
  localhost. The "dev-login must be blocked" smoke test keeps passing.
- The `oAuthProxy` plugin (productionURL `https://glidecomp.com`) is what makes
  Google sign-in work on `*.pages.dev` previews **today** — but only because
  previews currently share the production database. The proxy routes the OAuth
  callback through the production auth worker, which creates the session in
  *its* D1. Once preview has its own D1, that session is invisible to preview.

Options, in order of preference:

1. **Stable preview callback (recommended).** `auth-api-preview` gets a stable
   public URL for free: `auth-api-preview.<account>.workers.dev`. Set the
   preview env's `BETTER_AUTH_URL` to that URL, make the `oAuthProxy`
   `productionURL` configurable via env (defaulting to
   `https://glidecomp.com`) and point preview's at the same workers.dev URL,
   then register `https://auth-api-preview.<account>.workers.dev/api/auth/callback/google`
   as an additional redirect URI on the existing Google OAuth client. Sign-in
   from any `*.pages.dev` preview proxies through the stable preview callback
   and lands sessions in the preview D1. Small code change in
   `web/workers/auth-api/src/auth.ts`; secrets can then reuse the production
   `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`.
2. **Preview test-login.** Add an explicit `ENABLE_TEST_LOGIN` var set only in
   `[env.preview.vars]`, allowing dev-login-style sign-in on preview. Zero
   Google configuration, but preview URLs are public, so anyone who finds one
   can create accounts in the preview DB — throwaway data, but it weakens the
   "dev-login is never deployed" invariant and needs a deliberate carve-out in
   the smoke test. Acceptable as a stopgap, not the end state.
3. **No auth on previews.** Browse-only previews (public pages render; sign-in
   fails). Simplest, and may be fine for "look at this UI on my phone" — could
   ship first and add option 1 later.

## Rollout order

Sequencing matters because the Pages Preview binding flip is the switch:

1. Land steps 2 & 4 (worker `[env.preview]` blocks, seed flag) on a branch.
2. Create resources + secrets (step 1), deploy the three preview workers
   manually (`bun run deploy:preview`), apply migrations, seed data.
3. Verify the preview workers directly on their `workers.dev` URLs.
4. Land step 3 (root wrangler.toml Preview bindings) + step 5 (CI). From the
   next branch push, previews are fully isolated. Flipping bindings before the
   preview workers exist would break previews — hence the ordering.
5. Verify end to end: push a branch, wait for the PR comment URL, check `/comp`
   renders the seeded comp on a phone, confirm the `data-git-sha` smoke test
   passed, and confirm production deployments list is untouched
   (`bun run deployments`).

## Caveats

- **Shared preview backend, last push wins.** All branches share the one
  preview worker set + D1. Pushing branch B replaces branch A's backend while
  A's frontend preview URL still exists (frontends are per-branch and
  immutable; the backend is a single moving target). Right trade-off for a
  small team; revisit per-branch workers only if it actually bites.
- **Schema-migration branches** poison the shared preview D1 for other branches
  until merged (migrations apply on every branch push). If that hurts, the
  escape hatch is a throwaway D1 for that branch — manual, deliberate.
- **Preview D1/R2 accumulate junk.** Fine by design; reseed with
  `bun run seed:sample --preview` or drop/recreate the database when needed.
- **Config drift** between top-level and `[env.preview]` blocks is the main
  ongoing tax — see the rule in step 2.
- **Audit logging** applies on preview exactly as production (same code path);
  preview audit logs are throwaway along with the rest of the preview data.

## Relationship to "deploy a preview" from Claude Code cloud sessions

With this plan, a cloud session deploys a preview by **pushing the branch** —
CI does the rest and the URL arrives in the PR comment. No Cloudflare
credentials in the Claude environment, and the test gate applies to previews.
If direct deploys from a session are ever wanted (skip CI latency), it works:
add a `CLOUDFLARE_API_TOKEN` secret and `NODE_USE_ENV_PROXY=1` to the Claude
Code environment and run the same `deploy --env preview` commands. Both paths
end at the same fixed preview environment.
