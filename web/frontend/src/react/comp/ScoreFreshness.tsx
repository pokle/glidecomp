/**
 * Score freshness UI for the stale-first score store
 * (docs/score-caching-stale-first-plan.md): every scores surface shows when
 * its scores were computed, and says so plainly while a re-score is in
 * flight. When the response is stale this renders the "Hold tight" notice
 * and polls the same endpoint with `If-None-Match` — 304s while the
 * re-score runs (one D1 row read, no body, never triggers extra compute),
 * flipping to "Re-score finished [Reload]" when the ETag changes. No silent
 * data swap: rankings reordering under the reader is more disorienting
 * than an explicit reload.
 */
import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/react/ui/alert";
import { Button } from "@/react/ui/button";
import { formatComputedAt } from "../lib/time";

/** Poll cadence: every ~4s backing off to ~15s, giving up after ~2 minutes
 * (the notice stays; the next manual reload picks up whatever is newest). */
const POLL_INITIAL_MS = 4_000;
const POLL_MAX_MS = 15_000;
const POLL_BACKOFF = 1.6;
const POLL_GIVE_UP_MS = 120_000;

type RescoreState = "idle" | "rescoring" | "landed";

/**
 * While `stale`, conditionally poll `url` with the stale body's ETag until
 * the re-score lands (a 200 means the stored state_key changed). Pauses
 * while the tab is hidden and resumes on return.
 */
function useRescorePoll(
  stale: boolean,
  etag: string | null,
  url: string | null
): RescoreState {
  const [state, setState] = useState<RescoreState>(stale ? "rescoring" : "idle");

  useEffect(() => {
    if (!stale) {
      setState("idle");
      return;
    }
    setState("rescoring");
    // Without an ETag or URL we can't poll cheaply — leave the notice up;
    // the reader's next reload shows whatever is newest.
    if (!etag || !url) return;

    let cancelled = false;
    let timer: number | undefined;
    let delay = POLL_INITIAL_MS;
    const deadline = Date.now() + POLL_GIVE_UP_MS;

    const schedule = () => {
      if (cancelled || document.hidden || Date.now() > deadline) return;
      timer = window.setTimeout(poll, delay);
      delay = Math.min(delay * POLL_BACKOFF, POLL_MAX_MS);
    };

    const poll = async () => {
      if (cancelled || document.hidden) return;
      try {
        const res = await fetch(url, {
          headers: { "If-None-Match": etag },
          credentials: "include",
        });
        if (cancelled) return;
        if (res.ok) {
          // The served identity changed — the re-score landed. (The ETag
          // folds the staleness label in, so this fires even for a re-score
          // that reproduced identical scores.)
          setState("landed");
          return;
        }
        // 304: same stale body, still re-scoring. Anything else: keep trying.
      } catch {
        // Transient network error — keep polling.
      }
      schedule();
    };

    const onVisibility = () => {
      if (cancelled) return;
      window.clearTimeout(timer);
      if (!document.hidden && Date.now() <= deadline) void poll();
    };
    document.addEventListener("visibilitychange", onVisibility);
    schedule();

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [stale, etag, url]);

  return state;
}

export function ScoreFreshness({
  computedAt,
  stale,
  timezone,
  etag = null,
  pollUrl = null,
}: {
  /** ISO compute timestamp; null (comp with no scored tasks) renders nothing. */
  computedAt: string | null;
  stale: boolean;
  /** Comp-local IANA zone for the timestamp; UTC when unset. */
  timezone: string | null;
  /** ETag of the (stale) body being shown — enables conditional polling. */
  etag?: string | null;
  /** Endpoint to poll for the re-score landing; usually the one that served the data. */
  pollUrl?: string | null;
}) {
  const rescore = useRescorePoll(stale, etag, pollUrl);

  if (!computedAt) return null;

  return (
    <div className="mt-2 space-y-2">
      <p className="text-sm text-muted-foreground">
        Scores computed {formatComputedAt(computedAt, timezone)}
      </p>
      {rescore === "rescoring" ? (
        <Alert role="status" aria-live="polite">
          <AlertTitle>Hold tight, scores are being re-scored…</AlertTitle>
          <AlertDescription>
            Something changed (a track, a penalty, or the task). The scores
            below were computed before that change and may shift slightly.
          </AlertDescription>
        </Alert>
      ) : null}
      {rescore === "landed" ? (
        <Alert role="status" aria-live="polite">
          <AlertTitle>
            Re-score finished{" "}
            <Button
              type="button"
              size="sm"
              className="ml-2"
              onClick={() => window.location.reload()}
            >
              Reload
            </Button>
          </AlertTitle>
          <AlertDescription>
            Updated scores are ready — reload to see them.
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
