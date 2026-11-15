/**
 * Dedicated competition scores page (/comp/:id/scores) — the canonical public
 * scores surface. The comp page keeps only a compact scores summary that
 * links here; this page holds the full apparatus: per-class scores tabs,
 * Top 3 per task & class, Teams, and Scores by task (which is the public
 * per-task scores surface — task pages link here with ?task=<id>).
 *
 * Server-rendered like the other public comp pages (loadCompScores +
 * functions/comp/[[path]].ts); the views themselves live in
 * comp/CompScoresSection so this page and the comp summary share one
 * implementation.
 *
 * The page is the scores; what a reader can DO with them is in the bar (issue
 * #863): the downloads and, for an organiser, "Recompute scores" under ⋯, and
 * the view tabs in the bar's second layer, where they stay in reach down a
 * long table.
 */
import { Link, useParams, useSearchParams } from "react-router-dom";
import { NotFound } from "@/react/components/NotFound";
import { ActionErrorBanner } from "@/react/rac/form";
import { Page, PageBar, type BarAction } from "@/react/rac/page-bar";
import { Loading, Spinner } from "@/react/rac/progress";
import { Card } from "@/react/rac/card";
import { Tabs, TabsContent } from "@/react/rac/tabs";
import { api } from "../../comp/api";
import { useAdminView } from "../lib/user";
import { compPages, underComp } from "../lib/crumbs";
import { compUrlId, idFromSegment, compPath, compScoresPath } from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { useSeededResource } from "../lib/use-seeded-resource";
import {
  ScoresEmptyState,
  useCompScores,
  useScoresViews,
} from "../comp/CompScoresSection";
import { ScoreFreshness } from "../comp/ScoreFreshness";
import { useScoresDownload } from "../comp/ScoresDownload";
import type { CompDetailData } from "../comp/types";
import { useInitialData } from "../lib/initial-data";
import type { CompScoresLoaderData } from "../loaders";
import { RefreshCwIcon } from "lucide-react";

export function CompScoresPage() {
  const { compId: compParam } = useParams<{ compId: string }>();
  const compId = idFromSegment(compParam ?? "");
  const [searchParams] = useSearchParams();
  // SSR seed: the server ran loadCompScores for this URL. Null on client
  // boot / SPA navigations, where the effects below fetch instead.
  const initial = useInitialData<CompScoresLoaderData>();
  const { data: comp, notFound, current } = useSeededResource<CompDetailData>({
    ids: [compId],
    seed: initial?.comp ?? null,
    load: ([comp_id]) => api.api.comp[":comp_id"].$get({ param: { comp_id } }),
    title: (c) => `GlideComp - ${c.name} scores`,
  });

  // Settle the address bar on the canonical `${slug}-${id}` once the name loads
  // (for THIS id, not the one the page was on before).
  useCanonicalPath(
    comp && current ? compScoresPath(compUrlId(comp, compId), comp.name) : null
  );

  const { state, rescoring, rescore } = useCompScores(
    compId ?? "",
    initial?.scores ?? undefined,
    initial?.scoresEtag ?? undefined
  );

  const isAdmin = useAdminView(!!comp?.is_admin);
  // As it goes in URLs: a hidden comp's share key rides along.
  const urlId = compUrlId(comp, compId);

  const download = useScoresDownload({
    compId: urlId,
    compName: comp?.name,
    isTestComp: comp?.test,
  });

  // There is something to download, or to recompute, once a class has scores.
  const hasScores = !!comp && state.kind === "ready" && state.scores.class_scores.length > 0;
  const views = useScoresViews({
    scores: hasScores ? state.scores : null,
    compId,
    compName: comp?.name ?? null,
    timezone: comp?.timezone ?? null,
    tasks: comp?.tasks ?? [],
    defaultTaskId: null,
    deepLinkTaskId: searchParams.get("task"),
  });

  if (notFound || !compId) {
    return <NotFound title="Competition not found" />;
  }

  const actions: BarAction[] = [];
  if (hasScores) {
    actions.push(...download.actions);
    if (isAdmin) {
      actions.push({
        id: "recompute",
        icon: RefreshCwIcon,
        label: "Recompute scores",
        group: true,
        // One recompute at a time: the bar's spinner says it is under way.
        disabled: rescoring.pending,
        onAction: () => void rescore(),
      });
    }
  }

  // The Tabs wraps the page, so the tab strip can be the bar's second layer
  // and the panels the page's content. It is there (and empty) before the
  // scores are, so the bar is never remounted.
  return (
    <Tabs {...views.tabsProps} className="gap-0">
      <Page
        width="wide"
        bar={
          <PageBar
            title="Scores"
            trail={underComp(urlId, comp?.name)}
            related={compPages(urlId, comp, isAdmin, "Scores")}
            status={rescoring.pending ? <Spinner label="Recomputing scores" /> : undefined}
            actions={actions}
            below={views.tabList ?? undefined}
          />
        }
      >
        <TabsContent>
        <ActionErrorBanner action={rescoring} className="mb-3" />
        {download.dialog}

        {!comp ? (
          <Loading>Loading scores…</Loading>
        ) : (
          /* One card holds the whole scores apparatus: when it was computed,
             the table, and the caption under it. The view switcher that led
             it is the bar's second layer now. The scroll margin keeps a link
             or a column header reached by keyboard out from under the bar and
             the tabs that stick with it (WCAG 2.4.11, Focus Not Obscured). */
          <Card className="[&_a]:scroll-mt-32 [&_button]:scroll-mt-32 [&_th]:scroll-mt-32">
            {state.kind === "loading" ? (
              <Loading>Loading scores…</Loading>
            ) : state.kind === "unavailable" ? (
              <ScoresEmptyState
                isAdmin={isAdmin}
                tasksHref={`${compPath(urlId, comp.name)}#tasks`}
              />
            ) : (
              <>
                <ScoreFreshness
                  computedAt={state.scores.computed_at}
                  stale={state.scores.stale}
                  timezone={comp.timezone}
                  etag={state.etag}
                  pollUrl={`/api/comp/${encodeURIComponent(compId)}/scores`}
                />
                {state.scores.class_scores.length === 0 ? (
                  <ScoresEmptyState
                    isAdmin={isAdmin}
                    tasksHref={`${compPath(urlId, comp.name)}#tasks`}
                  />
                ) : (
                  <>
                    {views.panels}
                    <p className="text-sm text-muted-foreground">
                      {/* "Click any score for a step-by-step explanation" was
                          here too — the tables each already say it directly
                          under themselves. */}
                      Questions about a score?{" "}
                      <Link
                        to={`${compPath(urlId, comp.name)}#admins`}
                        className="underline underline-offset-4"
                      >
                        Ask the organisers
                      </Link>
                      .
                    </p>
                  </>
                )}
              </>
            )}
          </Card>
        )}
        </TabsContent>
      </Page>
    </Tabs>
  );
}
