/**
 * GET /api/comp/search — one search box over competitions, tasks, routes and
 * pilots, answered as the hierarchy those things live in.
 *
 * "elliot KANGCK" is the query this exists for: two turnpoint codes, no
 * competition, no task, no pilot — and the answer is the tasks that fly
 * through both, under the competitions they belong to. The words are matched
 * against an FTS5 index (see ../search-index.ts and migration 0026), where a
 * task's turnpoints are their own weighted column, because where a task goes
 * identifies it and "Task 3" does not.
 *
 * ── The rule that keeps the response small ────────────────────────────────
 * Only things that MATCHED are listed; a level that did not match collapses
 * to a count and a link. So a turnpoint query returns comps → the matching
 * tasks → "47 pilots", not forty-seven pilot rows nobody asked for; a pilot's
 * name returns comps → the tasks they flew → them. Both ends of the hierarchy
 * stay navigable without the payload growing with the size of the field.
 *
 * Public and unauthenticated, like the lookup endpoint next door, so every
 * dimension of the work it can be asked to do is capped, and `test` comps
 * stay invisible to anyone who cannot already see them.
 */
import { Hono } from "hono";
import type { AuthUser, PublicEnv } from "../env";
import { encodeId } from "../sqids";
import { optionalAuth } from "../middleware/auth";
import { visibleCompsFilter } from "../comp-visibility";
import {
  searchTokens,
  buildMatchExpression,
  buildChildMatchExpression,
} from "../search-terms";
import { scheduleSearchIndexDrain, type TaskDocExtra } from "../search-index";

// ── Caps ───────────────────────────────────────────────────────────────────
// The page shows a readable handful; nothing here is a pagination boundary a
// caller can push past, because this endpoint answers to anyone.

/** Competitions in the response. */
const MAX_COMPS = 8;
/** Documents of one kind considered before the roll-up trims them. */
const HITS_PER_KIND = 60;
/** Task rows across the whole response. */
const MAX_TASKS = 24;
/** Pilot rows across the whole response. */
const MAX_PILOTS = 24;
/** Tasks one matched pilot is shown under, per competition (most recent). */
const MAX_TASKS_PER_PILOT = 3;
/** Task rows under one competition, however they got there. MAX_TASKS bounds
 *  the tasks that MATCHED; this also bounds the ones a matched pilot drags in,
 *  which is what a regular on the circuit does across a decade of events. */
const MAX_TASKS_PER_COMP = 5;
/** Flight rows read when placing matched pilots under the tasks they flew. */
const MAX_FLIGHT_ROWS = 200;
/** Documents rebuilt after answering, so the index converges on live traffic. */
const DRAIN_PASSES_PER_SEARCH = 1;

/** Column weights: title, route, body, owner. A route match is nearly as
 *  strong as a name match and far stronger than an incidental word in the
 *  metadata; the competition's name, carried by every document inside it,
 *  counts for least. */
const BM25_WEIGHTS = "10.0, 8.0, 1.0, 0.5";

interface DocHit {
  key: string;
  comp_id: number;
  task_id: number | null;
  comp_pilot_id: number | null;
  title: string;
  extra: string | null;
  sort_date: string | null;
  rank: number;
}

interface CompMetaRow {
  comp_id: number;
  name: string;
  category: string;
  test: number;
  scoring_format: string;
}

interface TaskCountRow {
  comp_id: number;
  task_count: number;
}

interface FlightRow {
  comp_pilot_id: number;
  task_id: number;
  comp_id: number;
  task_name: string;
  task_date: string;
}

interface PilotCountRow {
  task_id: number;
  pilot_count: number;
}

// ── Response ───────────────────────────────────────────────────────────────

export interface SearchPilotHit {
  comp_pilot_id: string;
  name: string;
}

export interface SearchTaskHit {
  task_id: string;
  name: string;
  task_date: string;
  /** Whether this task itself matched, or is here to carry a matched pilot. */
  matched: boolean;
  /** The turnpoints in this task's route that the query named. */
  matched_turnpoints: string[];
  /** Only the pilots the query named. Empty is normal — see the header. */
  pilots: SearchPilotHit[];
  /** Pilots with a result on this task, matched or not. */
  pilot_count: number;
}

export interface SearchCompHit {
  comp_id: string;
  name: string;
  category: string;
  test: boolean;
  scoring_format: string;
  /** Whether the competition itself matched, or only things inside it did. */
  matched: boolean;
  task_count: number;
  tasks: SearchTaskHit[];
  /** Matched pilots with no flight to sit under — registered, never flew. */
  pilots: SearchPilotHit[];
}

export interface SearchResponse {
  /** The words actually searched for, after capping. Empty means no search. */
  terms: string[];
  comps: SearchCompHit[];
  /** True when results were dropped to stay inside the caps. */
  truncated: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(",");

/**
 * The turnpoints of a task document that the query named. The FTS match has
 * already decided the task is a hit; this only decides what to show as the
 * reason, so a containment test is the right looseness — it covers the prefix
 * match FTS did on the last word.
 */
function matchedTurnpoints(extraJson: string | null, terms: string[]): string[] {
  if (!extraJson) return [];
  let extra: TaskDocExtra;
  try {
    extra = JSON.parse(extraJson) as TaskDocExtra;
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const tp of extra.turnpoints ?? []) {
    const haystack = `${tp.code} ${tp.description ?? ""}`.toLowerCase();
    if (terms.some((term) => haystack.includes(term))) {
      out.push(tp.description ? `${tp.code} (${tp.description})` : tp.code);
    }
  }
  return out;
}

/** One kind's ranked hits. */
function hitsQuery(
  db: D1Database,
  match: string,
  kind: string,
  visible: { sql: string; binds: unknown[] }
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT d.key, d.comp_id, d.task_id, d.comp_pilot_id, d.title, d.extra,
              d.sort_date, bm25(search_fts, ${BM25_WEIGHTS}) AS rank
         FROM search_fts
         JOIN search_doc d ON d.doc_id = search_fts.rowid
         JOIN comp c ON c.comp_id = d.comp_id
        WHERE search_fts MATCH ? AND d.kind = ? AND ${visible.sql}
        ORDER BY rank, d.sort_date DESC
        LIMIT ?`
    )
    .bind(match, kind, ...visible.binds, HITS_PER_KIND);
}

export const searchRoutes = new Hono<PublicEnv>().get(
  // Mounted ahead of compRoutes so this static segment wins over
  // /api/comp/:comp_id, the same way /api/comp/lookup does.
  "/api/comp/search",
  optionalAuth,
  async (c) => {
    const db = c.env.DB;
    const user = c.var.user;
    const alphabet = c.env.SQIDS_ALPHABET;
    const sqid = (id: number) => encodeId(alphabet, id);

    const terms = searchTokens(c.req.query("q"));
    const empty: SearchResponse = { terms, comps: [], truncated: false };
    if (terms.length === 0) return c.json(empty, 200, cacheHeaders(user));

    const visible = await visibleCompsFilter(db, user, "c");
    // Competitions match on their own words. Tasks and pilots additionally
    // have to match on something other than the competition they are in —
    // see buildChildMatchExpression.
    const match = buildMatchExpression(terms);
    const childMatch = buildChildMatchExpression(terms);

    // One round trip for the three kinds. Separate statements rather than one
    // ranked list sliced afterwards: a competition with two hundred pilots
    // called Smith must not crowd its own tasks out of the answer.
    let compHits: DocHit[];
    let taskHits: DocHit[];
    let pilotHits: DocHit[];
    try {
      const [comps, tasks, pilots] = await db.batch<DocHit>([
        hitsQuery(db, match, "comp", visible),
        hitsQuery(db, childMatch, "task", visible),
        hitsQuery(db, childMatch, "pilot", visible),
      ]);
      compHits = comps.results;
      taskHits = tasks.results;
      pilotHits = pilots.results;
    } catch (err) {
      // A malformed MATCH expression is the one thing here that can throw on
      // user input. buildMatchExpression quotes every token so it should be
      // unreachable — answer "nothing found" rather than 500 if it is not.
      console.error("[search] query failed", err, { match, childMatch });
      return c.json(empty, 200, cacheHeaders(user));
    }

    if (compHits.length === 0 && taskHits.length === 0 && pilotHits.length === 0) {
      scheduleSearchIndexDrain(c, DRAIN_PASSES_PER_SEARCH);
      return c.json(empty, 200, cacheHeaders(user));
    }

    // ── Which competitions, and in what order ──────────────────────────────
    // A competition that matched ON ITS OWN NAME first, then the most recent.
    //
    // Neither clause is a tiebreak; between them they are the whole order, and
    // bm25 deliberately is not.
    //
    // The name clause exists because bm25 scores a SHORT document higher than
    // a long one for the same word: searching "forbes" put three Bright Opens
    // — each carrying a pilot called Andrew Forbes — above every competition
    // actually named Forbes Flatlands, and pushed one of them off the end of
    // the list. A competition only matches when EVERY word of the query is in
    // its own name or metadata, which is the strongest signal here.
    //
    // Recency, rather than score, decides the rest because every competition
    // in this list already matches every word — what is left to rank on is
    // noise. Six Corryong Cups whose tasks all fly ELLIOT → KANGCK scored
    // within one bm25 point of each other, purely on how long each route is,
    // and came back 2025, 2023, 2021, 2024, 2017. Newest first is both the
    // more useful answer and one a reader can predict. Score still decides
    // WHICH tasks and pilots come back, and their order inside a competition.
    const matchedCompIds = new Set(compHits.map((h) => h.comp_id));
    const bestDate = new Map<number, string>();
    for (const hit of [...compHits, ...taskHits, ...pilotHits]) {
      const prev = bestDate.get(hit.comp_id) ?? "";
      if ((hit.sort_date ?? "") > prev) bestDate.set(hit.comp_id, hit.sort_date ?? "");
    }
    const rankedCompIds = [...bestDate.entries()]
      .sort((a, b) => {
        const byName = Number(!matchedCompIds.has(a[0])) - Number(!matchedCompIds.has(b[0]));
        return byName !== 0 ? byName : b[1].localeCompare(a[1]);
      })
      .map(([compId]) => compId);
    const compIds = rankedCompIds.slice(0, MAX_COMPS);
    const inScope = new Set(compIds);
    let truncated = rankedCompIds.length > compIds.length;

    compHits = compHits.filter((h) => inScope.has(h.comp_id));
    taskHits = taskHits.filter((h) => inScope.has(h.comp_id));
    pilotHits = pilotHits.filter((h) => inScope.has(h.comp_id));

    if (taskHits.length > MAX_TASKS) {
      taskHits = taskHits.slice(0, MAX_TASKS);
      truncated = true;
    }
    if (pilotHits.length > MAX_PILOTS) {
      pilotHits = pilotHits.slice(0, MAX_PILOTS);
      truncated = true;
    }

    // ── The context each level needs ──────────────────────────────────────
    const [compMeta, taskCounts] = await db.batch<CompMetaRow | TaskCountRow>([
      db
        .prepare(
          `SELECT comp_id, name, category, test, scoring_format
             FROM comp WHERE comp_id IN (${placeholders(compIds.length)})`
        )
        .bind(...compIds),
      db
        .prepare(
          `SELECT comp_id, COUNT(*) AS task_count
             FROM task WHERE comp_id IN (${placeholders(compIds.length)})
            GROUP BY comp_id`
        )
        .bind(...compIds),
    ]);
    const metaById = new Map<number, CompMetaRow>(
      (compMeta.results as CompMetaRow[]).map((row) => [row.comp_id, row])
    );
    const taskCountById = new Map<number, number>(
      (taskCounts.results as TaskCountRow[]).map((row) => [row.comp_id, row.task_count])
    );

    // Matched pilots sit under the tasks they flew, because a pilot's page is
    // per task. "Flew" is a tracklog or an ACTIVE manual flight — the same
    // definition scoring uses, so a pilot who was superseded to Absent does
    // not linger here.
    const pilotIds = pilotHits.map((h) => h.comp_pilot_id!).filter((id) => id != null);
    const flightsByPilot = new Map<number, FlightRow[]>();
    if (pilotIds.length > 0) {
      const rows = await db
        .prepare(
          `SELECT f.comp_pilot_id, t.task_id, t.comp_id, t.name AS task_name, t.task_date
             FROM (SELECT comp_pilot_id, task_id FROM task_track
                    WHERE comp_pilot_id IN (${placeholders(pilotIds.length)})
                   UNION
                   SELECT comp_pilot_id, task_id FROM task_manual_flight
                    WHERE comp_pilot_id IN (${placeholders(pilotIds.length)})
                      AND active = 1) f
             JOIN task t ON t.task_id = f.task_id
            ORDER BY t.task_date DESC
            LIMIT ?`
        )
        .bind(...pilotIds, ...pilotIds, MAX_FLIGHT_ROWS)
        .all<FlightRow>();
      for (const row of rows.results) {
        const list = flightsByPilot.get(row.comp_pilot_id) ?? [];
        if (list.length < MAX_TASKS_PER_PILOT) list.push(row);
        flightsByPilot.set(row.comp_pilot_id, list);
      }
    }

    // Tasks that matched show how big the field was, since their pilots are
    // deliberately not listed.
    const shownTaskIds = new Set<number>(taskHits.map((h) => h.task_id!));
    for (const flights of flightsByPilot.values()) {
      for (const f of flights) shownTaskIds.add(f.task_id);
    }
    const pilotCountByTask = new Map<number, number>();
    if (shownTaskIds.size > 0) {
      const ids = [...shownTaskIds];
      const rows = await db
        .prepare(
          `SELECT task_id, COUNT(*) AS pilot_count FROM (
             SELECT task_id, comp_pilot_id FROM task_track
              WHERE task_id IN (${placeholders(ids.length)})
             UNION
             SELECT task_id, comp_pilot_id FROM task_manual_flight
              WHERE task_id IN (${placeholders(ids.length)}) AND active = 1
           ) GROUP BY task_id`
        )
        .bind(...ids, ...ids)
        .all<PilotCountRow>();
      for (const row of rows.results) pilotCountByTask.set(row.task_id, row.pilot_count);
    }

    // ── Assembly ──────────────────────────────────────────────────────────
    const tasksByComp = new Map<number, Map<number, SearchTaskHit>>();
    const strandedPilotsByComp = new Map<number, SearchPilotHit[]>();

    const taskBucket = (compId: number) => {
      let bucket = tasksByComp.get(compId);
      if (!bucket) {
        bucket = new Map();
        tasksByComp.set(compId, bucket);
      }
      return bucket;
    };

    for (const hit of taskHits) {
      taskBucket(hit.comp_id).set(hit.task_id!, {
        task_id: sqid(hit.task_id!),
        name: hit.title,
        task_date: hit.sort_date ?? "",
        matched: true,
        matched_turnpoints: matchedTurnpoints(hit.extra, terms),
        pilots: [],
        pilot_count: pilotCountByTask.get(hit.task_id!) ?? 0,
      });
    }

    for (const hit of pilotHits) {
      const pilot: SearchPilotHit = {
        comp_pilot_id: sqid(hit.comp_pilot_id!),
        name: hit.title,
      };
      const flights = flightsByPilot.get(hit.comp_pilot_id!) ?? [];
      if (flights.length === 0) {
        const list = strandedPilotsByComp.get(hit.comp_id) ?? [];
        list.push(pilot);
        strandedPilotsByComp.set(hit.comp_id, list);
        continue;
      }
      for (const flight of flights) {
        const bucket = taskBucket(flight.comp_id);
        let task = bucket.get(flight.task_id);
        if (!task) {
          task = {
            task_id: sqid(flight.task_id),
            name: flight.task_name,
            task_date: flight.task_date,
            matched: false,
            matched_turnpoints: [],
            pilots: [],
            pilot_count: pilotCountByTask.get(flight.task_id) ?? 0,
          };
          bucket.set(flight.task_id, task);
        }
        task.pilots.push(pilot);
      }
    }

    const comps: SearchCompHit[] = [];
    for (const compId of compIds) {
      const meta = metaById.get(compId);
      if (!meta) continue; // deleted between the two queries
      const allTasks = [...(tasksByComp.get(compId)?.values() ?? [])].sort((a, b) => {
        // A task that matched outranks one that is only carrying a pilot;
        // otherwise the most recent first, which is how tasks are read.
        if (a.matched !== b.matched) return a.matched ? -1 : 1;
        return b.task_date.localeCompare(a.task_date);
      });
      const tasks = allTasks.slice(0, MAX_TASKS_PER_COMP);
      if (tasks.length < allTasks.length) truncated = true;
      comps.push({
        comp_id: sqid(compId),
        name: meta.name,
        category: meta.category,
        test: meta.test === 1,
        scoring_format: meta.scoring_format,
        matched: matchedCompIds.has(compId),
        task_count: taskCountById.get(compId) ?? 0,
        tasks,
        pilots: strandedPilotsByComp.get(compId) ?? [],
      });
    }

    // Answer first, then spend the connection we already have on a slice of
    // the reindex queue: search traffic is exactly when the index being right
    // matters, and this keeps it converging without a job that has to run.
    scheduleSearchIndexDrain(c, DRAIN_PASSES_PER_SEARCH);

    const body: SearchResponse = { terms, comps, truncated };
    return c.json(body, 200, cacheHeaders(user));
  }
);

/**
 * Results depend on who is asking (a comp admin sees their own test comps),
 * so only the anonymous answer is shareable. Short-lived either way: a new
 * competition should turn up in search within the minute.
 */
function cacheHeaders(user: AuthUser | null): Record<string, string> {
  return {
    "Cache-Control": user ? "private, no-store" : "public, max-age=60",
  };
}
