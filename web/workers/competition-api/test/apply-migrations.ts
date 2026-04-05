import { applyD1Migrations, env } from "cloudflare:test";

// Runs outside isolated storage — migrations persist across test files.
// applyD1Migrations is idempotent, safe to call multiple times.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Seed test users (referenced by competition tests via FK).
// REPLACE so re-runs are safe.
await env.DB.batch([
  env.DB.prepare(
    `INSERT OR REPLACE INTO "user" (id, name, email, "createdAt", "updatedAt")
     VALUES (?, ?, ?, ?, ?)`
  ).bind("user-1", "Test Pilot", "pilot@test.com", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"),
  env.DB.prepare(
    `INSERT OR REPLACE INTO "user" (id, name, email, "createdAt", "updatedAt")
     VALUES (?, ?, ?, ?, ?)`
  ).bind("user-2", "Admin Two", "admin2@test.com", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"),
]);
