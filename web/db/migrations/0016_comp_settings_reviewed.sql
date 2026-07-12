-- Setup-guide signal (comp setup progress): has an admin saved the comp's
-- settings at least once? Flipped by the first successful PATCH
-- /api/comp/:id; purely presentational, never read by scoring.
--
-- Existing comps are grandfathered as reviewed: for them we can't know, and
-- nagging established organizers about a step they've effectively done is
-- worse than missing the nag on a genuinely fresh comp (any comp created
-- after this ships starts at 0).
ALTER TABLE comp ADD COLUMN settings_reviewed INTEGER NOT NULL DEFAULT 0;
UPDATE comp SET settings_reviewed = 1;
