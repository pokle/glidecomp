// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Which analysis-page URLs an anonymous visitor may open (issue #666).
 *
 * The report card — a public, server-rendered page — links one pilot's track
 * into this viewer as `?compId=…&taskId=…&pilotId=…`. That deep link reads
 * nothing but published competition data: the comp record, the task, the
 * task's track list and one pilot's IGC, all four already `optionalAuth` and
 * all four already fetched anonymously by the report card itself to draw its
 * own map. So it opens without a session. Everything ELSE this page does is
 * the viewer's personal library, which needs an account to have anything in
 * it at all.
 *
 * The rule is deliberately a whitelist of one shape rather than "open the
 * page": a param this file has never heard of cannot quietly widen it.
 */

/**
 * Params that name a load path other than the public competition deep link.
 * Any of them present means the URL is asking for something else — the
 * personal library (`storedTrack`, `storedTask`, `u`), the bundled samples
 * (`track`, `task`, `sampleComp`), or the mobile share target (`shared`) —
 * and an anonymous visitor is sent to sign in as before.
 */
const NON_PUBLIC_PARAMS = [
  'track',
  'task',
  'storedTrack',
  'storedTask',
  'sampleComp',
  'shared',
  'u',
] as const;

/**
 * Is this URL the public competition deep link, and only that?
 *
 * `pilotId` is not required: it narrows the view to one pilot's track, but
 * the whole field is just as public. Feature toggles (`3d`, `speed`,
 * `task-visible`, …) carry no data and are ignored here.
 */
export function isPublicCompLink(search: string): boolean {
  const params = new URLSearchParams(search);
  if (!params.get('compId') || !params.get('taskId')) return false;
  return NON_PUBLIC_PARAMS.every((name) => !params.get(name));
}
