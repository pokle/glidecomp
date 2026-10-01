-- Give every API key an expiry date (SEC-57).
--
-- Keys used to be created with no expiry at all, and a key carries its whole
-- account. auth-api now creates every key with API_KEY_LIFETIME_DAYS (90) to
-- live (auth.ts). This gives the keys made before that the same 90 days,
-- counted from when this migration runs rather than from each key's creation,
-- so that nobody's agent stops working the day it ships: Settings shows each
-- key's expiry date, and there are 90 days to replace it.
--
-- The format is the one Better Auth writes (an ISO 8601 string in UTC with
-- milliseconds), because the plugin finds expired keys by comparing these
-- strings.
--
-- Not a scoring input and not competition data: no score bump, no audit entry.

UPDATE "apikey"
   SET "expiresAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+90 days')
 WHERE "expiresAt" IS NULL;
