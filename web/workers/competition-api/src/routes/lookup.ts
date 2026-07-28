/**
 * GET /api/comp/lookup — find the competitions, tasks and pilots whose names
 * match some words, so a dead URL can be turned into a live one.
 *
 * This exists for the 404 page. Public URLs carry `${slug}-${id}` segments
 * (`/comp/corryong-cup-2026-voqc/task/task-1-open-bqlf/pilot/harrison-rowntree
 * -zujf`), and the slug half is a lossy but human-readable copy of the entity's
 * name. When an id stops resolving — a comp rebuilt before ids were preserved, a
 * task an organizer deleted and re-created, a link someone retyped — the slug is
 * still enough to find what the visitor meant. The caller sends the words from
 * each dead segment, this returns the ids that exist now, and the page rebuilds
 * the closest working URL.
 *
 * The endpoint deliberately knows NOTHING about URLs: no slugifying, no path
 * building. Those live in one place (web/frontend/src/react/lib/slug.ts) and
 * that place is the client, so the two can't drift. Here it is a name search
 * over three tables, returning ids and names.
 *
 * It is public and unauthenticated, so every dimension of the work it can be
 * asked to do is capped — see the constants below. `test` comps stay invisible
 * to anyone who can't already see them, exactly as the comp routes have it:
 * a lookup must not become the way to discover a hidden competition.
 */
import { Hono } from "hono";
import type { Env, AuthUser } from "../env";
import { encodeId, decodeId } from "../sqids";
import { optionalAuth } from "../middleware/auth";
import { isSuperAdmin } from "../super-admin";

type Variables = { user: AuthUser | null };
type HonoEnv = { Bindings: Env; Variables: Variables };

// ── Abuse limits ───────────────────────────────────────────────────────────
// Every one of these bounds a scan over a table nobody has authenticated to
// read, so they are deliberately small: the page they serve shows a handful of
// links, and a "did you mean" that trawls the whole database to offer twenty
// guesses is both worse UX and a free query amplifier.

/** Longest search text accepted per field; anything beyond is truncated. */
const MAX_TERM_CHARS = 120;
/** Most words used from one field. Extra words are dropped, not ANDed in. */
const MAX_TOKENS = 5;
/** A single letter matches almost everything, so it is not a search term.
 *  A single DIGIT is (see searchTokens) — it is what separates Task 1 from
 *  Task 2, the commonest thing anyone looks up. */
const MIN_TOKEN_CHARS = 2;
/** Competitions returned, and the number we drill into for tasks/pilots. */
const MAX_COMPS = 5;
const MAX_TASKS = 10;
const MAX_PILOTS = 10;
/** Rows pulled before the per-pilot reduction below picks one task each. */
const PILOT_TASK_ROWS = 40;

/** A row of the comp table, as this endpoint reports it. */
interface CompHit {
  comp_id: string;
  name: string;
  category: string;
}

interface TaskHit {
  comp_id: string;
  comp_name: string;
  task_id: string;
  name: string;
  task_date: string;
}

interface PilotHit {
  comp_id: string;
  comp_name: string;
  task_id: string;
  task_name: string;
  task_date: string;
  comp_pilot_id: string;
  name: string;
}

/**
 * Split search text into the words we match on: lowercased, alphanumeric,
 * capped in both length and count. A slug arrives here as "corryong-cup-2026"
 * and a typed query as "corryong cup 2026"; both reduce to the same words,
 * which is the whole point — the caller needn't know which it holds.
 *
 * One-character words are dropped unless they are digits. "a" narrows nothing,
 * but the "1" in `task-1-open` is the entire difference between Task 1 and
 * Task 2 — drop it and every task in the comp comes back as an equal match.
 *
 * Splitting on non-alphanumerics also means a LIKE wildcard can never survive
 * into a token; likePattern escapes them anyway, as the second of two barriers.
 */
export function searchTokens(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .slice(0, MAX_TERM_CHARS)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= MIN_TOKEN_CHARS || /^[0-9]$/.test(t))
    .slice(0, MAX_TOKENS);
}

/**
 * A token as a LIKE pattern. `%` and `_` are wildcards and `\` is our escape
 * character, so all three are escaped — otherwise a query of "%" would ask for
 * a full scan of every name in the database.
 */
export function likePattern(token: string): string {
  return `%${token.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** `AND`ed LIKE clauses for `column`, plus the values to bind. */
function nameFilter(
  column: string,
  tokens: string[]
): { sql: string; binds: string[] } {
  return {
    sql: tokens.map(() => `${column} LIKE ? ESCAPE '\\'`).join(" AND "),
    binds: tokens.map(likePattern),
  };
}

/**
 * SQL that restricts a query to the comps this caller may see, plus its binds.
 * Mirrors the comp routes: everything non-`test`, plus the `test` comps the
 * caller administers (all of them, for a super admin).
 */
async function visibleCompsFilter(
  db: D1Database,
  user: AuthUser | null,
  compColumn: string
): Promise<{ sql: string; binds: unknown[] }> {
  if (isSuperAdmin(user)) return { sql: "1 = 1", binds: [] };
  if (!user) return { sql: `${compColumn}.test = 0`, binds: [] };
  const rows = await db
    .prepare("SELECT comp_id FROM comp_admin WHERE user_id = ?")
    .bind(user.id)
    .all<{ comp_id: number }>();
  const ids = rows.results.map((r) => r.comp_id);
  if (ids.length === 0) return { sql: `${compColumn}.test = 0`, binds: [] };
  const placeholders = ids.map(() => "?").join(",");
  return {
    sql: `(${compColumn}.test = 0 OR ${compColumn}.comp_id IN (${placeholders}))`,
    binds: ids,
  };
}

export const lookupRoutes = new Hono<HonoEnv>().get(
  // Mounted ahead of compRoutes so this static segment wins over
  // /api/comp/:comp_id, the same way /api/comp/pilot does.
  "/api/comp/lookup",
  optionalAuth,
  async (c) => {
    const db = c.env.DB;
    const user = c.var.user;
    const alphabet = c.env.SQIDS_ALPHABET;
    const sqid = (id: number) => encodeId(alphabet, id);

    const compTokens = searchTokens(c.req.query("comp_q"));
    const taskTokens = searchTokens(c.req.query("task_q"));
    const pilotTokens = searchTokens(c.req.query("pilot_q"));
    const compAnchor = c.req.query("comp");

    const visible = await visibleCompsFilter(db, user, "c");

    // ── Competitions ────────────────────────────────────────────────────────
    // An anchor that still resolves is not a guess: the comp id in the dead URL
    // is right and only the deeper segments went missing. Trust it and search
    // no further, so the suggestions stay inside the competition the visitor
    // was actually looking at.
    let comps: CompHit[] = [];
    let anchored = false;
    const anchorId = compAnchor ? decodeId(alphabet, compAnchor) : null;
    if (anchorId !== null) {
      const row = await db
        .prepare(
          `SELECT c.comp_id, c.name, c.category FROM comp c
            WHERE c.comp_id = ? AND ${visible.sql}`
        )
        .bind(anchorId, ...visible.binds)
        .first<{ comp_id: number; name: string; category: string }>();
      if (row) {
        comps = [{ comp_id: sqid(row.comp_id), name: row.name, category: row.category }];
        anchored = true;
      }
    }

    if (!anchored && compTokens.length > 0) {
      const f = nameFilter("LOWER(c.name)", compTokens);
      const rows = await db
        .prepare(
          `SELECT c.comp_id, c.name, c.category FROM comp c
            WHERE ${visible.sql} AND ${f.sql}
            ORDER BY c.creation_date DESC
            LIMIT ?`
        )
        .bind(...visible.binds, ...f.binds, MAX_COMPS)
        .all<{ comp_id: number; name: string; category: string }>();
      comps = rows.results.map((r) => ({
        comp_id: sqid(r.comp_id),
        name: r.name,
        category: r.category,
      }));
    }

    // Comps to drill into. When the comp words matched nothing we still search
    // tasks and pilots — across every visible comp — because the comp half of
    // the URL may be the part that is wrong, or the caller may be searching by
    // a pilot's name alone.
    const scopeIds = comps.map((x) => decodeId(alphabet, x.comp_id)!);
    const scope =
      scopeIds.length > 0
        ? {
            sql: `c.comp_id IN (${scopeIds.map(() => "?").join(",")})`,
            binds: scopeIds as unknown[],
          }
        : visible;

    // ── Tasks ───────────────────────────────────────────────────────────────
    let tasks: TaskHit[] = [];
    if (taskTokens.length > 0) {
      const f = nameFilter("LOWER(t.name)", taskTokens);
      const rows = await db
        .prepare(
          `SELECT t.task_id, t.name, t.task_date, c.comp_id, c.name AS comp_name
             FROM task t JOIN comp c ON c.comp_id = t.comp_id
            WHERE ${scope.sql} AND ${f.sql}
            ORDER BY t.task_date DESC
            LIMIT ?`
        )
        .bind(...scope.binds, ...f.binds, MAX_TASKS)
        .all<{
          task_id: number;
          name: string;
          task_date: string;
          comp_id: number;
          comp_name: string;
        }>();
      tasks = rows.results.map((r) => ({
        comp_id: sqid(r.comp_id),
        comp_name: r.comp_name,
        task_id: sqid(r.task_id),
        name: r.name,
        task_date: r.task_date,
      }));
    }

    // ── Pilots ──────────────────────────────────────────────────────────────
    // A pilot's page is per task, so a pilot is only a usable suggestion
    // together with a task they have a result on — a tracklog or an active
    // manual flight. Rows come back per (pilot, task) and are reduced to one
    // task each below.
    let pilots: PilotHit[] = [];
    if (pilotTokens.length > 0) {
      const f = nameFilter("LOWER(cp.registered_pilot_name)", pilotTokens);
      const rows = await db
        .prepare(
          `SELECT cp.comp_pilot_id, cp.registered_pilot_name AS pilot_name,
                  t.task_id, t.name AS task_name, t.task_date,
                  c.comp_id, c.name AS comp_name
             FROM comp_pilot cp
             JOIN comp c ON c.comp_id = cp.comp_id
             JOIN task t ON t.comp_id = cp.comp_id
            WHERE ${scope.sql} AND ${f.sql}
              AND (EXISTS (SELECT 1 FROM task_track tt
                            WHERE tt.task_id = t.task_id
                              AND tt.comp_pilot_id = cp.comp_pilot_id)
                OR EXISTS (SELECT 1 FROM task_manual_flight mf
                            WHERE mf.task_id = t.task_id
                              AND mf.comp_pilot_id = cp.comp_pilot_id
                              AND mf.active = 1))
            ORDER BY t.task_date DESC
            LIMIT ?`
        )
        .bind(...scope.binds, ...f.binds, PILOT_TASK_ROWS)
        .all<{
          comp_pilot_id: number;
          pilot_name: string;
          task_id: number;
          task_name: string;
          task_date: string;
          comp_id: number;
          comp_name: string;
        }>();

      // One suggestion per pilot. When the dead URL also named a task, prefer
      // the pilot's result on a task that matched it — that is the page the
      // visitor was on. Otherwise the most recent task they flew wins, which
      // the ORDER BY above already put first.
      const matchedTaskIds = new Set(tasks.map((t) => t.task_id));
      const best = new Map<number, PilotHit>();
      for (const r of rows.results) {
        const hit: PilotHit = {
          comp_id: sqid(r.comp_id),
          comp_name: r.comp_name,
          task_id: sqid(r.task_id),
          task_name: r.task_name,
          task_date: r.task_date,
          comp_pilot_id: sqid(r.comp_pilot_id),
          name: r.pilot_name,
        };
        const prev = best.get(r.comp_pilot_id);
        if (!prev) best.set(r.comp_pilot_id, hit);
        else if (matchedTaskIds.has(hit.task_id) && !matchedTaskIds.has(prev.task_id)) {
          best.set(r.comp_pilot_id, hit);
        }
      }
      pilots = [...best.values()].slice(0, MAX_PILOTS);
    }

    return c.json(
      { comps, tasks, pilots },
      200,
      {
        // Results depend on who is asking (a comp admin sees their test comps),
        // so only the anonymous answer is shareable. It is short-lived either
        // way: the whole point is to reflect the ids that exist right now.
        "Cache-Control": user ? "private, no-store" : "public, max-age=300",
      }
    );
  }
);
