-- Open registration becomes a competition setting.
--
-- Uploading a track to a competition you are not registered for has always
-- created your comp_pilot row (see ensureCompPilot in routes/igc.ts). That was
-- unconditional and had no setting, no column, and no mention in the settings
-- dialog — the spec called it "open registration by default" while offering no
-- non-default. An organiser reading their own settings could not discover that
-- anyone signed in could join.
--
-- It matters more now that the site has a public /submit front door, so it
-- becomes a real switch. DEFAULT 1 preserves today's behaviour exactly: every
-- existing competition keeps open registration, and nothing changes until an
-- organiser turns it off.
--
-- Distinct from open_igc_upload (migration 0005), which governs acting for
-- OTHER pilots. This one governs adding YOURSELF.

ALTER TABLE comp ADD COLUMN open_registration INTEGER NOT NULL DEFAULT 1;
