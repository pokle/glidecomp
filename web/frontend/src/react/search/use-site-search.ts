/**
 * The competitions page's search: one query box over comps, tasks, routes and
 * pilots, answered by GET /api/comp/search.
 *
 * Three things this hook is careful about:
 *
 * - **Superseding.** Every keystroke would otherwise be a request, and they
 *   can land out of order. Queries are debounced and each new one aborts the
 *   one before it, so the results always belong to the text on screen.
 * - **A failure to ask is not an answer.** A dropped request is retried
 *   (fetchWithRetry) and, if it still fails, reported as "search is
 *   unavailable" — never as "no matches", which is a different fact and the
 *   one a visitor would act on.
 * - **The last good answer stays up** while the next one is in flight, so the
 *   list does not blink empty between keystrokes.
 */
import { useEffect, useRef, useState } from "react";
import { api } from "../../comp/api";
import { fetchWithRetry } from "../comp/types";

/** Below this many characters, the server is not asked at all. */
export const MIN_SEARCH_CHARS = 2;

/** Quiet time before a query is sent. Long enough that ordinary typing sends
 *  one request, short enough to feel immediate. */
const DEBOUNCE_MS = 200;

export interface SearchPilot {
  comp_pilot_id: string;
  name: string;
}

export interface SearchTask {
  task_id: string;
  name: string;
  task_date: string;
  matched: boolean;
  matched_turnpoints: string[];
  pilots: SearchPilot[];
  pilot_count: number;
}

export interface SearchComp {
  comp_id: string;
  name: string;
  category: string;
  test: boolean;
  scoring_format: string;
  matched: boolean;
  task_count: number;
  tasks: SearchTask[];
  pilots: SearchPilot[];
}

export interface SearchResults {
  terms: string[];
  comps: SearchComp[];
  truncated: boolean;
}

export type SearchState =
  /** Nothing asked for — the query is too short, or empty. */
  | { status: "idle" }
  /** A request is in flight. `results` is the previous answer, if any. */
  | { status: "searching"; results: SearchResults | null }
  | { status: "ready"; results: SearchResults }
  | { status: "error" };

export function useSiteSearch(query: string): SearchState {
  const [state, setState] = useState<SearchState>({ status: "idle" });
  // The last answer, kept across queries so the list does not blink empty.
  const lastResults = useRef<SearchResults | null>(null);

  const trimmed = query.trim();

  useEffect(() => {
    if (trimmed.length < MIN_SEARCH_CHARS) {
      lastResults.current = null;
      setState({ status: "idle" });
      return;
    }

    const controller = new AbortController();
    setState({ status: "searching", results: lastResults.current });

    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetchWithRetry(
            () =>
              api.api.comp.search.$get(
                { query: { q: trimmed } },
                { init: { signal: controller.signal } }
              ),
            { signal: controller.signal }
          );
          if (controller.signal.aborted) return;
          if (!res.ok) {
            setState({ status: "error" });
            return;
          }
          const results = (await res.json()) as SearchResults;
          if (controller.signal.aborted) return;
          lastResults.current = results;
          setState({ status: "ready", results });
        } catch {
          // An abort is this hook superseding itself, not a failure: the
          // request that replaced this one owns the state now.
          if (controller.signal.aborted) return;
          setState({ status: "error" });
        }
      })();
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed]);

  return state;
}
