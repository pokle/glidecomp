/**
 * The competitions somebody could be submitting a track to right now.
 *
 * Exists because the submit flow starts from the homepage, where nothing is
 * known about the pilot or their competition, and the one thing that IS known
 * is what day it is. Most tracks are submitted on the evening of the task, so
 * a list of open competitions around today, with their tasks, is usually a
 * one-click answer rather than a search.
 *
 * Neither existing endpoint could do it: `GET /api/comp` returns comps without
 * tasks, and `GET /api/comp/:comp_id` returns tasks for one comp at a time.
 *
 * Public and unauthenticated, and deliberately caller-independent — the answer
 * does not vary by who asks, which is what makes one shared cached body
 * correct and keeps a `Vary` hazard from existing at all.
 *
 * A task the organiser has closed for submissions is EXCLUDED, and a comp
 * whose only in-window task is closed drops off the list entirely. The
 * endpoint's contract is literally "what could somebody submit to right now",
 * and `suggested_task_id` is derived from dates — left in, it would cheerfully
 * steer every pilot into a 403.
 */

import { Hono } from "hono";
import type { BareEnv, Env } from "../env";
import { encodeId } from "../sqids";
import { bindList, chunkForBinds } from "../lib/bind-chunks";
import { isCompClosed, todayInZone } from "../submission-gate";

/**
 * How far either side of today a competition still counts as "on".
 *
 * Two days back covers the pilot who forgets until Monday; two days forward
 * covers the comp that starts tomorrow and whose pilots are already checking
 * they can submit. Wider than that and the list stops being a shortlist.
 */
const WINDOW_DAYS = 2;

/** Bounded because the endpoint is unauthenticated. */
const MAX_COMPS = 20;
const MAX_TASKS_PER_COMP = 20;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function shiftDays(today: string, days: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

/** The latest task date in a comp, independent of the array's order. */
function latestTaskDate(tasks: { task_date: string }[]): string {
  return tasks.reduce((a, t) => (t.task_date > a ? t.task_date : a), "");
}

/** Whole days between two YYYY-MM-DD strings, absolute. */
function dayGap(a: string, b: string): number {
  const ms =
    new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime();
  return Math.abs(Math.round(ms / 86_400_000));
}

interface OpenTask {
  task_id: string;
  name: string;
  task_date: string;
  pilot_classes: string[];
  has_xctsk: boolean;
}

export const openCompsRoutes = new Hono<BareEnv>().get(
  // Hyphenated so it can never collide with a real comp sqid (the alphabet is
  // a–z only) and shadow `/api/comp/:comp_id`.
  "/api/comp/open-now",
  async (c) => {
    const alphabet = c.env.SQIDS_ALPHABET;
    const now = new Date();
    const today = isoDate(now);
    const from = shiftDays(today, -WINDOW_DAYS);
    const to = shiftDays(today, WINDOW_DAYS);

    // `substr(close_date, 1, 10)` because close_date is stored both as a bare
    // date and as a timestamp; the "date-only means end of day" convention the
    // upload routes use has to hold here too. That day ends in the COMP'S zone
    // (isCompClosed), which SQL cannot ask, so the query keeps a day's margin
    // and the exact rule is applied to each comp below — a comp west of
    // Greenwich is still open on the evening of its last day, when UTC has
    // already moved on.
    const rows = await c.env.DB.prepare(
      `SELECT c.comp_id, c.name, c.category, c.timezone, c.close_date,
              t.task_id, t.name AS task_name, t.task_date,
              (t.xctsk IS NOT NULL) AS has_xctsk
       FROM comp c
       JOIN task t ON t.comp_id = c.comp_id
       WHERE c.test = 0
         AND c.open_igc_upload = 1
         AND t.submissions_closed = 0
         AND (c.close_date IS NULL OR c.close_date = ''
              OR substr(c.close_date, 1, 10) >= ?1)
         AND EXISTS (SELECT 1 FROM task t2
                     WHERE t2.comp_id = c.comp_id
                       AND t2.submissions_closed = 0
                       AND t2.task_date BETWEEN ?2 AND ?3)
       ORDER BY c.comp_id, t.task_date ASC`
    )
      .bind(shiftDays(today, -1), from, to)
      .all<{
        comp_id: number;
        name: string;
        category: string;
        timezone: string | null;
        close_date: string | null;
        task_id: number;
        task_name: string;
        task_date: string;
        has_xctsk: number;
      }>();

    // Group into comps, keeping the SQL's task order.
    const byComp = new Map<
      number,
      {
        comp_id: number;
        name: string;
        category: string;
        timezone: string | null;
        close_date: string | null;
        tasks: { task_id: number; name: string; task_date: string; has_xctsk: boolean }[];
      }
    >();
    for (const row of rows.results) {
      // The same answer the upload routes give, so nothing listed here is a
      // comp that would refuse the file.
      if (isCompClosed(row.close_date, row.timezone, now)) continue;
      let comp = byComp.get(row.comp_id);
      if (!comp) {
        comp = {
          comp_id: row.comp_id,
          name: row.name,
          category: row.category,
          timezone: row.timezone,
          close_date: row.close_date,
          tasks: [],
        };
        byComp.set(row.comp_id, comp);
      }
      if (comp.tasks.length < MAX_TASKS_PER_COMP) {
        comp.tasks.push({
          task_id: row.task_id,
          name: row.task_name,
          task_date: row.task_date,
          has_xctsk: !!row.has_xctsk,
        });
      }
    }

    // Most likely first: a comp flying today beats one flying tomorrow, and
    // the tie-breaks are stable so a cached body and an e2e assertion agree.
    const comps = [...byComp.values()]
      .map((comp) => {
        const nearest = comp.tasks.reduce((best, t) =>
          dayGap(t.task_date, today) < dayGap(best.task_date, today) ? t : best
        );
        return {
          comp,
          nearestGap: dayGap(nearest.task_date, today),
          latest: latestTaskDate(comp.tasks),
        };
      })
      .sort(
        (a, b) =>
          a.nearestGap - b.nearestGap ||
          b.latest.localeCompare(a.latest) ||
          a.comp.name.localeCompare(b.comp.name)
      )
      .slice(0, MAX_COMPS)
      .map(({ comp }) => comp);

    // Task classes for everything we are about to return, in one round trip.
    // Chunked: up to MAX_COMPS × MAX_TASKS_PER_COMP task ids (400) go into the
    // IN list, and D1 binds at most 100 parameters per statement — one busy
    // week of competitions was enough to turn this endpoint, which the
    // homepage's submit flow starts from, into a 500.
    const taskIds = comps.flatMap((comp) => comp.tasks.map((t) => t.task_id));
    const classes: Record<number, string[]> = {};
    if (taskIds.length > 0) {
      const batches = await c.env.DB.batch<{ task_id: number; pilot_class: string }>(
        chunkForBinds(taskIds).map((ids) =>
          c.env.DB.prepare(
            `SELECT task_id, pilot_class FROM task_class WHERE task_id IN (${bindList(ids.length)})`
          ).bind(...ids)
        )
      );
      for (const row of batches.flatMap((b) => b.results)) {
        (classes[row.task_id] ??= []).push(row.pilot_class);
      }
    }

    const body = {
      // The answer depends on what day it is, so a reader who gets a cached
      // copy can tell how old it is rather than being quietly misled.
      generated_at: new Date().toISOString(),
      window: { from, to, today },
      comps: comps.map((comp) => {
        // MOST RECENT FIRST. A pilot submits after landing, so the task they
        // mean is at the recent end — and a comp on day six should not make
        // them read past five days they have already filed. The ties are
        // broken by name so two classes on one day keep a stable order.
        const tasks: OpenTask[] = [...comp.tasks]
          .sort(
            (a, b) =>
              b.task_date.localeCompare(a.task_date) || a.name.localeCompare(b.name)
          )
          .map((t) => ({
            task_id: encodeId(alphabet, t.task_id),
            name: t.name,
            task_date: t.task_date,
            pilot_classes: classes[t.task_id] ?? [],
            has_xctsk: t.has_xctsk,
          }));
        // The task dated today, else the nearest one already flown — a pilot
        // uploads after landing, so the past beats the future on a tie.
        // Derived from the dates, never from array order: the wire order is a
        // presentation decision and has already been changed once.
        //
        // "Today" is the COMP'S day. A task's date is a local calendar day,
        // and in the Americas the evening a pilot lands is already tomorrow
        // in UTC — where a task created ahead for the next day was suggested
        // in place of the one just flown.
        const localToday = todayInZone(comp.timezone, now);
        const today_task = comp.tasks.find((t) => t.task_date === localToday);
        const past = comp.tasks.filter((t) => t.task_date < localToday);
        const suggested =
          today_task ??
          (past.length > 0
            ? past.reduce((a, b) => (a.task_date >= b.task_date ? a : b))
            : comp.tasks.reduce((a, b) => (a.task_date <= b.task_date ? a : b)));
        return {
          comp_id: encodeId(alphabet, comp.comp_id),
          name: comp.name,
          category: comp.category,
          timezone: comp.timezone,
          close_date: comp.close_date,
          suggested_task_id: encodeId(alphabet, suggested.task_id),
          tasks,
        };
      }),
    };

    // 60s is short enough that the body cannot survive a date rollover in a
    // way anyone notices. Do not widen it — the answer is a function of today.
    return c.json(body, 200, {
      "Cache-Control": "public, max-age=60",
    });
  }
);
