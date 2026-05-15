import { applyD1Migrations, env } from "cloudflare:test";

// Runs outside isolated storage — DDL persists across test files. Per-test
// data is wiped automatically between tests by the pool's storage isolation.
// applyD1Migrations is idempotent, safe to call multiple times.
await applyD1Migrations(env.glidecomp_auth, env.TEST_MIGRATIONS);
