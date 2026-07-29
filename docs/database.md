# Database

## D1 Database

GlideComp uses a single Cloudflare D1 (SQLite) database shared by the `auth-api` and `competition-api` workers — auth tables, competition data, user files, and materialized scores all live here.

- **Database name:** `taskscore-auth`
- **Database ID:** `aa8b644f-368e-493a-8b49-1af0d756aff4`
- **Migrations:** `web/db/migrations/` — the schema source of truth, shared by `auth-api` and `competition-api` (both wrangler.tomls point at this directory). Apply locally with `bun run db:migrate`.

## Running Wrangler

Use the repo's pinned wrangler via `bunx wrangler`. Pass `--config` so the D1/R2
bindings resolve, and target local or remote explicitly:

```bash
# Remote (production) — pass --remote, or you only touch the local dev DB:
bunx wrangler d1 execute taskscore-auth \
  --config web/workers/competition-api/wrangler.toml --remote \
  --file=web/db/migrations/0001_auth_init.sql

# Local dev state (what `bun run dev` uses) lives at web/.wrangler/state:
bunx wrangler d1 execute taskscore-auth \
  --config web/workers/competition-api/wrangler.toml \
  --local --persist-to web/.wrangler/state --command "SELECT 1;"
```

**Important:** Always pass `--remote` to execute against the production database. Without it, wrangler operates on the local dev database only.

**Reading rows on `--remote` — use `--command`, not `--file`.** On `--remote`,
`wrangler d1 execute --file` returns only an execution *summary* (`Rows read`,
`Total queries executed`, …) instead of the SELECT result set, and prints
progress lines (`├ Checking if file needs uploading`, spinner frames) to stdout
before the JSON. `--command "<sql>"` returns the actual rows as clean JSON in
both local and remote modes. Reserve `--file` for schema/DDL or large batched
writes whose rows you don't read back. (This is why
`web/scripts/seed-sample-comp.ts` reads via `--command` and writes via `--file`.)

## Sample competitions

`bun run seed` loads the public sample competitions into D1 + R2, so every user
can view them and the 3D replay (`/replay`) can pull packed tracks from the
competition-api Worker (`GET /api/comp/sample-3dvis`). With no arguments it seeds
**every** bundled comp — each folder under `web/samples/comps/` holding a
`comp.json` (Corryong Cup 2017–2026, Unungra Cup, Big Chip, Kosciuszko Loop);
pass one or more slugs to seed just those (`bun run seed corryong-cup-2026`).
The two fabricated fixtures (Big Chip, Kosciuszko Loop) set `"hidden": true` in
their manifests and seed with the D1 `test` flag, so they stay out of the public
comp list and 404 for anonymous visitors while admins can still open them.
Each manifest lists every task with its pilot class (open + floater — see the
CLAUDE.md "Updating bundled data" notes). Refresh the source folders with
`bun web/scripts/download-airscore-comp.ts`.

- **Idempotent:** each comp is identified by name (its manifest's `comp_name`,
  else `SAMPLE_COMP_NAME`). Reruns wipe that comp's tasks / pilots / tracks (D1)
  and IGC objects (R2) and rebuild under the **same `comp_id`** — so a
  messed-with sample is fixed back up.
- **Local:** `bun run seed` writes to `web/.wrangler/state` (start the
  dev servers with `bun run dev` to view it).
- **Production:** `bun run seed --remote` (needs wrangler auth + the same
  `CLOUDFLARE_API_TOKEN` D1/R2 permissions as migrations). Re-run after deploying
  schema changes that affect the sample.

## Account Deletion

`POST /api/auth/delete-account` deletes the `user` row from D1. CASCADE foreign keys automatically clean up `session`, `account`, `user_preferences`, `user_track`, `user_task`, and `user_annotation` rows. Before deleting the user row, the handler lists+deletes every R2 object under `u/{userId}/` so per-user track payloads don't outlive the account. The frontend also clears `localStorage` and deletes any leftover `glidecomp` IndexedDB database.

### Future storage checklist

When adding new user data storage, update the delete-account endpoint in `web/workers/auth-api/src/index.ts` to clean up:

- **R2 buckets:** Delete all objects under the user's prefix. `u/{userId}/...` is wired up (covers user IGC tracks); add new prefixes here if you introduce more user-owned blobs.
- **New D1 tables:** Add `ON DELETE CASCADE` FK constraints to `userId`, or delete manually before the user row.
- **External services:** Revoke tokens or delete data before the user row is removed.

## CI Deployment (GitHub Actions)

D1 migrations are applied in CI via `wrangler d1 migrations apply taskscore-auth --remote` using a Cloudflare **Account API Token** stored in the `CLOUDFLARE_API_TOKEN` GitHub secret.

The token must have **Account / D1 / Edit** permission. Without it, migration commands fail with error code 7403 ("account not valid or not authorized"). Worker deploys use the same token but don't require D1 permissions, so this can go unnoticed until migrations are added.

If the token is rotated or recreated, ensure D1 Edit is included alongside Workers Scripts Edit and Cloudflare Pages Edit.

## Tables

Grouped by what owns them. Migration numbers are given where a table arrived
after the initial schema.

| Group | Tables |
|-------|--------|
| Auth (Better Auth) | `user`, `session`, `account`, `verification`, `apikey` (0002), `rateLimit` (0017 — the D1-backed request limiter; in-memory counters reset with every workerd isolate) |
| Competition | `pilot`, `comp`, `comp_admin`, `comp_pilot`, `comp_waypoints` (0015), `task`, `task_class`, `task_track`, `task_manual_flight` (0014), `task_pilot_status` (0006), `audit_log` (0005) |
| Derived, stale-first | `task_scores` (0012), `track_analysis` (0012), `task_field_analysis` (0019), `task_weather` (0023) |
| Rankings | `pilot_ranking` (0025) — the FAI/CIVL monthly world ranking; deliberately standalone, no FK to `pilot`/`comp_pilot`. See [civl-rankings.md](civl-rankings.md) |
| User files | `user_preferences` (0007), `user_track`, `user_task`, `user_annotation` (0008) |

## Schema History

`web/db/migrations/` is the source of truth — every applied change is a
numbered file there, and `wrangler d1 migrations apply` tracks what has run.
Read the directory rather than a hand-kept changelog; this list is only a map
of the notable ones.

| Migration | What it did |
|-----------|-------------|
| `0001_auth_init` / `0001_comp_init` | The initial auth and competition schemas (applied to remote D1 on 2026-03-14) |
| `0002_apikey` | Better Auth API keys (`glc_` prefixed) |
| `0003_drop_flight_data` | Removed the per-track preprocessed `flight_data` column — scoring reads the IGC files instead |
| `0005_pilot_management_and_audit` | Pilot pre-registration fields + the public `audit_log` |
| `0009_comp_scoring_format` | `gap` vs `open_distance` per comp |
| `0012_task_scores` | Stale-first materialized scores + per-track analyses ([plan](score-caching-stale-first-plan.md)) |
| `0014_manual_flights` | Manual flight reports for track-less pilots (supersede, never delete) |
| `0015_comp_waypoints` | The comp's region waypoint file |
| `0017_rate_limit` | Persistent rate-limit buckets, for the email-OTP sign-in limits |
| `0018_task_stop` | Stopped tasks (`stop_announcement_time`, FAI S7F §12.3) |
| `0019_task_field_analysis` | Stale-first store for the behavioural-metric reports |
| `0021_task_gap_params` | Per-task GAP parameters, merged over the comp's (imported AirScore comps publish a different formula per task) |
| `0022_comp_series_scoring` | FTV series scoring (`series_scoring`, `ftv_factor`) |
| `0023_task_weather` | Cached task weather, invalidated by query key rather than `inputs_rev` |
| `0024_track_quality_override` | The organiser's per-track override of a track-quality verdict (S7A §4.4.6) |
| `0025_pilot_ranking` | CIVL world rankings import |
