import { applyD1Migrations, env } from "cloudflare:test";

// Runs outside isolated storage — migrations persist across test files.
// applyD1Migrations is idempotent.
await applyD1Migrations(env.glidecomp_auth, env.TEST_MIGRATIONS);
