# Manually created infrastructure

Everything below is created once, by hand, before the first deploy. The
workflows in `.github/workflows/` assume all of it already exists — they deploy
code, never resources. The IDs each command prints go into the matching
`wrangler.toml`.

## D1 — `taskscore-auth`

One database for the whole app: auth-api and competition-api both bind it
(`glidecomp_auth` and `DB` respectively), sharing the migrations in
`web/db/migrations/`. The name is historical — the project was TaskScore before
it was GlideComp, and a D1 database can't be renamed.

```
bunx wrangler d1 create taskscore-auth
# Then update the database_id in BOTH web/workers/auth-api/wrangler.toml
# and web/workers/competition-api/wrangler.toml
```

Migrations are applied by the deploy workflow on master (`d1 migrations apply
taskscore-auth --remote`, run from `web/workers/auth-api`). Locally:
`bun run db:migrate`.

## R2 — `glidecomp`

Tracklog and user file storage, bound as `R2` by both auth-api and
competition-api.

```
bunx wrangler r2 bucket create glidecomp
```

## KV — the two caches

The airscore-api's upstream cache:

```
cd web/workers/airscore-api
bunx wrangler kv namespace create AIRSCORE_CACHE
bunx wrangler kv namespace create AIRSCORE_CACHE --preview
# Then update wrangler.toml with the returned IDs
```

And the competition-api's scores cache:

```
cd web/workers/competition-api
bunx wrangler kv namespace create glidecomp_scores_cache
bunx wrangler kv namespace create glidecomp_scores_cache --preview
# Then update wrangler.toml with the returned IDs
```

## Email Service — sender domain verification

auth-api sends the sign-in OTP emails through Cloudflare Email Service (the
`[[send_email]]` binding named `EMAIL`, a paid-plan feature). `glidecomp.com`
must be verified as a **sender domain** in the dashboard (Email Service →
sender domains, which walks you through the DNS records) before anything will
send — until then every send fails with `E_SENDER_NOT_VERIFIED`. Local dev
never sends: `auth.ts` short-circuits via `isLocalDev()` and logs the code
instead.

## Worker secrets

auth-api needs three, set once per environment with `wrangler secret put` from
`web/workers/auth-api/` (or in `.dev.vars` for local dev — see
[docs/auth.md](docs/auth.md)):

- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` — the Google OAuth app's
  credentials
- `BETTER_AUTH_SECRET` — the Better Auth signing secret

competition-api and airscore-api have no secrets: competition-api reaches auth
over a service binding rather than a shared key. It does read
`SQIDS_ALPHABET`, whose `[vars]` value in `wrangler.toml` is only the
plain-alphabet default — override it per environment (dashboard, or `.dev.vars`
locally) if you want public ids that aren't guessable from the default
alphabet.

## GitHub Actions secrets

Set these on the repository, or the workflows fail:

- `CLOUDFLARE_API_TOKEN` — used by every `wrangler-action` step (Workers
  deploys, D1 migrations, the Pages deploy) and by the CIVL rankings job
- `CLOUDFLARE_ACCOUNT_ID` — same steps
- `VITE_MAPBOX_TOKEN` — baked into the frontend at build time. The deploy job
  validates it explicitly and exits 1 if it's empty, because a missing token
  builds cleanly and only fails in the browser.

# Automated deployments

`.github/workflows/deploy.yml` runs on **every branch**, as one definition, so
the preview and production paths can't drift:

- `test` (`bun run test:all`) and `e2e` (`bun run test:e2e`) start together;
  `deploy` waits on `test` only.
- The production steps are gated on `github.ref_name == 'master'`, and run in
  this order: **airscore-api → D1 migrations → auth-api → competition-api →
  Pages**. Workers before Pages is load-bearing — the Pages Functions' service
  bindings require the Workers to already exist. Branch previews skip the
  Worker deploys entirely and bind to the production Workers.
- The Pages deploy runs for every branch (`pages deploy --branch=<ref>`);
  `master` promotes to glidecomp.com, anything else gets its preview alias,
  which is posted back as a PR comment. Use `bun run preview-url` to get that
  alias rather than deriving it by hand.
- `web/scripts/smoke-test.sh` then runs against whichever URL was just
  deployed, preview or production.

`.github/workflows/civl-rankings.yml` is the other job — 04:00 UTC daily, plus
`workflow_dispatch`. It imports the CIVL world pilot rankings into D1 (see
[docs/civl-rankings.md](docs/civl-rankings.md)) and deliberately deploys
nothing and applies no migrations.

Manual deploys, if you need one: `bun run deploy:all` (Pages + all three
Workers), or `deploy` / `deploy:auth` / `deploy:comp` / `deploy:worker`
individually.
