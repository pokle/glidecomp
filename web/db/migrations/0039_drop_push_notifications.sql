-- Drop the native app's push notifications (migration 0038).
--
-- The native app was removed (docs/2026-10-22-mobile-app-vs-web-research.md
-- records why), and with it the only thing that wrote or read these tables.
-- Nothing else refers to them. Like 0038, not competition data: no audit
-- entry, no score bump.

DROP INDEX IF EXISTS comp_notify_comp;
DROP TABLE IF EXISTS comp_notify;
DROP INDEX IF EXISTS push_token_user;
DROP TABLE IF EXISTS push_token;
