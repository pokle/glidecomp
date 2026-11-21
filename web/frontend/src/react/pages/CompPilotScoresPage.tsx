/**
 * One pilot's scores in a competition (/comp/:id/scores/:pilot): where they
 * stand in their class, their total, and a row per task that opens the task's
 * report card.
 *
 * The middle level of the scores hierarchy. The scores page lists the field,
 * a row per pilot; this page lists one pilot's tasks; the report card explains
 * one task. It is what the scores page's rows open, in place of the six score
 * links a row used to carry, each 18 px tall (Apple's HIG: a list row leads
 * one level down, and the whole row is the target).
 *
 * Under FTV it is also where a pilot reads which of their tasks counted, in
 * full or in part, and which were discarded — the explanation that used to be
 * a dialog behind a "breakdown" link on the total. A screen of its own is a
 * page (CLAUDE.md, the overlays rule).
 *
 * Server-rendered from the scores page's own data (`loadCompPilotScores` is
 * `loadCompScores` plus a 404 for a pilot the standings do not name), so the
 * two can never disagree and nothing new is fetched or stored.
 */
import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { NotFound } from "@/react/components/NotFound";
import { Page, PageBar } from "@/react/rac/page-bar";
import { Loading } from "@/react/rac/progress";
import { cardSurface } from "@/react/rac/card";
import { cn } from "@/react/lib/utils";
import { api } from "../../comp/api";
import { underCompScores } from "../lib/crumbs";
import { compPilotScoresPath, compUrlId, idFromSegment, pilotPath } from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { useSeededResource } from "../lib/use-seeded-resource";
import { useInitialData } from "../lib/initial-data";
import { formatDuration, formatRankedScore, formatTaskDate, ordinal } from "../lib/format";
import { formatDistance, useUnits } from "../lib/units";
import { useCompScores } from "../comp/CompScoresSection";
import { Points, ScoreLinkRow, ScoreList, ScoreStaticRow } from "../comp/score-rows";
import { ScoreFreshness } from "../comp/ScoreFreshness";
import type { CompDetailData } from "../comp/types";
import type { CompScoresLoaderData } from "../loaders";
import type { CompPilotScore, PilotTaskEntry, TaskInfo } from "../../scores-views";

/** "Mon 5 Jan": the year is the competition's. */
const shortDate = (date: string) =>
  formatTaskDate(date, { weekday: "short", day: "numeric", month: "short" });

/** A class name as the start of a line: "open" → "Open". The name itself is
 * the organiser's and is never respelt; this is only how the line begins. */
const asLineStart = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export function CompPilotScoresPage() {
  const { compId: compParam, pilotId: pilotParam } = useParams<{
    compId: string;
    pilotId: string;
  }>();
  const compId = idFromSegment(compParam ?? "");
  const pilotId = idFromSegment(pilotParam ?? "");
  const units = useUnits();

  // SSR seed: the server ran loadCompPilotScores for this URL. Null on client
  // boot / SPA navigations, where the hooks below fetch instead.
  const initial = useInitialData<CompScoresLoaderData>();
  const { data: comp, notFound, current } = useSeededResource<CompDetailData>({
    ids: [compId],
    seed: initial?.comp ?? null,
    load: ([comp_id]) => api.api.comp[":comp_id"].$get({ param: { comp_id } }),
    title: (c) => `GlideComp - ${c.name} scores`,
  });
  const { state } = useCompScores(
    compId,
    initial?.scores ?? undefined,
    initial?.scoresEtag ?? undefined
  );
  const urlId = compUrlId(comp, compId);

  // Which class the pilot is in, and their line in it.
  const scores = state.kind === "ready" ? state.scores : null;
  let cls: { pilot_class: string; pilots: CompPilotScore[] } | null = null;
  let pilot: CompPilotScore | null = null;
  for (const c of scores?.class_scores ?? []) {
    const found = c.pilots.find((p) => p.comp_pilot_id === pilotId);
    if (found) {
      cls = c;
      pilot = found;
      break;
    }
  }
  const pilotName = pilot?.pilot_name ?? null;

  useCanonicalPath(
    comp && current && pilotName
      ? compPilotScoresPath(urlId, comp.name, pilotId, pilotName)
      : null
  );
  useEffect(() => {
    if (comp && pilotName) document.title = `GlideComp - ${pilotName} - ${comp.name}`;
  }, [comp, pilotName]);

  // The standings answered and do not name this pilot: a dead link.
  if (notFound || !compId || (scores && !pilot)) {
    return <NotFound title="Pilot not found" />;
  }

  const bar = (
    <PageBar
      title={pilotName ?? "Pilot"}
      trail={underCompScores(urlId, comp?.name)}
      // The rest of the class beside this pilot, in their order: the way
      // from one pilot to the next without going back to the list.
      related={
        cls && cls.pilots.length > 1
          ? {
              as: "siblings",
              items: cls.pilots.map((p) => ({
                label: p.pilot_name,
                to: compPilotScoresPath(urlId, comp?.name, p.comp_pilot_id, p.pilot_name),
                current: p.comp_pilot_id === pilotId,
              })),
            }
          : undefined
      }
    />
  );

  if (!comp || state.kind === "loading") {
    return (
      <Page bar={bar}>
        <Loading>Loading scores…</Loading>
      </Page>
    );
  }
  if (!scores || !cls || !pilot) {
    return (
      <Page bar={bar}>
        <p className="text-muted-foreground">Scores not available</p>
      </Page>
    );
  }

  // The tasks this pilot's class flew, in the competition's order.
  const tasks = scores.tasks.filter((t) => t.classes.includes(cls.pilot_class));
  const isFtv = scores.series_scoring === "ftv";
  const flown = pilot.tasks.length;

  return (
    <Page bar={bar}>
      <div className="flex flex-col gap-4">
        <ScoreFreshness
          computedAt={scores.computed_at}
          stale={scores.stale}
          timezone={comp.timezone}
          etag={state.kind === "ready" ? state.etag : null}
          pollUrl={`/api/comp/${encodeURIComponent(compId)}/scores`}
        />

        <dl className={cn(cardSurface, "grid grid-cols-2 gap-4 p-4")}>
          <div className="flex flex-col-reverse">
            <dt className="text-sm text-muted-foreground">
              {asLineStart(cls.pilot_class)} class, of {cls.pilots.length}
            </dt>
            <dd className="text-2xl font-semibold tabular-nums">{ordinal(pilot.rank)}</dd>
          </div>
          <div className="flex flex-col-reverse">
            <dt className="text-sm text-muted-foreground">
              points, {flown} task{flown === 1 ? "" : "s"}
            </dt>
            <dd className="text-2xl font-semibold tabular-nums">
              {formatRankedScore(pilot.total_score)}
            </dd>
          </div>
        </dl>

        {isFtv ? (
          <p className="text-sm text-muted-foreground">
            Best tasks are kept until the fixed validity cap is reached
            {scores.ftv_factor != null
              ? ` (${Math.round(scores.ftv_factor * 100)}% of total validity discarded)`
              : ""}
            .
          </p>
        ) : null}

        <div>
          <div
            aria-hidden="true"
            className="flex items-end gap-3 px-4 pb-1.5 text-sm font-medium text-muted-foreground"
          >
            <span className="min-w-0 flex-1">Tasks</span>
            <span className="shrink-0 pr-7 text-right">Points</span>
          </div>
          <ScoreList label={`${pilot.pilot_name}'s tasks`}>
            {tasks.map((task) => (
              <TaskRow
                key={task.task_id}
                task={task}
                entry={pilot.tasks.find((t) => t.task_id === task.task_id) ?? null}
                href={pilotPath(urlId, comp.name, task.task_id, task.task_name, pilotId, pilot.pilot_name)}
                distance={(m) => formatDistance(m, { decimals: 1, prefs: units }).withUnit}
              />
            ))}
          </ScoreList>
        </div>

        {isFtv ? (
          <p className="flex justify-between gap-3 px-4 font-medium">
            <span>FTV total</span>
            <span className="pr-7 tabular-nums">{formatRankedScore(pilot.total_score)}</span>
          </p>
        ) : null}
      </div>
    </Page>
  );
}

/**
 * One task: the place, the task, the day and what the pilot did that day, and
 * the points. Opens the report card. A task the pilot has no score on has no
 * report card either, so its row opens nothing.
 */
function TaskRow({
  task,
  entry,
  href,
  distance,
}: {
  task: TaskInfo;
  entry: PilotTaskEntry | null;
  href: string;
  distance: (metres: number) => string;
}) {
  if (!entry) {
    return (
      <ScoreStaticRow
        rank="—"
        title={task.task_name}
        detail={shortDate(task.task_date)}
        figure={<span className="w-20 shrink-0 text-right text-muted-foreground">—</span>}
      />
    );
  }

  // What the pilot did. Absent from scores cached before the field existed,
  // and then the row says the day alone rather than guess.
  const did =
    entry.made_goal === true
      ? entry.speed_section_time != null
        ? `goal in ${formatDuration(entry.speed_section_time)}`
        : "goal"
      : entry.flown_distance != null
        ? distance(entry.flown_distance)
        : null;
  const discarded = entry.ftv_status === "discarded";
  const partial = entry.ftv_status === "partial";

  return (
    <ScoreLinkRow
      href={href}
      rank={ordinal(entry.rank)}
      title={task.task_name}
      detail={
        <>
          {shortDate(task.task_date)}
          {did ? ` · ${did}` : ""}
          {discarded ? " · discarded" : ""}
          {partial ? (
            <span className="text-caution">
              {` · counted in part: ${formatRankedScore(entry.ftv_counted_score ?? entry.score)}`}
            </span>
          ) : null}
        </>
      }
      figure={
        <Points
          value={entry.score}
          className={discarded ? "font-normal text-muted-foreground line-through" : undefined}
        />
      }
    />
  );
}
