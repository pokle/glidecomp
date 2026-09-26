-- Key pairs for Better Auth's jwt plugin (auth-api/src/auth.ts).
--
-- auth-api signs the short-lived `session_data` cookie (the session cookie
-- cache) with the private key here, so competition-api and the SSR Function
-- can check a signed-in visitor with the PUBLIC key from /api/auth/jwks,
-- without an auth hop, a D1 read, or a copy of BETTER_AUTH_SECRET.
--
-- `privateKey` is stored encrypted with BETTER_AUTH_SECRET (the plugin's
-- default), so a leaked row signs nothing. The first key is minted by auth-api
-- on first use; rows are only ever added.

CREATE TABLE IF NOT EXISTS "jwks" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "publicKey" TEXT NOT NULL,
  "privateKey" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL,
  "expiresAt" TEXT,
  "alg" TEXT,
  "crv" TEXT
);
