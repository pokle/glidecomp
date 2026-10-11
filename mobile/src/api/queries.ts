/**
 * Every read the browse screens make, as TanStack queries over the typed
 * client. Responses are cast to the shared wire types in @glidecomp/client,
 * exactly as the website does: the Hono types prove the route exists, the
 * interfaces say what a screen may rely on.
 */
import type { SearchResults } from '@glidecomp/client/search';
import { MIN_SEARCH_CHARS } from '@glidecomp/client/search';
import type { CompDetailData, CompListEntry, TaskDetailData } from '@glidecomp/client/types';
import type { TaskWeatherData } from '@glidecomp/client/weather';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { api, getJson } from './client';

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
