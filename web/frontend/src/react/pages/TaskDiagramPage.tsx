/**
 * The task's route at full size (/comp/:compId/task/:taskId/diagram) — PUBLIC
 * and server-rendered, like the task page it hangs off.
 *
 * The competition page lists each task with a glyph of its route, too small
 * to read on purpose (TaskDiagram's `xs` preset: shape and direction, no
 * names). This is the readable version: turnpoint names, cylinders, the lot.
 * It was a full-screen overlay over the competition page until 2026-11 (issue
 * #814, the overlays rule in CLAUDE.md); a page gets Back, scroll restoration
 * and a shareable URL from the browser instead.
 *
 * SSR'd rather than a noindex shell: the diagram is SVG built by a pure layout
 * module, so the server can draw it, and a reader on a hill with one bar of
 * signal sees the route in the first response rather than after a second
 * round trip. It IS noindexed (functions/comp/[[path]].ts): it says nothing
 * the task page does not, and the task page is the indexable form.
 *
 * Nothing is handed over from the competition page: a reload or a shared link
 * has no list underneath it, so the page loads the task and the comp itself
 * (the server's seed on a hard load). A hidden comp's share key rides in the
 * comp id, so both fetches 404 for anyone without it, and the page says
 * not-found while naming nothing.
 */
import { useParams } from "react-router-dom";
import { NotFound } from "@/react/components/NotFound";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { Loading } from "@/react/rac/progress";
import { api } from "../../comp/api";
import { TaskDiagram } from "../comp/TaskDiagram";
import type { CompDetailData, TaskDetailData } from "../comp/types";
import { underTask } from "../lib/crumbs";
import { useInitialData } from "../lib/initial-data";
import { compUrlId, idFromSegment, taskDiagramPath } from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { useSeededResource } from "../lib/use-seeded-resource";
import type { TaskDiagramLoaderData } from "../loaders";

/** The page's crumb — the name the task page already gives its diagram. */
const LABEL = "Route diagram";

export function TaskDiagramPage() {
  const { compId: compParam, taskId: taskParam } = useParams<{
    compId: string;
    taskId: string;
  }>();
  const compId = idFromSegment(compParam ?? "");
  const taskId = idFromSegment(taskParam ?? "");
  const initial = useInitialData<TaskDiagramLoaderData>();

  const {
    data: task,
    notFound: taskNotFound,
    current: taskCurrent,
  } = useSeededResource<TaskDetailData>({
    ids: [compId, taskId],
    seed: initial?.task ?? null,
    load: ([comp_id, task_id]) =>
      api.api.comp[":comp_id"].task[":task_id"].$get({
        param: { comp_id, task_id },
      }),
    title: (t) => `GlideComp - ${t.name} route`,
  });
  const {
    data: comp,
    notFound: compNotFound,
    current: compCurrent,
  } = useSeededResource<CompDetailData>({
    ids: [compId],
    seed: initial?.comp ?? null,
    load: ([comp_id]) => api.api.comp[":comp_id"].$get({ param: { comp_id } }),
  });

  // The id every link carries: a hidden comp's share key rides along.
  const urlId = compUrlId(comp, compId);

  useCanonicalPath(
    comp && task && compCurrent && taskCurrent
      ? taskDiagramPath(urlId, comp.name, taskId, task.name)
      : null
  );

  if (taskNotFound || compNotFound || !compId || !taskId) {
    return <NotFound title="Task not found" />;
  }
  if (!task || !comp) return <Loading>Loading task…</Loading>;

  return (
    <div>
      <Breadcrumbs items={underTask(urlId, comp.name, taskId, task.name)} current={LABEL} />
      <h1 className="mt-2 text-2xl font-bold">{`Route for ${task.name}`}</h1>
      {task.xctsk ? (
        // Capped against the viewport's HEIGHT as well as the column's width,
        // so a landscape phone shows the whole route without scrolling: the
        // `lg` preset is 540×380, so 110vh of width keeps it under ~78vh tall.
        <div className="mx-auto mt-4 w-[min(100%,110vh)]">
          <TaskDiagram task={task.xctsk} size="lg" className="h-auto w-full" />
        </div>
      ) : (
        <p className="mt-2 text-muted-foreground">No route defined yet</p>
      )}
    </div>
  );
}
