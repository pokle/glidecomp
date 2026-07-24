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
import { Button } from "@/react/rac/button";
import { Timestamp } from "../components/Timestamp";

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

/**
 * Complete sentences per variant — NOT word-splicing. "Scores" is plural and
 * "analysis" is singular, so templating a noun into shared copy produced
 * "Analysis are being computed…"; live-region text is read aloud verbatim.
 */
const COPY = {
  scores: {
    computedPrefix: "Scores computed",
    pendingTitle: "Scores are being computed for the first time…",
    staleTitle: "Hold tight, scores are being re-scored…",
    staleBody:
      "Something changed (a track, a penalty, or the task). The scores below were computed before that change and may shift slightly.",
    landedTitle: "Re-score finished",
    landedBody: "Updated scores are ready — reload to see them.",
  },
  analysis: {
    computedPrefix: "Analysis computed",
    pendingTitle: "The field analysis is pending…",
    staleTitle: "Hold tight, the analysis is being recomputed…",
    staleBody:
      "Something changed (a track, a penalty, or the task). The analysis below was computed before that change and may shift slightly.",
    landedTitle: "Recompute finished",
    landedBody: "The updated analysis is ready — reload to see it.",
  },
} as const;

export function ScoreFreshness({
  computedAt,
  stale,
  timezone,
  etag = null,
  pollUrl = null,
  variant = "scores",
  pending = false,
}: {
  /** ISO compute timestamp; null (comp with no scored tasks) renders nothing,
   * unless `pending` — a first-ever compute has no timestamp yet. */
  computedAt: string | null;
  stale: boolean;
  /** Comp IANA zone; the timestamp defaults to it, else the viewer's local zone. */
  timezone: string | null;
  /** ETag of the (stale) body being shown — enables conditional polling. */
  etag?: string | null;
  /** Endpoint to poll for the re-score landing; usually the one that served the data. */
  pollUrl?: string | null;
  /** Which copy set to use. Field analysis passes "analysis". */
  variant?: keyof typeof COPY;
  /** No previous result at all (the field-analysis cold path, which never
   * computes on the request). Shows "being computed for the first time"
   * rather than a stale-results warning about results that don't exist. */
  pending?: boolean;
}) {
  const copy = COPY[variant];
  const rescore = useRescorePoll(stale, etag, pollUrl);

  if (pending) {
    return (
      <div className="mt-2">
        <Alert role="status" aria-live="polite">
          <AlertTitle>{copy.pendingTitle}</AlertTitle>
          <AlertDescription>
            {variant === "analysis"
              ? "It runs in the background over every pilot's tracklog. This page refreshes itself when it lands — usually within a few minutes. If it hasn't appeared, come back and reload in about 10 minutes."
              : "This runs in the background and usually lands within a minute; this page refreshes itself when it does."}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!computedAt) return null;

  return (
    <div className="mt-2 space-y-2">
      <p className="text-sm text-muted-foreground">
        {copy.computedPrefix}{" "}
        <Timestamp value={computedAt} compTimezone={timezone} />
      </p>
      {rescore === "rescoring" ? (
        <Alert role="status" aria-live="polite">
          <AlertTitle>{copy.staleTitle}</AlertTitle>
          <AlertDescription>{copy.staleBody}</AlertDescription>
        </Alert>
      ) : null}
      {rescore === "landed" ? (
        <Alert role="status" aria-live="polite">
          <AlertTitle>
            {copy.landedTitle}{" "}
            <Button
              size="sm"
              className="ml-2"
              onPress={() => window.location.reload()}
            >
              Reload
            </Button>
          </AlertTitle>
          <AlertDescription>{copy.landedBody}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
