import type { TaskScoreData } from '@glidecomp/client/types';

/**
 * comp_pilot_id → why a HARD data-quality check withheld their track, read
 * from the published task scores (`track_excluded`). Empty while the scores
 * are not in hand: nothing is called withheld that the scorer did not say.
 */
export function withheldReasons(score: TaskScoreData | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const cls of score?.class_scores ?? []) {
    for (const p of cls.pilots) {
      if (p.track_excluded) out.set(p.comp_pilot_id, p.track_excluded.reasons);
    }
  }
  return out;
}
