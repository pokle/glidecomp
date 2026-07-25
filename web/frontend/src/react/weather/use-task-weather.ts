/**
 * Fetch a task's weather, polling while the server is still fetching it.
 *
 * A separate request from the field analysis, deliberately. The two are
 * independent caches with independent failure modes: an Open-Meteo outage
 * must not stop the behavioural metrics rendering, and a task too big to
 * analyse should still show what the day did. Folding weather into the
 * analysis response would have coupled them at exactly the point where
 * independence is worth most.
 *
 * The polling mirrors the field-analysis page's: the cold path never fetches
 * synchronously on the server, so a first view legitimately answers
 * `pending: true` and the answer arrives a second or two later.
 */
import { useEffect, useState } from "react";
import type { TaskWeatherData } from "./types";

/** How long between polls while the server reports `pending`. */
const POLL_MS = 3000;

/** Give up polling after this many attempts — a background fetch that hasn't
 * landed in half a minute has failed in a way a spinner can't fix, and the
 * next page view will retry (or hit the store's backoff). */
const MAX_POLLS = 10;

export interface TaskWeatherState {
  data: TaskWeatherData | null;
  /** First load in flight; distinct from `data.pending` (server-side fetch). */
  loading: boolean;
}

export function useTaskWeather(
  compId: string | null,
  taskId: string | null
): TaskWeatherState {
  const [data, setData] = useState<TaskWeatherData | null>(null);
  const [loading, setLoading] = useState(true);
  const [polls, setPolls] = useState(0);

  useEffect(() => {
    if (!compId || !taskId) {
      setLoading(false);
      return;
    }
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(
          `/api/comp/${encodeURIComponent(compId)}/task/${encodeURIComponent(taskId)}/weather`,
          { credentials: "include" }
        );
        if (cancelled) return;
        if (!res.ok) {
          // A 404 here means the comp is hidden from this viewer, or the task
          // is gone. Either way there is nothing to show and nothing to
          // retry; the panel simply omits the weather group.
          setData(null);
          setLoading(false);
          return;
        }
        const body = (await res.json()) as TaskWeatherData;
        if (cancelled) return;
        setData(body);
        setLoading(false);
        if (body.pending && polls < MAX_POLLS) {
          setTimeout(() => {
            if (!cancelled) setPolls((n) => n + 1);
          }, POLL_MS);
        }
      } catch {
        if (!cancelled) {
          setData(null);
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [compId, taskId, polls]);

  return { data, loading };
}
