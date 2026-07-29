// Copyright (c) 2026, Tushar Pokle.  All rights reserved.
/**
 * When the rankings importer is allowed to talk to civlcomps.org.
 *
 * The workflow runs daily because CIVL's publication day within the month
 * moves. That is only acceptable if a day with nothing new costs them nothing,
 * so the fetch decision is split into two gates, cheapest first:
 *
 *   needsCheck()  — from D1 alone, no network. False for the ~30 days a month
 *                   when we already hold the current month's list.
 *   hasNewer()    — after one page load, from the periods the page advertises.
 *
 * Both are phrased as "is there anything NEWER than what I hold?", never "is
 * this month's list out yet?". CIVL publishing on the 9th, publishing late, or
 * skipping a month entirely all fall out of that without a special case; the
 * "must equal the current month" phrasing gets the skipped month wrong and
 * polls forever.
 *
 * Dates are ISO 'YYYY-MM-DD' throughout and compared as strings, which is
 * ordering-correct for that format and avoids a timezone ever deciding which
 * month it is.
 */

/** First day of the current UTC month, as 'YYYY-MM-01'. */
export function currentMonthStart(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/**
 * Whether this list is worth a page load today.
 *
 * @param stored     the ranking_date already in D1 for this list, or undefined
 * @param monthStart first of the current month (see currentMonthStart)
 * @param force      the --force flag: check regardless
 */
export function needsCheck(
  stored: string | undefined,
  monthStart: string,
  force = false,
): boolean {
  if (force) return true;
  if (!stored) return true;
  // Holding a list dated on or after the 1st of this month means the latest
  // CIVL can possibly have published is already here. Nothing to look for
  // until the calendar rolls over.
  return stored < monthStart;
}

/**
 * Whether the newest period the page advertises is worth exporting.
 *
 * @param stored the ranking_date already in D1 for this list, or undefined
 * @param newest the newest published period's date
 * @param force  the --force flag: re-export even a month already stored
 */
export function hasNewer(stored: string | undefined, newest: string, force = false): boolean {
  if (force) return true;
  if (!stored) return true;
  return newest > stored;
}
