/**
 * Dedicated competition scores page (/comp/:id/scores) — the canonical public
 * scores surface. The comp page keeps only a compact standings summary that
 * links here; this page holds the full apparatus: per-class standings tabs,
 * Top 3 per task & class, Teams, and Results by task (which is the public
 * per-task results surface — task pages link here with ?task=<id>).
 *
 * Server-rendered like the other public comp pages (loadCompScores +
 * functions/comp/[[path]].ts); the views themselves live in
 * comp/CompScoresSection so this page and the comp summary share one
 * implementation.
 */
import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Button } from "@/react/rac/button";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { api } from "../../comp/api";
import { useAdminView, useUser } from "../lib/user";
import { underComp } from "../lib/crumbs";
import {
  ScoresEmptyState,
  ScoresViews,
  useCompScores,
} from "../comp/CompScoresSection";
import { ScoreFreshness } from "../comp/ScoreFreshness";
import { fetchWithRetry, type CompDetailData } from "../comp/types";
import { useInitialData } from "../lib/initial-data";
import type { CompScoresLoaderData } from "../loaders";

export function CompScoresPage() {
  const { compId } = useParams<{ compId: string }>();
  const { user } = useUser();
  const [searchParams] = useSearchParams();
  // SSR seed: the server ran loadCompScores for this URL. Null on client
  // boot / SPA navigations, where the effects below fetch instead.
  const initial = useInitialData<CompScoresLoaderData>();
  const [comp, setComp] = useState<CompDetailData | null>(initial?.comp ?? null);
  const [notFound, setNotFound] = useState(false);

  const { state, rescoring, rescore } = useCompScores(
    compId ?? "",
    initial?.scores ?? undefined,
    initial?.scoresEtag ?? undefined
  );

  useEffect(() => {
    if (!compId) {
      setNotFound(true);
      return;
    }
    if (initial) {
      document.title = `GlideComp - ${initial.comp.name} scores`;
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithRetry(() =>
          api.api.comp[":comp_id"].$get({ param: { comp_id: compId } })
        );
        if (cancelled) return;
        if (!res.ok) {
          setNotFound(true);
          return;
        }
        const data = (await res.json()) as unknown as CompDetailData;
        if (cancelled) return;
        setComp(data);
        document.title = `GlideComp - ${data.name} scores`;
      } catch {
        if (!cancelled) setNotFound(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `initial` is stable for the life of the SSR'd URL; compId is the real key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compId]);

  const isAdmin = useAdminView(
    user != null && comp != null && comp.admins.some((a) => a.email === user.email)
  );

  if (notFound || !compId) {
    return (
      <div>
        <p>Competition not found</p>
        <Link className="underline underline-offset-4" to="/comp">
          Back to Competitions
        </Link>
      </div>
    );
  }

  if (!comp) {
    return (
      <p role="status" aria-label="Loading scores" className="text-muted-foreground">
        Loading scores…
      </p>
    );
  }

  return (
    <div>
      <Breadcrumbs items={underComp(compId, comp.name)} current="Scores" />

      <div className="mt-2 flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold">Scores</h1>
          <p className="text-sm text-muted-foreground">{comp.name}</p>
        </div>
        {isAdmin && state.kind === "ready" && state.scores.standings.length > 0 ? (
          <Button
            variant="outline"
            size="sm"
            onPress={() => void rescore()}
            isDisabled={rescoring}
          >
            {rescoring ? "Re-scoring…" : "Recompute scores"}
          </Button>
        ) : null}
      </div>

      {state.kind === "loading" ? (
        <p className="mt-2 text-muted-foreground">Loading scores…</p>
      ) : state.kind === "unavailable" ? (
        <ScoresEmptyState isAdmin={isAdmin} tasksHref={`/comp/${compId}#tasks`} />
      ) : (
        <>
          <ScoreFreshness
            computedAt={state.scores.computed_at}
            stale={state.scores.stale}
            timezone={comp.timezone}
            etag={state.etag}
            pollUrl={`/api/comp/${encodeURIComponent(compId)}/scores`}
          />
          {state.scores.standings.length === 0 ? (
            <ScoresEmptyState isAdmin={isAdmin} tasksHref={`/comp/${compId}#tasks`} />
          ) : (
            <>
              <ScoresViews
                scores={state.scores}
                compId={compId}
                timezone={comp.timezone}
                tasks={comp.tasks}
                defaultTaskId={null}
                deepLinkTaskId={searchParams.get("task")}
              />
              <p className="mt-4 text-sm text-muted-foreground">
                Click any score for a step-by-step explanation. Questions about a
                score?{" "}
                <Link
                  to={`/comp/${compId}#admins`}
                  className="underline underline-offset-4"
                >
                  Ask the comp admins
                </Link>
                .
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
