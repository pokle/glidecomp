// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * The public sample competition. The seed script (web/scripts/seed-sample-comp.ts)
 * creates/updates a comp with exactly this name; the 3dvis endpoint resolves it
 * by name so the sample page never needs to know the environment-specific id.
 *
 * Changing this string is a data migration, not just a code edit: the seeder
 * matches on the name, so against an already-seeded database it would INSERT a
 * second comp under a new comp_id (breaking /comp/:id links) and leave the old
 * row orphaned, while `sample-3dvis` 404s until a comp with the new name exists.
 * Run `UPDATE comp SET name='<new>' WHERE name='<old>';` on each environment
 * (local D1 + production) before deploying the change.
 */
export const SAMPLE_COMP_NAME = "Corryong Cup 2026";
