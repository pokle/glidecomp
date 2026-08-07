#!/usr/bin/env bun
// Copyright (c) 2026, Tushar Pokle.  All rights reserved.
/**
 * Put a SYNTHETIC world ranking list into the local `pilot_ranking` table, so
 * the roster editor's CIVL fill buttons have something to fill from.
 *
 * The real rankings arrive from civlcomps.org via `bun run civl-rankings`,
 * which a GitHub Actions cron runs daily against production. Neither is any
 * use here: a fresh local database has no rankings at all (so the buttons say
 * "nothing imported yet" and there is nothing to try), and a real import is a
 * network round trip to somebody else's servers whose contents change every
 * month — no test can assert against that.
 *
 * So this writes a list that is unmistakably not CIVL's:
 *
 *   * its slug is `sample-world-ranking`, which is not one of the ten real
 *     ones, so it can never overwrite or be confused with an imported list —
 *     run `bun run civl-rankings` as well and you get both, side by side in
 *     the picker;
 *   * it is named "Sample World Ranking" wherever it is displayed, including
 *     on a roster that has been filled from it. A fabricated ranking that
 *     looked official is exactly the thing that must not exist.
 *
 * It ranks two sets of pilots:
 *
 *   1. every pilot already registered in this database, so the bundled sample
 *      comps light up and the feature can be tried on a real-looking roster;
 *   2. a fixed handful of invented pilots the e2e spec registers by name, so
 *      that suite has something deterministic to match against.
 *
 * Ranks are assigned by name order, which makes a re-run produce byte-identical
 * rows. Local only — there is deliberately no `--remote`.
 *
 * Usage:
 *   bun run seed-civl-rankings
 */

import { createD1Client, q } from './lib/wrangler-d1';

/** Repo-relative, like fetch-civl-rankings.ts — the helper resolves it. */
const WRANGLER_CONFIG_PATH = 'web/workers/competition-api/wrangler.toml';

/** Not one of CIVL's ten list slugs, and it must never become one. */
const SLUG = 'sample-world-ranking';
const LIST_NAME = 'Sample World Ranking';

/**
 * The e2e's pilots. `e2e/civl-rankings.spec.ts` registers a roster of exactly
 * these names, so changing one here fails that spec — which is the point: the
 * two halves of a fixture that must agree should not be able to drift
 * silently.
 *
 * "Twin Ambiguity" appears twice on purpose. Two ranked pilots answering to
 * one name is what the matcher must refuse to resolve, and a fixture without
 * it cannot prove the refusal.
 */
const E2E_PILOTS: { name: string; civl_id: string }[] = [
  { name: 'Ada Thermal', civl_id: '9000001' },
  { name: 'Bruno Ridge', civl_id: '9000002' },
  { name: 'Cleo Vario', civl_id: '9000003' },
  { name: 'Dev Glide', civl_id: '9000004' },
  { name: 'Twin Ambiguity', civl_id: '9000005' },
  { name: 'Twin Ambiguity', civl_id: '9000006' },
];

/** Synthetic ids start well above CIVL's own (five to six digits). */
const SYNTHETIC_ID_BASE = 9_100_000;

/** The 1st of the current month — the shape CIVL dates a snapshot with. */
function firstOfThisMonth(): string {
  const now = new Date();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${now.getUTCFullYear()}-${month}-01`;
}

const db = createD1Client(WRANGLER_CONFIG_PATH, false);

const rankingDate = firstOfThisMonth();

// Everyone this database already knows about. Their own CIVL ID is reused
// where they have one, so "Fill rankings" can place them without the roster
// being touched first; the rest get a synthetic id for "Fill CIVL IDs" to
// find by name.
const registered = db.queryRows(
  `SELECT DISTINCT registered_pilot_name AS name, registered_pilot_civl_id AS civl_id
   FROM comp_pilot
   WHERE registered_pilot_name <> ''
   ORDER BY registered_pilot_name`,
) as { name: string; civl_id: string | null }[];

interface Row {
  name: string;
  civl_id: string;
}

const rows: Row[] = [...E2E_PILOTS];
const namesTaken = new Set(E2E_PILOTS.map((p) => p.name.toLowerCase()));
const idsTaken = new Set(E2E_PILOTS.map((p) => p.civl_id));

let synthetic = SYNTHETIC_ID_BASE;
for (const pilot of registered) {
  // A name the fixture already ranks stays the fixture's — the e2e asserts on
  // those rows, and a seeded comp happening to hold the same name must not
  // move them.
  if (namesTaken.has(pilot.name.toLowerCase())) continue;
  const id = pilot.civl_id?.trim() || String(synthetic++);
  if (idsTaken.has(id)) continue;
  namesTaken.add(pilot.name.toLowerCase());
  idsTaken.add(id);
  rows.push({ name: pilot.name, civl_id: id });
}

// By name, so a re-run assigns the same rank to the same pilot.
rows.sort((a, b) => a.name.localeCompare(b.name) || a.civl_id.localeCompare(b.civl_id));

const fetchedAt = new Date().toISOString();
const values = rows
  .map((row, i) => {
    const rank = i + 1;
    // Points descend with rank, the way a real list's do — the column exists
    // because rank ties are pervasive and cannot order a list on their own.
    const points = (1000 - rank * 3).toFixed(1);
    return (
      `(${q(SLUG)}, 0, ${q(rankingDate)}, ${q(LIST_NAME)}, 'World', 'Overall', ` +
      `${rank}, ${q(row.civl_id)}, ${q(row.name)}, '', 'Australia', ${points}, ${q(fetchedAt)})`
    );
  })
  .join(',\n  ');

db.execSql(`DELETE FROM pilot_ranking WHERE ranking_slug = ${q(SLUG)};`);
if (rows.length > 0) {
  db.execSql(
    `INSERT INTO pilot_ranking
       (ranking_slug, civl_ranking_id, ranking_date, ranking_name, region,
        selection, "rank", civl_id, pilot_name, gender, nation, points, fetched_at)
     VALUES\n  ${values};`,
  );
}

console.log(
  `Seeded "${LIST_NAME}" (${SLUG}, ${rankingDate}) with ${rows.length} pilots ` +
    `— ${E2E_PILOTS.length} fixture, ${rows.length - E2E_PILOTS.length} from this database.`,
);
console.log('Real rankings: bun run civl-rankings (imports the ten CIVL lists).');
