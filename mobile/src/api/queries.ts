/**
 * Every read the browse screens make, as TanStack queries over the typed
 * client. Responses are cast to the shared wire types in @glidecomp/client,
 * exactly as the website does: the Hono types prove the route exists, the
 * interfaces say what a screen may rely on.
 */
import type { PilotFlight, PilotProfile, PilotRegistration } from '@glidecomp/client/account';
import type { SearchResults } from '@glidecomp/client/search';
import type { IdentifierKind, OpenCompsResponse, RegistrationState } from '@glidecomp/client/submit';
import { MIN_SEARCH_CHARS } from '@glidecomp/client/search';
import type {
  CompDetailData,
  CompListEntry,
  CompScores,
  PilotAnalysisData,
  PilotListEntry,
  TaskDetailData,
  TaskScoreData,
} from '@glidecomp/client/types';
import type { TaskWeatherData } from '@glidecomp/client/weather';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { igcText } from '@/lib/igc-text';

import { api, apiFetch, getBytes, getJson } from './client';
import { API_ORIGIN } from './config';

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

export function useCompScores(compId: string, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['compScores', compId],
    enabled,
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

// ── The signed-in account's own (stage 4) ───────────────────────────────────
//
// Keyed by the account, so one account's answers are never read as another's,
// and off while signed out — there is nothing to ask.

/** The comps this account is on: "Yours", the comp's "You", "Your track". */
export function useRegistrations(userId: string | null) {
  return useQuery({
    queryKey: ['registrations', userId],
    enabled: userId !== null,
    queryFn: async ({ signal }) =>
      (
        await getJson<{ registrations: PilotRegistration[] }>(
          (s) => api.api.comp.pilot.registrations.$get(undefined, { init: { signal: s } }),
          signal,
        )
      ).registrations,
  });
}

/** Every flight this account has in a competition, newest task first. */
export function useMyFlights(userId: string | null) {
  return useQuery({
    queryKey: ['myFlights', userId],
    enabled: userId !== null,
    queryFn: async ({ signal }) =>
      (
        await getJson<{ flights: PilotFlight[] }>(
          (s) => api.api.comp.pilot.flights.$get(undefined, { init: { signal: s } }),
          signal,
        )
      ).flights,
  });
}

/** The pilot profile: name and contact, pilot IDs. */
export function useProfile(userId: string | null) {
  return useQuery({
    queryKey: ['profile', userId],
    enabled: userId !== null,
    queryFn: ({ signal }) =>
      getJson<PilotProfile>((s) => api.api.comp.pilot.$get(undefined, { init: { signal: s } }), signal),
  });
}

// ── Submitting a track (stage 5) ───────────────────────────────────────────

/**
 * The competitions open for submissions now, each with its tasks and the one
 * most likely meant — what the submit sheet's task step lists. Persisted like
 * every read, so a pilot who opened the app this morning can still pick a
 * task on a landing paddock with no signal.
 */
export function useOpenComps() {
  return useQuery({
    queryKey: ['openComps'],
    queryFn: async ({ signal }) =>
      (
        await getJson<OpenCompsResponse>(
          (s) => api.api.comp['open-now'].$get(undefined, { init: { signal: s } }),
          signal,
        )
      ).comps,
  });
}

/**
 * Which registration in a comp the signed-in pilot is, asked before a file is
 * chosen: the upload refuses to guess when the roster holds unclaimed entries
 * (409 identity_ambiguous), and a refusal after the file is chosen is a
 * refusal at the worst moment. Strictly read-only on the server, but a POST
 * (the identifier can be an email address), so a development build reading
 * production cannot ask — and cannot submit either.
 *
 * Not kept on the phone: it is the server's answer for this moment, and a
 * claim made since would make yesterday's "choose" wrong.
 */
export function useRegistrationState(
  compId: string | null,
  userId: string | null,
  identifier: { kind: IdentifierKind; value: string } | null,
) {
  return useQuery({
    queryKey: ['registrationState', compId, userId, identifier],
    enabled: compId !== null && userId !== null,
    meta: { persist: false },
    staleTime: 60_000,
    queryFn: ({ signal }) =>
      getJson<RegistrationState>(
        (s) =>
          apiFetch(`${API_ORIGIN}/api/comp/${encodeURIComponent(compId!)}/registration/resolve`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(identifier ? { identifier } : {}),
            signal: s,
          }),
        signal,
      ),
  });
}

/** A comp's roster, for an organiser (or a pilot the comp lets) submitting on someone's behalf. */
export function useRoster(compId: string | null, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['roster', compId],
    enabled: enabled && compId !== null,
    queryFn: async ({ signal }) =>
      (
        await getJson<{ pilots: PilotListEntry[] }>(
          (s) => api.api.comp[':comp_id'].pilot.$get({ param: { comp_id: compId! } }, { init: { signal: s } }),
          signal,
        )
      ).pilots,
  });
}
