# Database

## D1 Database

GlideComp uses Cloudflare D1 (SQLite) for auth storage.

- **Database name:** `taskscore-auth`
- **Database ID:** `aa8b644f-368e-493a-8b49-1af0d756aff4`
- **Schema file:** `web/workers/auth-api/src/db/schema.sql`
- **Migrations:** `web/db/migrations/` — shared by `auth-api` and `competition-api` (both wrangler.tomls point at this directory). Apply locally with `bun run db:migrate`.

## Running Wrangler

Use `bun run wrangler2` to run wrangler commands:

```bash
bun run wrangler2 d1 execute taskscore-auth --remote --file=web/workers/auth-api/src/db/schema.sql
```

**Important:** Always pass `--remote` to execute against the production database. Without it, wrangler operates on the local dev database only.

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

## Schema History

- **2026-03-14** — Applied initial schema to remote D1
