#!/usr/bin/env bun
// Copyright (c) 2026, Tushar Pokle.  All rights reserved.
/**
 * Import the CIVL/WPRS world pilot rankings from civlcomps.org into D1.
 *
 * CIVL publishes a ranking per discipline at the start of each month. This
 * fetches the current one for every list and writes it to `pilot_ranking`
 * (migration 0025) — a standalone table with no UI and no other reader yet.
 * Nothing here matches pilots to GlideComp accounts or competitions; that is
 * deliberately a separate job.
 *
 * Usage:
 *   bun run civl-rankings                          # local dev D1
 *   bun run civl-rankings --remote                 # production D1
 *   bun run civl-rankings hang-gliding-class-1-xc  # just these lists
 *   bun run civl-rankings --dry-run                # fetch + parse, write nothing
 *   bun run civl-rankings --force                  # re-import a month already stored
 *   REQUEST_DELAY_MS=6000 bun run civl-rankings    # be even gentler
 *
 * ── Polling without hammering ──────────────────────────────────────────────
 *
 * The GitHub Actions workflow runs this DAILY, because CIVL's publication day
 * moves around. On the ~30 days a month when there is nothing new it must cost
 * civlcomps.org nothing, so the decision to fetch is made in three widening
 * steps:
 *
 *   1. One D1 read gives the stored ranking_date per list. If a list's stored
 *      date is already on or after the 1st of the current month, it is skipped
 *      with NO HTTP REQUEST AT ALL. That is the steady state.
 *   2. Otherwise fetch that list's pilots page (one GET) and read the periods
 *      array it embeds. If the newest published period isn't newer than what's
 *      stored, stop — we'll look again tomorrow.
 *   3. Only then run the export, which is what actually costs them work.
 *
 * Step 2 asks "is there anything newer?", never "is this month's out yet?".
 * CIVL publishing a week late, or skipping a month, both fall out correctly.
 *
 * ── The export protocol ────────────────────────────────────────────────────
 *
 * The Excel button is an async job, which is why watching it in devtools shows
 * two requests. Reproduced here:
 *
 *   GET  /ranking/<slug>/pilots     → PHPSESSID + _csrf cookies, the CSRF token
 *                                     in <meta name="csrf-token">, the current
 *                                     ranking id, and the periods array
 *   POST /ranking/export-new?…      → {"status":"new","hash":"…","url":false}
 *                                     CSRF goes in the X-CSRF-Token HEADER; it
 *                                     is not in the form body
 *   GET  /ranking/export-new?…&hash → poll every 5s until status "completed",
 *                                     which carries the download url
 *   GET  /ranking/download-file?…   → the .xlsx
 *
 * `format=csv` is accepted and ignored — the job returns a spreadsheet either
 * way — hence the little xlsx reader in lib/xlsx-reader.ts.
 *
 * ── Writing ────────────────────────────────────────────────────────────────
 *
 * Retention is latest-only. The new month is INSERTed first and the older rows
 * deleted after, never the other way round: the chunks go through separate
 * `wrangler d1 execute` invocations, so delete-first would leave a list empty
 * if the run died in between.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readSheetRows } from './lib/xlsx-reader';
import { parseRankingSheet, type RankingPilot } from './lib/civl-ranking-sheet';
import { createD1Client, q, type D1Client } from './lib/wrangler-d1';
import { currentMonthStart, hasNewer, needsCheck } from './lib/ranking-schedule';

// --- configuration ---------------------------------------------------------

const BASE_URL = 'https://civlcomps.org';
const WRANGLER_CONFIG_PATH = 'web/workers/competition-api/wrangler.toml';

/**
 * Every ranking list on https://civlcomps.org/rankings, by URL slug. Adding a
 * discipline is one line. The slug is the row's identity in D1 — the sheet's
 * own `name` ("HG Class 1") is display text and two lists can share a region
 * and selection, so it cannot be the key.
 */
const LISTS: readonly string[] = [
  'hang-gliding-class-1-xc',
  'hang-gliding-class-1-sport-xc',
  'hang-gliding-class-2-xc',
  'hang-gliding-class-5-xc',
  'paragliding-xc',
  'paragliding-xc-sport',
  'paragliding-accuracy',
  'paragliding-aerobatics',
  'paragliding-acro-syncro',
  'paragliding-hike-fly',
];

/** Delay between outbound requests — roughly human pace. Same knob and default
 *  as download-airscore-comp.ts. */
const BASE_DELAY_MS = Number(process.env.REQUEST_DELAY_MS ?? 3500);
/** How often to ask whether the export job has finished. The site's own JS
 *  uses exactly this interval. */
const POLL_INTERVAL_MS = 5000;
/** Give up on one list's export after this long and carry on with the others. */
const POLL_TIMEOUT_MS = 5 * 60 * 1000;
/** Rows per INSERT statement. Keeps each temp SQL file well clear of any
 *  statement-size limit while still being a handful of round trips. */
const ROWS_PER_INSERT = 200;
/** Statements per `wrangler d1 execute --file` invocation. */
const INSERTS_PER_FILE = 10;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

// --- arguments -------------------------------------------------------------

const ARGS = process.argv.slice(2);
const REMOTE = ARGS.includes('--remote');
const DRY_RUN = ARGS.includes('--dry-run');
const FORCE = ARGS.includes('--force');
const ARG_SLUGS = ARGS.filter((a) => !a.startsWith('--'));

const TARGET_LISTS = ARG_SLUGS.length ? ARG_SLUGS : LISTS;
for (const slug of TARGET_LISTS) {
  if (!LISTS.includes(slug)) {
    throw new Error(`Unknown ranking list "${slug}". Known lists:\n  ${LISTS.join('\n  ')}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- http ------------------------------------------------------------------

/**
 * A session against civlcomps.org: a cookie jar plus the page's CSRF token.
 *
 * Bun's fetch does not manage cookies, and the export flow needs the PHP
 * session to persist across four requests. The curl fallback mirrors
 * download-airscore-comp.ts — in sandboxes with a TLS-terminating egress proxy
 * Bun's fetch can fail the handshake where curl, which honours the same proxy
 * env vars and the system CA store, succeeds.
 */
class CivlSession {
  private cookies = new Map<string, string>();
  private csrf = '';

  private cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private absorb(setCookie: string[]): void {
    for (const line of setCookie) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { 'User-Agent': UA, ...extra };
    const cookie = this.cookieHeader();
    if (cookie) h.Cookie = cookie;
    return h;
  }

  /** curl fallback: same headers, same cookies, returns the raw body. */
  private curl(url: string, extra: Record<string, string>, form?: string): Buffer {
    // Response headers go to a temp file, not /dev/stderr: with stderr piped
    // by spawnSync, curl fails the whole transfer with exit 23 ("failed
    // writing received data") rather than interleaving them.
    const headerFile = join(mkdtempSync(join(tmpdir(), 'civl-')), 'headers.txt');
    const args = ['-sSL', '--max-time', '120', '-D', headerFile];
    for (const [k, v] of Object.entries(this.headers(extra))) args.push('-H', `${k}: ${v}`);
    if (form !== undefined) args.push('--data', form);
    args.push(url);
    const res = spawnSync('curl', args, { maxBuffer: 256 * 1024 * 1024 });
    if (res.status !== 0) {
      throw new Error(`curl ${url} → exit ${res.status}: ${res.stderr?.toString()}`);
    }
    // Pick the session cookies out of the dumped headers so a curl-served
    // request still advances the jar.
    const dumped = existsSync(headerFile) ? readFileSync(headerFile, 'utf-8') : '';
    rmSync(dirname(headerFile), { recursive: true, force: true });
    this.absorb(
      dumped
        .split(/\r?\n/)
        .filter((l) => /^set-cookie:/i.test(l))
        .map((l) => l.slice(l.indexOf(':') + 1).trim()),
    );
    return res.stdout;
  }

  async request(
    url: string,
    opts: { form?: string; extraHeaders?: Record<string, string> } = {},
  ): Promise<Buffer> {
    const extra: Record<string, string> = { ...opts.extraHeaders };
    if (opts.form !== undefined) {
      extra['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    }
    try {
      const res = await fetch(url, {
        method: opts.form === undefined ? 'GET' : 'POST',
        headers: this.headers(extra),
        body: opts.form,
        redirect: 'follow',
      });
      this.absorb(res.headers.getSetCookie?.() ?? []);
      if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      // An HTTP error is a real answer and must not be retried through curl —
      // only a socket-level failure means "this transport can't reach them".
      if (err instanceof Error && /HTTP \d{3}$/.test(err.message)) throw err;
      return this.curl(url, extra, opts.form);
    }
  }

  /**
   * Load a list's pilots page: seeds the session cookies and returns what the
   * page tells us about the list.
   */
  async loadList(slug: string): Promise<{ rankingId: number; periods: Period[] }> {
    const html = (await this.request(`${BASE_URL}/ranking/${slug}/pilots`)).toString('utf-8');

    const csrf = html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/)?.[1];
    if (!csrf) throw new Error(`${slug}: no csrf-token meta tag — did the page layout change?`);
    this.csrf = csrf;

    const rankingId = Number(
      html.match(/id="search-ranking_id"[^>]*\svalue="(\d+)"/)?.[1] ??
        html.match(/name="ranking_id"[^>]*\svalue="(\d+)"/)?.[1],
    );
    if (!Number.isInteger(rankingId)) throw new Error(`${slug}: no current ranking id on the page`);

    // The page embeds every published period for this list as a JS literal:
    //   const data = [{"id":1914,"name":"Jul","fullname":"Jul 2026",
    //                  "date":"2026-07-01","year":2026}, …]
    const raw = html.match(/const\s+data\s*=\s*(\[[\s\S]*?\]);/)?.[1];
    if (!raw) throw new Error(`${slug}: no ranking-periods array on the page`);
    const periods = JSON.parse(raw) as Period[];
    if (!periods.length) throw new Error(`${slug}: ranking-periods array is empty`);

    return { rankingId, periods };
  }

  /** Run the async export job for one ranking period and return the .xlsx. */
  async exportWorkbook(slug: string, rankingId: number): Promise<Buffer> {
    const endpoint =
      `${BASE_URL}/ranking/export-new?rankingId=${rankingId}` +
      `&type=export_pilots_ranking&format=xlsx&async=1`;
    const referer = `${BASE_URL}/ranking/${slug}/pilots`;
    const ajax = {
      'X-Requested-With': 'XMLHttpRequest',
      Referer: referer,
      Accept: 'application/json, text/javascript, */*; q=0.01',
    };

    // The site's own search form, unfiltered: whole world, every category.
    const form = new URLSearchParams([
      ['search[nation_id]', ''],
      ['profile_id', ''],
      ['ranking_id', String(rankingId)],
      ['search[continent_id]', ''],
      ['search[continent_id]', '0'],
      ['search[scoringCategory]', ''],
      ['search[scoringCategory]', '0'],
    ]).toString();

    const started = JSON.parse(
      (
        await this.request(endpoint, {
          form,
          extraHeaders: { ...ajax, 'X-CSRF-Token': this.csrf },
        })
      ).toString('utf-8'),
    ) as ExportStatus;

    let status = started;
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (status.status !== 'completed') {
      if (status.status === 'failed' || status.status === 'cancelled') {
        throw new Error(`${slug}: export ${status.status}${status.error ? ` — ${status.error}` : ''}`);
      }
      if (Date.now() > deadline) {
        throw new Error(`${slug}: export still "${status.status}" after ${POLL_TIMEOUT_MS / 1000}s`);
      }
      await sleep(POLL_INTERVAL_MS);
      status = JSON.parse(
        (
          await this.request(`${endpoint}&hash=${encodeURIComponent(status.hash)}`, {
            extraHeaders: ajax,
          })
        ).toString('utf-8'),
      ) as ExportStatus;
    }
    if (!status.url) throw new Error(`${slug}: export completed without a download url`);

    await sleep(BASE_DELAY_MS);
    const body = await this.request(status.url, { extraHeaders: { Referer: referer } });
    // A .xlsx is a zip; anything else means we were handed an error page.
    if (body.length < 4 || body[0] !== 0x50 || body[1] !== 0x4b) {
      throw new Error(`${slug}: download was not a spreadsheet (${body.length} bytes)`);
    }
    return body;
  }
}

interface Period {
  id: number;
  name: string;
  fullname: string;
  /** ISO 'YYYY-MM-DD'. */
  date: string;
  year: number;
}

interface ExportStatus {
  status: 'new' | 'processing' | 'completed' | 'failed' | 'cancelled';
  hash: string;
  url: string | false;
  error?: string;
}

// --- storage ---------------------------------------------------------------

/** The ranking_date currently stored for each list. */
function storedDates(db: D1Client): Map<string, string> {
  const rows = db.queryRows(
    'SELECT ranking_slug, MAX(ranking_date) AS ranking_date FROM pilot_ranking GROUP BY ranking_slug',
  );
  return new Map(rows.map((r) => [String(r.ranking_slug), String(r.ranking_date)]));
}

interface WriteArgs {
  slug: string;
  rankingId: number;
  meta: { ranking_date: string; name: string; region: string; selection: string };
  pilots: RankingPilot[];
  fetchedAt: string;
}

function writeRanking(db: D1Client, { slug, rankingId, meta, pilots, fetchedAt }: WriteArgs): void {
  const columns =
    '(ranking_slug, civl_ranking_id, ranking_date, ranking_name, region, selection, ' +
    '"rank", civl_id, pilot_name, gender, nation, points, fetched_at)';

  const values = pilots.map(
    (p) =>
      `(${q(slug)},${rankingId},${q(meta.ranking_date)},${q(meta.name)},${q(meta.region)},` +
      `${q(meta.selection)},${p.rank},${q(p.civl_id)},${q(p.name)},${q(p.gender)},` +
      `${q(p.nation)},${p.points},${q(fetchedAt)})`,
  );

  // INSERT OR REPLACE so a --force re-import of a month already stored updates
  // in place instead of colliding with the unique index.
  const statements: string[] = [];
  for (let i = 0; i < values.length; i += ROWS_PER_INSERT) {
    statements.push(
      `INSERT OR REPLACE INTO pilot_ranking ${columns} VALUES\n` +
        values.slice(i, i + ROWS_PER_INSERT).join(',\n') +
        ';',
    );
  }
  for (let i = 0; i < statements.length; i += INSERTS_PER_FILE) {
    db.execSql(statements.slice(i, i + INSERTS_PER_FILE).join('\n'));
  }

  // Only now drop the previous month. See the header: the reverse order can
  // leave a list empty if the run dies between the two invocations.
  db.execSql(
    `DELETE FROM pilot_ranking WHERE ranking_slug = ${q(slug)} ` +
      `AND ranking_date <> ${q(meta.ranking_date)};`,
  );
}

// --- main ------------------------------------------------------------------

async function main(): Promise<void> {
  const db = createD1Client(WRANGLER_CONFIG_PATH, REMOTE);
  const where = REMOTE ? 'production' : 'local dev';
  console.log(`CIVL rankings → ${where} D1${DRY_RUN ? ' (dry run, nothing will be written)' : ''}`);

  const stored = DRY_RUN && REMOTE ? new Map<string, string>() : storedDates(db);
  const monthStart = currentMonthStart();
  const session = new CivlSession();
  const fetchedAt = new Date().toISOString();

  let imported = 0;
  let skipped = 0;
  const failures: string[] = [];
  let firstRequest = true;

  for (const slug of TARGET_LISTS) {
    const have = stored.get(slug);

    // Step 1 — the cheap skip. Already have this month: no request at all.
    if (!needsCheck(have, monthStart, FORCE)) {
      console.log(`  ${slug}: up to date (${have})`);
      skipped++;
      continue;
    }

    try {
      if (!firstRequest) await sleep(BASE_DELAY_MS);
      firstRequest = false;

      // Step 2 — one page load. Is there anything newer than what we hold?
      const { rankingId, periods } = await session.loadList(slug);
      const newest = periods.reduce((a, b) => (b.date > a.date ? b : a));
      if (!hasNewer(have, newest.date, FORCE)) {
        console.log(`  ${slug}: nothing newer published yet (have ${have}, latest ${newest.date})`);
        skipped++;
        continue;
      }
      if (newest.id !== rankingId) {
        // The page's selected period should be the newest one. If it isn't,
        // trust the periods array and say so.
        console.warn(
          `  ${slug}: page has ranking ${rankingId} selected but ${newest.id} (${newest.fullname}) is newest`,
        );
      }

      // Step 3 — the expensive bit.
      console.log(`  ${slug}: exporting ${newest.fullname} (ranking ${newest.id})…`);
      await sleep(BASE_DELAY_MS);
      const workbook = await session.exportWorkbook(slug, newest.id);
      const { meta, pilots } = parseRankingSheet(readSheetRows(workbook));

      // The sheet's own metadata is the authority for what we store; if it
      // disagrees with the period we asked for, something is wrong enough that
      // guessing would be worse than stopping.
      if (meta.ranking_date !== newest.date) {
        throw new Error(
          `sheet is dated ${meta.ranking_date} but ${newest.date} was requested`,
        );
      }

      console.log(
        `  ${slug}: ${pilots.length} pilots, ${meta.name} / ${meta.region} / ${meta.selection}, ${meta.ranking_date}`,
      );
      if (DRY_RUN) {
        console.log(`    (dry run) top 3: ${pilots.slice(0, 3).map((p) => `${p.rank} ${p.name}`).join(', ')}`);
      } else {
        writeRanking(db, { slug, rankingId: newest.id, meta, pilots, fetchedAt });
      }
      imported++;
    } catch (err) {
      // One list failing must not cost the other nine. The workflow still goes
      // red at the end, and tomorrow's run retries only what's missing.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ${slug}: FAILED — ${msg}`);
      failures.push(slug);
    }
  }

  console.log(
    `\nDone: ${imported} imported, ${skipped} already current, ${failures.length} failed.`,
  );
  if (failures.length) {
    console.error(`Failed lists: ${failures.join(', ')}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
