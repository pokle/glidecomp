# Database

## D1 Database

TaskScore uses Cloudflare D1 (SQLite) for auth storage.

- **Database name:** `taskscore-auth`
- **Database ID:** `aa8b644f-368e-493a-8b49-1af0d756aff4`
- **Schema file:** `web/workers/auth-api/src/db/schema.sql`

## Running Wrangler

Use `bun run wrangler2` to run wrangler commands:

```bash
bun run wrangler2 d1 execute taskscore-auth --remote --file=web/workers/auth-api/src/db/schema.sql
```

**Important:** Always pass `--remote` to execute against the production database. Without it, wrangler operates on the local dev database only.

## Account Deletion

`POST /api/auth/delete-account` deletes the `user` row from D1. CASCADE foreign keys automatically clean up `session` and `account` rows. The frontend also clears `localStorage` and deletes the `taskscore` IndexedDB database (which stores tracks and tasks).

### Future storage checklist

When adding new user data storage, update the delete-account endpoint in `web/workers/auth-api/src/index.ts` to clean up:

- **R2 buckets:** Delete all objects under the user's prefix (e.g. `tracks/{userId}/`, `tasks/{userId}/`)
- **New D1 tables:** Add `ON DELETE CASCADE` FK constraints to `userId`, or delete manually before the user row
- **External services:** Revoke tokens or delete data before the user row is removed

## Schema History

- **2026-03-14** — Applied initial schema to remote D1
