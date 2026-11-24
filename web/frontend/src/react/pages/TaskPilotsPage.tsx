/**
 * Choosing another pilot's report card for the same task
 * (/comp/:compId/task/:taskId/pilots[?from=<pilot>]) — PUBLIC, and NOT SSR'd
 * (a noindex shell: the scores page already gives a crawler every pilot).
 *
 * The report card's title menu listed every pilot of the class: 43 rows on
 * the sample task, more on a real one (#870). A menu is for the pages beside
 * this one, not for a search, so the menu now has one row, "Another pilot…",
 * and it opens this page: a search field under the bar and the pilots as
 * rows, in the order they finished. A picker with a text field is a page
 * (docs/interaction-guide.md 2.1), and Back returns to the report card.
 */
import { useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useFilter } from "react-aria-components";
import { api } from "../../comp/api";
import { NotFound } from "@/react/components/NotFound";
import { SearchField } from "@/react/rac/field";
import { Page, PageBar } from "@/react/rac/page-bar";
import { Loading } from "@/react/rac/progress";
import { Points, ScoreLinkRow, ScoreList, ScoreStaticRow } from "../comp/score-rows";
import type { TaskScoreData } from "../comp/types";
import { underTask } from "../lib/crumbs";
import { idFromSegment, pilotPath, taskPilotsPath } from "../lib/slug";
import { useSeededResource } from "../lib/use-seeded-resource";
import { useTaskPage } from "../lib/use-task-page";

export function TaskPilotsPage() {
  const { compId: compParam, taskId: taskParam } = useParams<{
    compId: string;
    taskId: string;
  }>();
  const compId = idFromSegment(compParam ?? "");
  const taskId = idFromSegment(taskParam ?? "");
  const [params] = useSearchParams();
  // The pilot the reader came from: ticked, and not a link to itself.
  const from = params.get("from");
  const [query, setQuery] = useState("");
  const { contains } = useFilter({ sensitivity: "base" });

  const { comp, task, urlId, notFound } = useTaskPage({
    compId,
    taskId,
    title: (t) => `GlideComp - ${t.name} pilots`,
    // The path alone: the address keeps its own `?from=` when it is settled.
    path: (id, compName, tid, taskName) => taskPilotsPath(id, compName, tid, taskName),
  });
  const { data: score, notFound: noScore } = useSeededResource<TaskScoreData>({
    ids: [compId, taskId],
    seed: null,
    load: ([comp_id, task_id]) =>
      api.api.comp[":comp_id"].task[":task_id"].score.$get({ param: { comp_id, task_id } }),
  });

  const classes = useMemo(() => {
    const words = query.trim().split(/\s+/).filter(Boolean);
    return (score?.class_scores ?? [])
      .map((cls) => ({
        name: cls.pilot_class,
        pilots: cls.pilots.filter((p) => words.every((w) => contains(p.pilot_name, w))),
      }))
      .filter((cls) => cls.pilots.length > 0);
  }, [score, query, contains]);

  if (notFound) return <NotFound title="Task not found" />;

  const bar = (
    <PageBar
      title="Another pilot"
      fullTitle="Another pilot's report card"
      trail={underTask(compId, comp?.name, taskId, task?.name)}
      below={
        <SearchField
          variant="floating"
          aria-label="Search pilots"
          placeholder="Search pilots"
          value={query}
          onChange={setQuery}
        />
      }
    />
  );

  if (!comp || !task || (!score && !noScore)) {
    return (
      <Page bar={bar}>
        <Loading>Loading pilots…</Loading>
      </Page>
    );
  }

  const several = (score?.class_scores.length ?? 0) > 1;
  return (
    <Page bar={bar}>
      {!score || score.class_scores.every((c) => c.pilots.length === 0) ? (
        <p className="text-muted-foreground">No pilot has a score on this task yet.</p>
      ) : classes.length === 0 ? (
        <p className="text-muted-foreground">No pilot of that name on this task.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {classes.map((cls) => (
            <section key={cls.name} className="flex flex-col gap-2">
              {several ? <h2 className="text-sm font-medium capitalize">{cls.name}</h2> : null}
              <ScoreList label={several ? `${cls.name} pilots, by rank` : "Pilots, by rank"}>
                {cls.pilots.map((p) =>
                  p.comp_pilot_id === from ? (
                    <ScoreStaticRow
                      key={p.comp_pilot_id}
                      rank={p.rank}
                      title={<span className="font-semibold">{p.pilot_name}</span>}
                      detail="The report card you came from"
                      figure={<Points value={p.total_score} />}
                    />
                  ) : (
                    <ScoreLinkRow
                      key={p.comp_pilot_id}
                      href={pilotPath(urlId, comp.name, taskId, task.name, p.comp_pilot_id, p.pilot_name)}
                      rank={p.rank}
                      title={p.pilot_name}
                      figure={<Points value={p.total_score} />}
                    />
                  )
                )}
              </ScoreList>
            </section>
          ))}
        </div>
      )}
    </Page>
  );
}
