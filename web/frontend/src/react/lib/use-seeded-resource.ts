/**
 * The load every SSR'd comp page does.
 *
 * The eight server-rendered comp pages all open the same way: the server ran
 * the route's loader and embedded the result, so the first render has its data
 * already; a client boot or an SPA navigation has nothing and must fetch. Each
 * page had written that out by hand — the seed check, the `cancelled` flag, the
 * not-found branches, the title — and the copies had begun to drift.
 *
 * Three things this centralises that a copy keeps getting slightly wrong:
 *
 *   - **The stale verdict.** react-router keeps a page mounted when only the id
 *     in the path changes, so a `notFound` left over from the previous id masks
 *     whatever the new one loads. That is not hypothetical: the 404 page's
 *     "did you mean" links point back at these very routes, so following one
 *     changed the URL and nothing else. The verdict is cleared before each load.
 *   - **Retry, then decide.** The fetch goes through `fetchWithRetry`, so a
 *     dropped request is not filed as "no such competition" — a terminal state
 *     nothing re-fetches (issue #481).
 *   - **The seed is for the first render only.** A mutation bumps `refresh`,
 *     which fetches past the seed rather than re-rendering the server's copy.
 *
 * ## What deliberately does NOT use this
 *
 * The two task-analysis pages keep their own loader: they answer with a
 * five-way status (`forbidden` for a hidden test comp, a synthetic body for the
 * 422 "cannot be analysed") that this hook's plain found/not-found would have
 * to grow branches to express. `PilotScoreDetail` likewise resolves four
 * requests into one derived narrative and distinguishes "scores are still
 * computing" from "no such pilot". `CompWaypoints` fetches two resources in
 * parallel and writes five pieces of state from them.
 *
 * Those are different questions, not the same question written differently, and
 * folding them in would buy a shared name at the cost of a hook that branches
 * per caller.
 */
import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { fetchWithRetry } from "../comp/types";

/** The minimum of a Response this hook needs — Hono's RPC replies qualify. */
interface JsonResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export interface SeededResource<T> {
  /** The resource, or null while it is still on its way. */
  data: T | null;
  /**
   * The id named nothing that resolves — a dead URL. Render `NotFound`, which
   * reads the words back out of the path and offers what does resolve.
   */
  notFound: boolean;
  /** For optimistic local edits; the next load overwrites them. */
  setData: Dispatch<SetStateAction<T | null>>;
}

export function useSeededResource<T>({
  ids,
  seed,
  load,
  title,
  refresh = 0,
}: {
  /**
   * The ids the resource is keyed on. A missing one is a URL that never named
   * anything — answered directly, without spending a request to be told so.
   */
  ids: (string | undefined | null)[];
  /** The SSR seed for this URL, or null on a client boot / SPA navigation. */
  seed: T | null;
  /** Fetch the resource. Only called when there is no usable seed. */
  load: (ids: string[]) => Promise<JsonResponse>;
  /** The document title for a loaded resource. */
  title?: (data: T) => string;
  /** Bumped by a mutation to force a fetch past the seed. */
  refresh?: number;
}): SeededResource<T> {
  const [data, setData] = useState<T | null>(seed);
  const [notFound, setNotFound] = useState(false);

  // Join the ids so the effect keys on their values rather than on the array's
  // identity, which is fresh on every render.
  const idKey = ids.join("§");

  useEffect(() => {
    setNotFound(false);

    const resolved = ids.filter((id): id is string => !!id);
    if (resolved.length !== ids.length) {
      setNotFound(true);
      return;
    }

    // Seeded by the server for this URL: the data is already in state from the
    // initial useState. Name the tab and skip the round trip.
    if (seed && refresh === 0) {
      if (title) document.title = title(seed);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithRetry(() => load(resolved));
        if (cancelled) return;
        if (!res.ok) {
          setNotFound(true);
          return;
        }
        const body = (await res.json()) as T;
        if (cancelled) return;
        setData(body);
        if (title) document.title = title(body);
      } catch {
        // Every retry was dropped. Better to say the page is not there than to
        // render an empty one that looks like real, empty data.
        if (!cancelled) setNotFound(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `seed` is stable for the life of the SSR'd URL, and `load`/`title` are
    // fresh closures each render; the ids and the refresh counter are the real
    // key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idKey, refresh]);

  return { data, notFound, setData };
}
