#!/usr/bin/env bun
// Copyright (c) 2026, Tushar Pokle.  All rights reserved.
/**
 * Fill the local `pilot_ranking` table, so the roster editor's CIVL fill
 * buttons have something to fill from.
 *
 * A fresh database has none: `bun run fresh-dev` wipes D1, and the real import
 * (`bun run civl-rankings`) runs as a daily GitHub Actions cron against
 * production, not here. Without rankings the editor correctly says there is
 * nothing to fill from and shows no buttons — which is how this script came to
 * exist.
 *
 * It writes two things:
 *
 *   1. **A real snapshot**, `web/samples/civl-rankings/civl-rankings-2026-08.csv`
 *      — all ten lists as published for August 2026, taken verbatim from
 *      production's own `/civl-rankings.csv` dump. Every row keeps its
 *      `civl_ranking_id` and `fetched_at`, so a locally-filled roster carries
 *      exactly the provenance production would have given it.
 *   2. **A synthetic list** of invented pilots (`sample-world-ranking`, never
 *      one of CIVL's ten) that `e2e/civl-rankings.spec.ts` matches against.
 *      The e2e cannot key on the real data: it is a point-in-time copy that
 *      will be refreshed, and its ranks move every month.
 *
 * What it deliberately does NOT do is invent rankings for the real pilots on
 * the seeded sample comps. A fabricated number against a real name, displayed
 * with a list and a month beside it, is indistinguishable from a published one.
 * Sample-comp pilots who are genuinely in a CIVL list get matched from the
 * snapshot like anyone else; the rest stay unranked, which is the truth.
 *
 * Local only — there is deliberately no `--remote`.
 *
 * Usage:
 *   bun run seed-civl-rankings                 # bundled snapshot + fixture
 *   bun run seed-civl-rankings --file <path>   # a fresher dump, same format
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createD1Client, q, REPO_ROOT, type D1Client } from './lib/wrangler-d1';

/** Repo-relative, like fetch-civl-rankings.ts — the helper resolves it. */
const WRANGLER_CONFIG_PATH = 'web/workers/competition-api/wrangler.toml';

const DEFAULT_SNAPSHOT = 'web/samples/civl-rankings/civl-rankings-2026-08.csv';

/** Not one of CIVL's ten list slugs, and it must never become one. */
const FIXTURE_SLUG = 'sample-world-ranking';
const FIXTURE_NAME = 'Sample World Ranking';

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
const FIXTURE_PILOTS: { name: string; civl_id: string }[] = [
  { name: 'Ada Thermal', civl_id: '9000001' },
  { name: 'Bruno Ridge', civl_id: '9000002' },
  { name: 'Cleo Vario', civl_id: '9000003' },
  { name: 'Dev Glide', civl_id: '9000004' },
  { name: 'Twin Ambiguity', civl_id: '9000005' },
  { name: 'Twin Ambiguity', civl_id: '9000006' },
];

/** Columns of `/civl-rankings.csv`, in the order that route writes them. */
const COLUMNS = [
  'ranking_slug',
  'ranking_name',
  'region',
  'selection',
  'ranking_date',
  'civl_ranking_id',
  'rank',
  'civl_id',
  'pilot_name',
  'gender',
  'nation',
  'points',
  'fetched_at',
] as const;

type Row = Record<(typeof COLUMNS)[number], string>;

/** Rows per INSERT, and INSERTs per wrangler invocation — as fetch-civl-rankings. */
const ROWS_PER_INSERT = 200;
const INSERTS_PER_FILE = 10;

// ── CSV ─────────────────────────────────────────────────────────────────────

/** Split a CSV line into cells, honouring quotes and doubled quotes. */
function parseLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else inQuotes = false;
      } else current += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      cells.push(current);
      current = '';
    } else current += ch;
  }
  cells.push(current);
  return cells;
}

/**
 * The `'` that `routes/civl-rankings.ts` prefixes onto a value starting
 * `=`/`+`/`-`/`@` so a spreadsheet cannot execute it. It is an artefact of the
 * download, not part of the name, so re-importing our own dump must remove it
 * — otherwise a pilot called "-Ana" comes back as "'-Ana" and stops matching.
 */
function stripFormulaGuard(value: string): string {
  return /^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value;
}

function readSnapshot(path: string): Row[] {
  const text = readFileSync(join(REPO_ROOT, path), 'utf-8').replace(/^﻿/, '');
  // Quoted newlines are possible in principle; none of these columns has ever
  // carried one, and a row that did would be a sign the dump is not ours.
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) throw new Error(`${path}: no data rows`);

  const header = parseLine(lines[0]);
  for (const column of COLUMNS) {
    if (!header.includes(column)) {
      throw new Error(
        `${path}: missing column "${column}". Expected a /civl-rankings.csv dump:\n  ${COLUMNS.join(',')}`,
      );
    }
  }

  const rows: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseLine(lines[i]);
    const row = Object.fromEntries(
      header.map((name, c) => [name, stripFormulaGuard(cells[c] ?? '')]),
    ) as Row;
    // Numbers are interpolated unquoted, so anything that is not one has to
    // fail here rather than reaching the SQL.
    if (!/^\d+$/.test(row.rank) || !Number.isFinite(Number(row.points))) {
      throw new Error(`${path}: line ${i + 1} has a non-numeric rank/points`);
    }
    if (!row.ranking_slug || !row.civl_id || !row.pilot_name) {
      throw new Error(`${path}: line ${i + 1} is missing a slug, id or name`);
    }
    rows.push(row);
  }
  return rows;
}

// ── Writing ─────────────────────────────────────────────────────────────────

function valuesTuple(row: Row): string {
  return (
    `(${q(row.ranking_slug)}, ${Number(row.civl_ranking_id) || 0}, ${q(row.ranking_date)}, ` +
    `${q(row.ranking_name)}, ${q(row.region)}, ${q(row.selection)}, ${Number(row.rank)}, ` +
    `${q(row.civl_id)}, ${q(row.pilot_name)}, ${q(row.gender)}, ${q(row.nation)}, ` +
    `${Number(row.points) || 0}, ${q(row.fetched_at)})`
  );
}

function insertRows(db: D1Client, rows: Row[]): void {
  const statements: string[] = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
    const tuples = rows.slice(i, i + ROWS_PER_INSERT).map(valuesTuple).join(',\n  ');
    statements.push(
      `INSERT OR REPLACE INTO pilot_ranking
         (ranking_slug, civl_ranking_id, ranking_date, ranking_name, region,
          selection, "rank", civl_id, pilot_name, gender, nation, points, fetched_at)
       VALUES\n  ${tuples};`,
    );
  }
  for (let i = 0; i < statements.length; i += INSERTS_PER_FILE) {
    db.execSql(statements.slice(i, i + INSERTS_PER_FILE).join('\n'));
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const fileArg = args.indexOf('--file');
const snapshotPath = fileArg === -1 ? DEFAULT_SNAPSHOT : args[fileArg + 1];
if (!snapshotPath) throw new Error('--file needs a path');

const snapshot = readSnapshot(snapshotPath);

const fetchedAt = snapshot[0].fetched_at;
const fixture: Row[] = FIXTURE_PILOTS.map((pilot, i) => ({
  ranking_slug: FIXTURE_SLUG,
  ranking_name: FIXTURE_NAME,
  region: 'World',
  selection: 'Overall',
  // Dated with the snapshot's month so the two lists read as contemporaries
  // in the picker rather than one looking stale.
  ranking_date: snapshot[0].ranking_date,
  civl_ranking_id: '0',
  rank: String(i + 1),
  civl_id: pilot.civl_id,
  pilot_name: pilot.name,
  gender: '',
  nation: 'Australia',
  points: String(1000 - (i + 1) * 3),
  fetched_at: fetchedAt,
}));

const db = createD1Client(WRANGLER_CONFIG_PATH, false);

// Replace whole lists rather than emptying the table: a developer who has run
// the real importer for one list keeps it unless this snapshot also carries it.
const slugs = [...new Set([...snapshot.map((r) => r.ranking_slug), FIXTURE_SLUG])];
db.execSql(
  slugs.map((slug) => `DELETE FROM pilot_ranking WHERE ranking_slug = ${q(slug)};`).join('\n'),
);

insertRows(db, snapshot);
insertRows(db, fixture);

const listCount = new Set(snapshot.map((r) => r.ranking_slug)).size;
console.log(
  `Seeded ${snapshot.length} ranked pilots across ${listCount} CIVL lists ` +
    `(${snapshot[0].ranking_date}) from ${snapshotPath}, plus the ` +
    `"${FIXTURE_NAME}" fixture (${fixture.length} pilots).`,
);
console.log('Fresher rankings: bun run civl-rankings (imports live from civlcomps.org).');
