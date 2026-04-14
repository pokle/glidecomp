-- API key table for @better-auth/api-key plugin (v1.5.x schema)

CREATE TABLE IF NOT EXISTS "apikey" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "configId" TEXT NOT NULL DEFAULT 'default',
  "name" TEXT,
  "start" TEXT,
  "prefix" TEXT,
  "key" TEXT NOT NULL UNIQUE,
  "referenceId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "refillInterval" INTEGER,
  "refillAmount" INTEGER,
  "lastRefillAt" TEXT,
  "enabled" INTEGER NOT NULL DEFAULT 1,
  "rateLimitEnabled" INTEGER NOT NULL DEFAULT 1,
  "rateLimitTimeWindow" INTEGER,
  "rateLimitMax" INTEGER,
  "requestCount" INTEGER NOT NULL DEFAULT 0,
  "remaining" INTEGER,
  "lastRequest" TEXT,
  "expiresAt" TEXT,
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL,
  "permissions" TEXT,
  "metadata" TEXT
);

CREATE INDEX IF NOT EXISTS "apikey_configId_idx" ON "apikey" ("configId");
CREATE INDEX IF NOT EXISTS "apikey_referenceId_idx" ON "apikey" ("referenceId");
CREATE INDEX IF NOT EXISTS "apikey_key_idx" ON "apikey" ("key");
