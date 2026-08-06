/**
 * GET /api/civl-rankings.csv — the whole `pilot_ranking` table as CSV.
 *
 * A verification hatch, not a product surface. The rankings are imported by a
 * GitHub Actions cron (`web/scripts/fetch-civl-rankings.ts`) into a table with
 * no UI and no other reader, so without this there is no way to answer "did
 * last month's import actually land, and does it match civlcomps.org?" short
 * of `wrangler d1 execute` against production. It is served at
 * `/civl-rankings.csv` via a Pages Function and linked from nowhere.
 *
 * Public and unauthenticated, deliberately: every row is a verbatim copy of a
 * list anyone can download from civlcomps.org, so there is nothing here to
 * protect. What DOES need protecting is the query — a full table scan of ~20k
 * rows, and D1 bills by rows read. Two things bound that:
 *
 *   * a SHORT edge cache (`caches.default` plus the matching `Cache-Control`),
 *     which bounds a hammering client to one D1 read a minute. Short and not
 *     long on purpose: the whole point of this endpoint is checking whether an
 *     import landed, and an hour-long cache answers that question with
 *     pre-import data — which is worse than no endpoint at all;
 *   * rows are fetched in pages and streamed, so neither the worker's memory
 *     nor D1's per-query result limit scales with the table.
 *
 * `X-Robots-Tag: noindex` because a 1.5 MB CSV of pilots' names and nations is
 * not something to hand a crawler; `?slug=` narrows the dump to one list.
 */
import { Hono } from "hono";
import type { BareEnv, Env } from "../env";

/** Rows per D1 query while streaming. Large enough that the whole table is a
 *  handful of queries, small enough that one page is a small allocation. */
const PAGE_SIZE = 2000;

/** How long the edge may serve a copy without asking D1 again. Deliberately
 *  short: long enough to absorb a burst, short enough that "did the import
 *  land?" is answered by the current table and not by yesterday's. */
const CACHE_SECONDS = 60;

const COLUMNS = [
  "ranking_slug",
  "ranking_name",
  "region",
  "selection",
  "ranking_date",
  "civl_ranking_id",
  "rank",
  "civl_id",
  "pilot_name",
  "gender",
  "nation",
  "points",
  "fetched_at",
] as const;

/** RFC 4180: quote when the value could otherwise break the row, double inner
 *  quotes. Pilot names carry commas and parentheses; nothing here has a
 *  newline, but quoting on one costs nothing and removes the question.
 *
 *  `pilot_name`/`ranking_name`/`region`/`selection`/`nation` are copied
 *  verbatim from civlcomps.org's own export (see module header) — a name
 *  Excel/Sheets would read as a formula (leading `=`/`+`/`-`/`@`, or a tab/CR
 *  that survives quoting) is prefixed with `'` before quoting, so opening this
 *  attachment can never execute one. */
function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export const civlRankingsRoutes = new Hono<BareEnv>().get(
  "/api/civl-rankings.csv",
  async (c) => {
    // `caches.default` is a Workers extension the DOM lib doesn't declare, and
    // the root tsconfig compiles this file with lib.dom.
    const cache = (caches as unknown as { default: Cache }).default;
    const cacheKey = new Request(new URL(c.req.url).toString(), { method: "GET" });
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    // Optional narrowing to one list, e.g. ?slug=hang-gliding-class-1-xc.
    const slug = c.req.query("slug") ?? "";
    const where = slug ? "WHERE ranking_slug = ?" : "";

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          controller.enqueue(encoder.encode(`${COLUMNS.join(",")}\n`));
          for (let offset = 0; ; offset += PAGE_SIZE) {
            // Ordered so the dump is stable between requests and reads the way
            // the source list does: list, then month, then rank.
            const sql =
              `SELECT ${COLUMNS.join(", ")} FROM pilot_ranking ${where} ` +
              `ORDER BY ranking_slug, ranking_date, "rank", civl_id ` +
              `LIMIT ${PAGE_SIZE} OFFSET ${offset}`;
            const stmt = slug ? c.env.DB.prepare(sql).bind(slug) : c.env.DB.prepare(sql);
            const { results } = await stmt.all<Record<string, unknown>>();
            if (!results.length) break;
            let chunk = "";
            for (const row of results) {
              chunk += COLUMNS.map((col) => csvCell(row[col])).join(",") + "\n";
            }
            controller.enqueue(encoder.encode(chunk));
            if (results.length < PAGE_SIZE) break;
          }
          controller.close();
        } catch (err) {
          // The status line is long gone by the time a later page fails, so
          // the only honest signal left is to break the body. A truncated CSV
          // that ends mid-row is better than one that ends cleanly and short.
          console.error("civl-rankings.csv stream failed", err);
          controller.error(err);
        }
      },
    });

    const response = new Response(stream, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="civl-rankings.csv"',
        "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
        "X-Robots-Tag": "noindex",
      },
    });

    // Cache a copy without consuming the body the client is waiting on.
    c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
);
