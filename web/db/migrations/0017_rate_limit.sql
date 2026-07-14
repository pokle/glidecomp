-- Better Auth rate-limit storage (rateLimit.storage = "database" in auth.ts).
-- In-memory rate limiting is useless in workerd: each isolate has its own
-- memory and isolates are recycled constantly, so counters must live in D1.
--
-- Better Auth keeps one row per key (client IP + path) and does
-- find-then-upsert by "key". The same table also backs the per-email OTP send
-- throttle (keys namespaced "otp-email:<email>", see rate-limit.ts), which
-- relies on the UNIQUE index for its atomic INSERT ... ON CONFLICT upsert.
-- "lastRequest" is epoch milliseconds.

CREATE TABLE IF NOT EXISTS "rateLimit" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "key" TEXT NOT NULL,
  "count" INTEGER NOT NULL,
  "lastRequest" INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_rateLimit_key" ON "rateLimit" ("key");
