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
import { Link, useParams, useSearchParams } from "react-router-dom";
import { NotFound } from "@/react/components/NotFound";
import { Button } from "@/react/rac/button";
import { Loading } from "@/react/rac/progress";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { Card } from "@/react/rac/card";
import { api } from "../../comp/api";
import { useAdminView, useUser } from "../lib/user";
import { underComp } from "../lib/crumbs";
import { idFromSegment, compPath, compScoresPath } from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { useSeededResource } from "../lib/use-seeded-resource";
import {
  ScoresEmptyState,
  ScoresViews,
  useCompScores,
} from "../comp/CompScoresSection";
import { ScoreFreshness } from "../comp/ScoreFreshness";
import { ScoresDownload } from "../comp/ScoresDownload";
import type { CompDetailData } from "../comp/types";
import { useInitialData } from "../lib/initial-data";
import type { CompScoresLoaderData } from "../loaders";

export function CompScoresPage() {
  const { compId: compParam } = useParams<{ compId: string }>();
  const compId = idFromSegment(compParam ?? "");
  const { user } = useUser();
  const [searchParams] = useSearchParams();
  // SSR seed: the server ran loadCompScores for this URL. Null on client
  // boot / SPA navigations, where the effects below fetch instead.
  const initial = useInitialData<CompScoresLoaderData>();
  const { data: comp, notFound } = useSeededResource<CompDetailData>({
    ids: [compId],
    seed: initial?.comp ?? null,
    load: ([comp_id]) => api.api.comp[":comp_id"].$get({ param: { comp_id } }),
    title: (c) => `GlideComp - ${c.name} scores`,
  });

  // Settle the address bar on the canonical `${slug}-${id}` once the name loads.
  useCanonicalPath(comp ? compScoresPath(compId, comp.name) : null);

  const { state, rescoring, rescore } = useCompScores(
    compId ?? "",
    initial?.scores ?? undefined,
    initial?.scoresEtag ?? undefined
  );

  const isAdmin = useAdminView(
    user != null && comp != null && comp.admins.some((a) => a.email === user.email)
  );

  if (notFound || !compId) {
    return <NotFound title="Competition not found" />;
  }

  if (!comp) {
    return (
      <Loading>Loading scores…</Loading>
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
        {state.kind === "ready" && state.scores.standings.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <ScoresDownload compId={compId} compName={comp.name} isTestComp={comp.test} />
            {isAdmin ? (
              <Button
                variant="outline"
                size="sm"
                onPress={() => void rescore()}
                isPending={rescoring}
                pendingLabel="Re-scoring"
              >
                Recompute scores
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* One card holds the whole scores apparatus: when it was computed, the
          view switcher, the table, and the caption under it. A card owns its
          controls and its caption — tabs that filter a table and a footnote
          that explains it belong INSIDE the panel they act on, not floating
          beside it. Only the hero above stays on the page ground, which is
          what the comp and task pages do too. */}
      <Card className="mt-6">
        {state.kind === "loading" ? (
          <Loading>Loading scores…</Loading>
        ) : state.kind === "unavailable" ? (
          <ScoresEmptyState isAdmin={isAdmin} tasksHref={`${compPath(compId, comp.name)}#tasks`} />
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
              <ScoresEmptyState
                isAdmin={isAdmin}
                tasksHref={`${compPath(compId, comp.name)}#tasks`}
              />
            ) : (
              <>
                <ScoresViews
                  scores={state.scores}
                  compId={compId}
                  compName={comp.name}
                  timezone={comp.timezone}
                  tasks={comp.tasks}
                  defaultTaskId={null}
                  deepLinkTaskId={searchParams.get("task")}
                />
                <p className="text-sm text-muted-foreground">
                  Click any score for a step-by-step explanation. Questions about a
                  score?{" "}
                  <Link
                    to={`${compPath(compId, comp.name)}#admins`}
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
      </Card>
    </div>
  );
}
