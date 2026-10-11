/**
 * Every read the browse screens make, as TanStack queries over the typed
 * client. Responses are cast to the shared wire types in @glidecomp/client,
 * exactly as the website does: the Hono types prove the route exists, the
 * interfaces say what a screen may rely on.
 */
import type { SearchResults } from '@glidecomp/client/search';
import { MIN_SEARCH_CHARS } from '@glidecomp/client/search';
import type {
  CompDetailData,
  CompListEntry,
  CompScores,
  PilotAnalysisData,
  TaskDetailData,
  TaskScoreData,
} from '@glidecomp/client/types';
import type { TaskWeatherData } from '@glidecomp/client/weather';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { igcText } from '@/lib/igc-text';

import { api, getBytes, getJson } from './client';

export function useComps() {
  return useQuery({
    queryKey: ['comps'],
    queryFn: async ({ signal }) =>
      (await getJson<{ comps: CompListEntry[] }>((s) => api.api.comp.$get(undefined, { init: { signal: s } }), signal)).comps,
  });
}

export function useComp(compId: string) {
  return useQuery({
    queryKey: ['comp', compId],
    queryFn: ({ signal }) =>
      getJson<CompDetailData>(
        (s) => api.api.comp[':comp_id'].$get({ param: { comp_id: compId } }, { init: { signal: s } }),
        signal,
      ),
  });
}

export function useTask(compId: string, taskId: string) {
  return useQuery({
    queryKey: ['task', compId, taskId],
    queryFn: ({ signal }) =>
      getJson<TaskDetailData>(
        (s) =>
          api.api.comp[':comp_id'].task[':task_id'].$get(
            { param: { comp_id: compId, task_id: taskId } },
            { init: { signal: s } },
          ),
        signal,
      ),
  });
}

/**
 * Task weather is stale-first on the server: a task nobody has asked about
 * answers `pending` and fetches in the background. Poll until it arrives, as
 * the website does.
 */
export function useTaskWeather(compId: string, taskId: string) {
  return useQuery({
    queryKey: ['weather', compId, taskId],
    queryFn: ({ signal }) =>
      getJson<TaskWeatherData>(
        (s) =>
          api.api.comp[':comp_id'].task[':task_id'].weather.$get(
            { param: { comp_id: compId, task_id: taskId } },
            { init: { signal: s } },
          ),
        signal,
      ),
    refetchInterval: (query) => (query.state.data?.pending ? 5_000 : false),
  });
}

export function useSearch(query: string) {
  const q = query.trim();
  return useQuery({
    queryKey: ['search', q],
    enabled: q.length >= MIN_SEARCH_CHARS,
    queryFn: ({ signal }) =>
      getJson<SearchResults>(
        (s) => api.api.comp.search.$get({ query: { q } }, { init: { signal: s } }),
        signal,
      ),
    // Keep the last answer on screen while the next one is on its way.
    placeholderData: keepPreviousData,
    // A search is a question asked now, not a page to keep for the hill.
    gcTime: 5 * 60_000,
  });
}

/**
 * Scores are stale-first: a read never computes, and while a re-score is in
 * flight the server answers with the last result marked `stale`. Poll until
 * it lands, as the website's ScoreFreshness does.
 */
const STALE_POLL_MS = 8_000;

export function useCompScores(compId: string) {
  return useQuery({
    queryKey: ['compScores', compId],
    queryFn: ({ signal }) =>
      getJson<CompScores>(
        (s) => api.api.comp[':comp_id'].scores.$get({ param: { comp_id: compId } }, { init: { signal: s } }),
        signal,
      ),
    refetchInterval: (query) => (query.state.data?.stale ? STALE_POLL_MS : false),
  });
}

export function useTaskScore(compId: string, taskId: string) {
  return useQuery({
    queryKey: ['taskScore', compId, taskId],
    queryFn: ({ signal }) =>
      getJson<TaskScoreData>(
        (s) =>
          api.api.comp[':comp_id'].task[':task_id'].score.$get(
            { param: { comp_id: compId, task_id: taskId } },
            { init: { signal: s } },
          ),
        signal,
      ),
    refetchInterval: (query) => (query.state.data?.stale ? STALE_POLL_MS : false),
  });
}

/** The pilot's resolved flight on a task: what the report card narrates. */
export function usePilotAnalysis(compId: string, taskId: string, pilotId: string) {
  return useQuery({
    queryKey: ['pilotAnalysis', compId, taskId, pilotId],
    queryFn: ({ signal }) =>
      getJson<PilotAnalysisData>(
        (s) =>
          api.api.comp[':comp_id'].task[':task_id'].pilot[':comp_pilot_id'].analysis.$get(
            { param: { comp_id: compId, task_id: taskId, comp_pilot_id: pilotId } },
            { init: { signal: s } },
          ),
        signal,
      ),
  });
}

/**
 * A pilot's tracklog as IGC text, for the report card's map and its data
 * cleaning chart. The narrative never needs it, so nothing waits on it.
 *
 * Kept out of the persisted cache (`meta.persist`): a tracklog is up to a
 * megabyte, and the phone is better spent keeping the comps a reader looked
 * at than the files behind them.
 */
export function useTracklog(compId: string, taskId: string, pilotId: string) {
  return useQuery({
    queryKey: ['tracklog', compId, taskId, pilotId],
    meta: { persist: false },
    gcTime: 10 * 60_000,
    staleTime: Infinity,
    queryFn: async ({ signal }) =>
      igcText(
        await getBytes(
          (s) =>
            api.api.comp[':comp_id'].task[':task_id'].igc[':comp_pilot_id'].download.$get(
              { param: { comp_id: compId, task_id: taskId, comp_pilot_id: pilotId } },
              { init: { signal: s } },
            ),
          signal,
        ),
      ),
  });
}
