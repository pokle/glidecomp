/**
 * When the scores on screen were computed, and whether a re-score is on its
 * way — the website's ScoreFreshness, in the same words. Scores are
 * stale-first, so a stale answer is the previous result, not a wrong one.
 */
import { formatInstant } from '@glidecomp/client/time';

import { Note } from './grouped-list';

export function Freshness({
  computedAt,
  stale,
  timeZone,
}: {
  computedAt: string | null;
  stale: boolean;
  timeZone: string | null;
}) {
  if (!computedAt) return <Note>Scores are being computed for the first time…</Note>;
  const when = `Scores computed ${formatInstant(new Date(computedAt), timeZone ?? undefined)}`;
  return <Note>{stale ? `${when}. Hold tight, scores are being re-scored…` : `${when}.`}</Note>;
}
