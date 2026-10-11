/**
 * The report card's four payloads, and the narrative built from them by the
 * same function the website calls (`buildReportCard` in @glidecomp/client):
 * there is one derivation, so the two cannot disagree about a number.
 *
 * The report card is several screens (the summary, a section, the map), and
 * each calls this. The queries are shared, so the payloads are fetched once.
 */
import { buildReportCard, ScorePendingError, type ReportCard } from '@glidecomp/client/report-card';
import { parseIGC, type IGCFix } from '@glidecomp/engine';
import type { UseQueryResult } from '@tanstack/react-query';
import { useMemo } from 'react';

import { ApiError, isNotFound } from '@/api/client';
import { useComp, usePilotAnalysis, useTask, useTaskScore, useTracklog } from '@/api/queries';

export type ReportCardState =
  | { kind: 'loading' }
  /** The pilot's track is in, but the served scores predate it: a wait. */
  | { kind: 'pending' }
  | { kind: 'not-found' }
  /** No signal, or the server failed, and nothing on the phone to show. */
  | { kind: 'error'; retry: () => void }
  /** The payloads arrived but say there is nothing to explain. */
  | { kind: 'unavailable'; message: string }
  | { kind: 'ready'; card: ReportCard };

export function useReportCard(compId: string, taskId: string, pilotId: string) {
  const comp = useComp(compId);
  const task = useTask(compId, taskId);
  const score = useTaskScore(compId, taskId);
  const analysis = usePilotAnalysis(compId, taskId, pilotId);
  const queries: UseQueryResult<unknown>[] = [comp, task, score, analysis];

  const state = useMemo((): ReportCardState => {
    if (comp.data && task.data && score.data && analysis.data) {
      try {
        return { kind: 'ready', card: buildReportCard(comp.data, task.data, score.data, analysis.data, pilotId) };
      } catch (err) {
        if (err instanceof ScorePendingError) return { kind: 'pending' };
        return { kind: 'unavailable', message: err instanceof Error ? err.message : 'This score can’t be explained.' };
      }
    }
    // A dead id, or a pilot with no result on this task: nothing will
    // re-fetch its way out of that, so say so rather than spin.
    if (queries.some((q) => q.data === undefined && isNotFound(q.error))) return { kind: 'not-found' };
    if (queries.some((q) => q.data === undefined && q.isError)) {
      return { kind: 'error', retry: () => queries.forEach((q) => q.isError && q.refetch()) };
    }
    return { kind: 'loading' };
    // The query objects change identity every render; their data and errors
    // are what the state is made of.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comp.data, task.data, score.data, analysis.data, comp.error, task.error, score.error, analysis.error, pilotId]);

  return { state, score, queries };
}

/**
 * The parsed tracklog, or null while it loads, when it fails, or for a manual
 * flight that has none. Everything that uses it degrades without it.
 */
export function useFixes(compId: string, taskId: string, pilotId: string): {
  fixes: IGCFix[] | null;
  /** True once the download has finished, whichever way. */
  settled: boolean;
  /** True when there is no file at all (a manual flight), not a failure. */
  missing: boolean;
} {
  const tracklog = useTracklog(compId, taskId, pilotId);
  const fixes = useMemo(() => {
    if (!tracklog.data) return null;
    try {
      const parsed = parseIGC(tracklog.data).fixes;
      return parsed.length > 0 ? parsed : null;
    } catch {
      return null;
    }
  }, [tracklog.data]);
  return {
    fixes,
    settled: tracklog.isSuccess || tracklog.isError,
    missing: tracklog.error instanceof ApiError && tracklog.error.status === 404,
  };
}
