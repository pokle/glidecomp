/**
 * The search index: composing `search_doc` rows, and draining the queue of
 * keys the triggers in migration 0026 have marked dirty.
 *
 * Read the migration first — it holds the schema and the reasoning for the
 * shape. This file holds the half that needs a programming language: parsing
 * each task's xctsk into the words a route is searched by, and turning three
 * kinds of row into one kind of document.
 *
 * Why a queue rather than a call beside every mutation, which is how
 * audit() and bumpAndRevalidateScores() work: those two describe things only
 * the handler knows (who did what, and which tasks it touched). A search
 * document derives from three columns of three tables and nothing else, so
 * the database can notice the change itself — and a search index that
 * quietly stops seeing new competitions is a failure nobody would report for
 * months, unlike a wrong score. The drain is called from one middleware, one
 * cron and one admin button, instead of from twenty-eight handlers.
 */

import { turnpointNames, type TurnpointName } from "./xctsk-summary";

/**
 * The version of the document builder below. Bump it whenever what goes into
 * title/route/body changes: the nightly sweep reindexes every document behind
 * the current rev, so a format change heals itself over a night instead of
 * needing a migration or a remembered admin action.
 */
export const SEARCH_DOC_REV = 1;

/**
 * Keys rebuilt per pass. D1 allows 100 bound parameters per query and each
 * document upsert binds 12, so a pass stays well inside both that and the
 * batch it is written in.
 */
const KEYS_PER_PASS = 40;

/** Longest text stored in one indexed column. A pathological route or a name
 *  full of padding cannot grow the index without bound. */
const MAX_FIELD_CHARS = 2000;

/** Turnpoints kept in a task document's `extra` for the UI to highlight. */
const MAX_EXTRA_TURNPOINTS = 30;

/** The three kinds of thing that are searchable, as they appear in a key. */
export type SearchDocKind = "comp" | "task" | "pilot";

/** A composed document, ready to upsert. */
export interface SearchDoc {
  key: string;
  kind: SearchDocKind;
  comp_id: number;
  task_id: number | null;
  comp_pilot_id: number | null;
  title: string;
  route: string;
  body: string;
  /** The competition's name, for a task or pilot. See migration 0026. */
  owner: string;
  extra: string | null;
  sort_date: string | null;
}

/** What a task document keeps for the results page. */
export interface TaskDocExtra {
  turnpoints: TurnpointName[];
}

// ── Composing the text ─────────────────────────────────────────────────────

/**
 * Join parts into one searchable string: blanks dropped, repeats dropped
 * (case-insensitively), length capped. Repeats matter — FTS5 ranks on term
 * frequency, so a competition whose name repeats a word would otherwise
 * outrank one that simply is that word.
 */
function words(...parts: Array<string | null | undefined>): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    for (const word of part.split(/\s+/)) {
      if (!word) continue;
      const key = word.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(word);
    }
  }
  return out.join(" ").slice(0, MAX_FIELD_CHARS);
}

/** Both the abbreviation an organiser types and the words a visitor types. */
function categoryWords(category: string): string {
  if (category === "pg") return "pg paragliding";
  if (category === "hg") return "hg hang gliding hanggliding";
  return category;
}

function scoringFormatWords(format: string | null): string {
  if (format === "open_distance") return "open distance";
  if (format === "gap") return "gap";
  return format ?? "";
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/**
 * A date as words: the ISO form (whose tokens are the year, month and day
 * numbers) plus the month's name, so both "2026-01" and "january 2026" find
 * the same task.
 */
function dateWords(iso: string | null): string {
  if (!iso) return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  const month = MONTHS[Number(match[2]) - 1];
  return words(iso, month ?? "", match[1]);
}

/** JSON text list (comp.pilot_classes) as words, tolerant of a bad blob. */
function jsonListWords(json: string | null): string {
  if (!json) return "";
  try {
    const value = JSON.parse(json);
    return Array.isArray(value) ? value.filter((v) => typeof v === "string").join(" ") : "";
  } catch {
    return "";
  }
}

// ── The three document builders ────────────────────────────────────────────

export interface CompDocRow {
  comp_id: number;
  name: string;
  category: string;
  pilot_classes: string | null;
  scoring_format: string | null;
  series_scoring: string | null;
  creation_date: string;
  last_task_date: string | null;
}

export function buildCompDoc(row: CompDocRow): SearchDoc {
  return {
    key: `comp:${row.comp_id}`,
    kind: "comp",
    comp_id: row.comp_id,
    task_id: null,
    comp_pilot_id: null,
    title: row.name,
    route: "",
    owner: "",
    body: words(
      categoryWords(row.category),
      scoringFormatWords(row.scoring_format),
      row.series_scoring === "ftv" ? "ftv" : "",
      jsonListWords(row.pilot_classes),
      dateWords(row.last_task_date ?? row.creation_date)
    ),
    extra: null,
    sort_date: row.last_task_date ?? row.creation_date,
  };
}

export interface TaskDocRow {
  task_id: number;
  comp_id: number;
  comp_name: string;
  name: string;
  task_date: string;
  xctsk: string | null;
}

export function buildTaskDoc(row: TaskDocRow): SearchDoc {
  const turnpoints = turnpointNames(row.xctsk);
  const extra: TaskDocExtra = {
    turnpoints: turnpoints.slice(0, MAX_EXTRA_TURNPOINTS),
  };
  return {
    key: `task:${row.task_id}`,
    kind: "task",
    comp_id: row.comp_id,
    task_id: row.task_id,
    comp_pilot_id: null,
    title: row.name,
    // The route is the discriminator, in its own column so the query can
    // weight it: "Task 3" names a hundred tasks, "KANGCK" names a handful.
    route: words(...turnpoints.flatMap((tp) => [tp.code, tp.description])),
    body: words(dateWords(row.task_date)),
    // The competition's name rides along in every child document so
    // "corryong kangck" is answerable — every word of a query must be in ONE
    // document, and nobody thinks of a search as being scoped to a level. Its
    // own column, so a search for the competition ALONE does not drag every
    // task and pilot in it along too.
    owner: row.comp_name,
    extra: JSON.stringify(extra),
    sort_date: row.task_date,
  };
}

export interface PilotDocRow {
  comp_pilot_id: number;
  comp_id: number;
  comp_name: string;
  registered_pilot_name: string;
  registered_pilot_civl_id: string | null;
  account_name: string | null;
  pilot_class: string;
  team_name: string | null;
  last_task_date: string | null;
}

export function buildPilotDoc(row: PilotDocRow): SearchDoc {
  return {
    key: `pilot:${row.comp_pilot_id}`,
    kind: "pilot",
    comp_id: row.comp_id,
    task_id: null,
    comp_pilot_id: row.comp_pilot_id,
    // Both names, because an organiser enters "H. Rowntree" on the roster and
    // the pilot searches for "Harrison". The roster name is what displays.
    title: words(row.registered_pilot_name, row.account_name),
    route: "",
    body: words(row.pilot_class, row.team_name, row.registered_pilot_civl_id),
    owner: row.comp_name,
    extra: null,
    sort_date: row.last_task_date,
  };
}

// ── Draining the dirty queue ───────────────────────────────────────────────

interface DirtyKey {
  key: string;
  marked: number;
}

/** `kind:id` → its parts, or null when the key is not one we write. */
function parseKey(key: string): { kind: SearchDocKind; id: number } | null {
  const colon = key.indexOf(":");
  if (colon === -1) return null;
  const kind = key.slice(0, colon);
  const id = Number(key.slice(colon + 1));
  if (!Number.isInteger(id) || id <= 0) return null;
  if (kind !== "comp" && kind !== "task" && kind !== "pilot") return null;
  return { kind, id };
}

function upsertStatement(db: D1Database, doc: SearchDoc): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO search_doc
         (key, kind, comp_id, task_id, comp_pilot_id, title, route, body, owner,
          extra, sort_date, rev)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         kind = excluded.kind,
         comp_id = excluded.comp_id,
         task_id = excluded.task_id,
         comp_pilot_id = excluded.comp_pilot_id,
         title = excluded.title,
         route = excluded.route,
         body = excluded.body,
         owner = excluded.owner,
         extra = excluded.extra,
         sort_date = excluded.sort_date,
         rev = excluded.rev`
    )
    .bind(
      doc.key,
      doc.kind,
      doc.comp_id,
      doc.task_id,
      doc.comp_pilot_id,
      doc.title,
      doc.route,
      doc.body,
      doc.owner,
      doc.extra,
      doc.sort_date,
      SEARCH_DOC_REV
    );
}

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(",");

async function fetchCompDocs(db: D1Database, ids: number[]): Promise<SearchDoc[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .prepare(
      `SELECT c.comp_id, c.name, c.category, c.pilot_classes, c.scoring_format,
              c.series_scoring, c.creation_date,
              (SELECT MAX(t.task_date) FROM task t WHERE t.comp_id = c.comp_id) AS last_task_date
         FROM comp c WHERE c.comp_id IN (${placeholders(ids.length)})`
    )
    .bind(...ids)
    .all<CompDocRow>();
  return rows.results.map(buildCompDoc);
}

async function fetchTaskDocs(db: D1Database, ids: number[]): Promise<SearchDoc[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .prepare(
      `SELECT t.task_id, t.comp_id, t.name, t.task_date, t.xctsk, c.name AS comp_name
         FROM task t JOIN comp c ON c.comp_id = t.comp_id
        WHERE t.task_id IN (${placeholders(ids.length)})`
    )
    .bind(...ids)
    .all<TaskDocRow>();
  return rows.results.map(buildTaskDoc);
}

async function fetchPilotDocs(db: D1Database, ids: number[]): Promise<SearchDoc[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .prepare(
      `SELECT cp.comp_pilot_id, cp.comp_id, cp.registered_pilot_name,
              cp.registered_pilot_civl_id, cp.pilot_class, cp.team_name,
              p.name AS account_name, c.name AS comp_name,
              (SELECT MAX(t.task_date) FROM task t WHERE t.comp_id = cp.comp_id) AS last_task_date
         FROM comp_pilot cp
         JOIN comp c ON c.comp_id = cp.comp_id
         LEFT JOIN pilot p ON p.pilot_id = cp.pilot_id
        WHERE cp.comp_pilot_id IN (${placeholders(ids.length)})`
    )
    .bind(...ids)
    .all<PilotDocRow>();
  return rows.results.map(buildPilotDoc);
}

/**
 * Rebuild up to KEYS_PER_PASS documents. Returns how many keys were cleared.
 *
 * A key whose entity has been deleted clears its document — the foreign keys
 * cascade that away too, so this only matters for a key marked in the same
 * breath as the delete.
 *
 * The delete of each key is conditional on its `marked` count still being
 * what this pass read. A write that lands mid-rebuild bumps the count, the
 * delete misses, and the key stays queued for the next pass — rather than
 * being cleared by a rebuild that ran before it.
 */
async function drainOnce(db: D1Database): Promise<number> {
  const dirty = await db
    .prepare(`SELECT key, marked FROM search_dirty ORDER BY rowid LIMIT ?`)
    .bind(KEYS_PER_PASS)
    .all<DirtyKey>();
  if (dirty.results.length === 0) return 0;

  const byKind: Record<SearchDocKind, number[]> = { comp: [], task: [], pilot: [] };
  for (const row of dirty.results) {
    const parsed = parseKey(row.key);
    if (parsed) byKind[parsed.kind].push(parsed.id);
  }

  const [comps, tasks, pilots] = await Promise.all([
    fetchCompDocs(db, byKind.comp),
    fetchTaskDocs(db, byKind.task),
    fetchPilotDocs(db, byKind.pilot),
  ]);
  const docs = [...comps, ...tasks, ...pilots];
  const built = new Set(docs.map((d) => d.key));

  const statements: D1PreparedStatement[] = docs.map((doc) => upsertStatement(db, doc));
  for (const row of dirty.results) {
    // Nothing came back for this key: the comp/task/pilot is gone (or the key
    // was never one of ours). Drop whatever document it left behind.
    if (!built.has(row.key)) {
      statements.push(db.prepare(`DELETE FROM search_doc WHERE key = ?`).bind(row.key));
    }
    statements.push(
      db
        .prepare(`DELETE FROM search_dirty WHERE key = ? AND marked = ?`)
        .bind(row.key, row.marked)
    );
  }

  await db.batch(statements);
  return dirty.results.length;
}

/**
 * Drain the queue, up to `maxPasses` passes. Never throws: a search index
 * that fails to update must not fail the mutation it was triggered by, nor
 * the search that triggered it.
 */
export async function drainSearchIndex(
  db: D1Database,
  maxPasses = 1
): Promise<number> {
  let drained = 0;
  try {
    for (let pass = 0; pass < maxPasses; pass++) {
      const cleared = await drainOnce(db);
      drained += cleared;
      if (cleared < KEYS_PER_PASS) break;
    }
  } catch (err) {
    console.error("[search] drain failed", err);
  }
  return drained;
}

/** Structural view of a Hono context: the bindings and the (possibly absent —
 *  the getter throws outside a Worker request) execution context. */
export interface SearchIndexContext {
  env: { DB: D1Database };
  executionCtx: { waitUntil(promise: Promise<unknown>): void };
}

/**
 * Drain after the response, on the request's waitUntil. Used by the search
 * endpoint: search traffic is exactly when the index being current matters,
 * and the reader should not wait for someone else's rebuild.
 */
export function scheduleSearchIndexDrain(
  c: SearchIndexContext,
  maxPasses = 1
): void {
  const run = () => drainSearchIndex(c.env.DB, maxPasses);
  try {
    c.executionCtx.waitUntil(run());
  } catch {
    // Hono throws when there is no ExecutionContext (e.g. tests invoking the
    // app directly). Best-effort; run it unanchored.
    void run().catch(() => {});
  }
}

/**
 * Queue every document that is missing or was written by an older builder.
 *
 * This is the drift repair, run nightly. The triggers cannot miss a change,
 * but a deploy that changes what a document contains leaves every existing
 * row describing the old shape — that is what `rev` catches. Rows for
 * entities that never got indexed (a restore, a direct SQL fix) are the other
 * half.
 */
export async function sweepSearchIndex(db: D1Database): Promise<number> {
  const marked = await db.batch([
    db.prepare(
      `INSERT INTO search_dirty(key)
         SELECT 'comp:' || c.comp_id FROM comp c
          LEFT JOIN search_doc d ON d.key = 'comp:' || c.comp_id
          WHERE d.doc_id IS NULL OR d.rev != ?
        ON CONFLICT(key) DO UPDATE SET marked = marked + 1`
    ).bind(SEARCH_DOC_REV),
    db.prepare(
      `INSERT INTO search_dirty(key)
         SELECT 'task:' || t.task_id FROM task t
          LEFT JOIN search_doc d ON d.key = 'task:' || t.task_id
          WHERE d.doc_id IS NULL OR d.rev != ?
        ON CONFLICT(key) DO UPDATE SET marked = marked + 1`
    ).bind(SEARCH_DOC_REV),
    db.prepare(
      `INSERT INTO search_dirty(key)
         SELECT 'pilot:' || cp.comp_pilot_id FROM comp_pilot cp
          LEFT JOIN search_doc d ON d.key = 'pilot:' || cp.comp_pilot_id
          WHERE d.doc_id IS NULL OR d.rev != ?
        ON CONFLICT(key) DO UPDATE SET marked = marked + 1`
    ).bind(SEARCH_DOC_REV),
  ]);
  return marked.reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);
}

/**
 * Queue EVERY document for a rebuild — the admin button's half. Unlike the
 * sweep this does not ask whether a document looks current, which is the
 * point: it is the lever for "the index is wrong and I do not know why".
 */
export async function reindexAllSearchDocs(db: D1Database): Promise<number> {
  const marked = await db.batch([
    db.prepare(
      `INSERT INTO search_dirty(key) SELECT 'comp:' || comp_id FROM comp WHERE 1
        ON CONFLICT(key) DO UPDATE SET marked = marked + 1`
    ),
    db.prepare(
      `INSERT INTO search_dirty(key) SELECT 'task:' || task_id FROM task WHERE 1
        ON CONFLICT(key) DO UPDATE SET marked = marked + 1`
    ),
    db.prepare(
      `INSERT INTO search_dirty(key) SELECT 'pilot:' || comp_pilot_id FROM comp_pilot WHERE 1
        ON CONFLICT(key) DO UPDATE SET marked = marked + 1`
    ),
  ]);
  return marked.reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);
}

/** Document counts by kind plus the queue depth, for the admin cache page. */
export async function searchIndexStats(
  db: D1Database
): Promise<{ item_count: number; by_prefix: Record<string, number> }> {
  const [docs, dirty] = await db.batch<{ kind?: string; cnt: number }>([
    db.prepare(`SELECT kind, COUNT(*) AS cnt FROM search_doc GROUP BY kind`),
    db.prepare(`SELECT COUNT(*) AS cnt FROM search_dirty`),
  ]);
  const labels: Record<string, string> = {
    comp: "Competitions",
    task: "Tasks (with routes)",
    pilot: "Pilots",
  };
  const by_prefix: Record<string, number> = {};
  let item_count = 0;
  for (const row of docs.results) {
    by_prefix[labels[row.kind ?? ""] ?? `Documents (${row.kind})`] = row.cnt;
    item_count += row.cnt;
  }
  const queued = dirty.results[0]?.cnt ?? 0;
  if (queued > 0) by_prefix["Awaiting reindex"] = queued;
  return { item_count, by_prefix };
}
