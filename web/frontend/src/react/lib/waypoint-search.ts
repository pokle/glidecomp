/**
 * Find the competition's own waypoints by what an organiser would type.
 *
 * The map's search box answers two questions at once: "where is Corryong?"
 * (the geocoder, lib/geocode.ts) and "where is A01?" — the waypoint already on
 * the map, somewhere among 150 others. The second is local, free and instant,
 * so it runs on every keystroke and its hits are listed first: a waypoint the
 * organiser loaded is a better answer than a town that shares its name.
 *
 * Matching ignores case and accents, and is ranked so the hit that reads most
 * like what was typed comes first: the exact code, then a code that starts
 * with it, then a name that starts with it, then a word in the name that
 * starts with it, then anything containing it. A query of several words
 * matches when every word starts a word of the code or name ("elliot launch").
 */
import type { MapWaypoint } from "@/analysis/map-provider";

/** At most this many waypoints, so the places below them stay in view. */
export const WAYPOINT_RESULT_LIMIT = 5;

/** Lower case, accents off, runs of anything but letters and digits as one space. */
function normalise(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** How well `wp` answers `q` (already normalised); lower is better, null is no match. */
function rank(q: string, code: string, name: string): number | null {
  if (code === q) return 0;
  if (code.startsWith(q)) return 1;
  if (name.startsWith(q)) return 2;
  const words = `${code} ${name}`.split(" ");
  if (words.some((w) => w.startsWith(q))) return 3;
  if (code.includes(q) || name.includes(q)) return 4;
  const tokens = q.split(" ");
  if (tokens.length > 1 && tokens.every((t) => words.some((w) => w.startsWith(t)))) return 5;
  return null;
}

/**
 * The waypoints matching `query`, best first; equal ranks keep the file's own
 * order. An empty query matches nothing, so the list stays shut at rest.
 */
export function searchWaypoints(
  query: string,
  waypoints: readonly MapWaypoint[],
  limit = WAYPOINT_RESULT_LIMIT,
): MapWaypoint[] {
  const q = normalise(query);
  if (!q) return [];
  const hits: { wp: MapWaypoint; rank: number; index: number }[] = [];
  waypoints.forEach((wp, index) => {
    const r = rank(q, normalise(wp.code), normalise(wp.name));
    if (r !== null) hits.push({ wp, rank: r, index });
  });
  hits.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return hits.slice(0, limit).map((h) => h.wp);
}
