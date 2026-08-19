/**
 * The task's route editor (/comp/:compId/task/:taskId/route) — ADMIN-ONLY and
 * NOT SSR'd (functions/comp/[[path]].ts serves it a noindex shell).
 *
 * A thin loader around comp/RouteEditor.tsx, which was a dialog over the task
 * page until #637. Two reasons this page exists rather than the editor being
 * routed directly: the editor needs the comp (for the scoring format, the
 * timezone and the admin list) as well as the task, and it must not mount
 * until both have arrived — it seeds every one of its panels from the loaded
 * xctsk in `useState` initialisers, so a mount with a null task would give an
 * admin an empty editor over a route that exists.
 *
 * The editor itself is lazy INSIDE this page: it pulls Mapbox, and that has no
 * business in the chunk a pilot downloads to read a scoreboard.
 */
import { Suspense, lazy } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { NotFound } from "@/react/components/NotFound";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { Loading } from "@/react/rac/progress";
import { api } from "../../comp/api";
import { useAdminView, useUser } from "../lib/user";
import { underTask } from "../lib/crumbs";
import { idFromSegment, taskPath, taskRoutePath } from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { useSeededResource } from "../lib/use-seeded-resource";
import type { CompDetailData, TaskDetailData } from "../comp/types";

const RouteEditor = lazy(() =>
  import("../comp/RouteEditor").then((m) => ({ default: m.RouteEditor }))
);

export function TaskRoutePage() {
  const { compId: compParam, taskId: taskParam } = useParams<{
    compId: string;
    taskId: string;
  }>();
  const compId = idFromSegment(compParam ?? "");
  const taskId = idFromSegment(taskParam ?? "");
  const navigate = useNavigate();
  const { user, loading } = useUser();

  const { data: comp, notFound: compNotFound } =
    useSeededResource<CompDetailData>({
      ids: [compId],
      seed: null,
      load: ([comp_id]) => api.api.comp[":comp_id"].$get({ param: { comp_id } }),
    });
  const { data: task, notFound: taskNotFound } =
    useSeededResource<TaskDetailData>({
      ids: [compId, taskId],
      seed: null,
      load: ([comp_id, task_id]) =>
        api.api.comp[":comp_id"].task[":task_id"].$get({
          param: { comp_id, task_id },
        }),
      title: (t) => `GlideComp - ${t.name} route`,
    });

  useCanonicalPath(
    comp && task ? taskRoutePath(compId, comp.name, taskId, task.name) : null
  );

  const isAdmin = useAdminView(
    user != null &&
      comp != null &&
      comp.admins.some((a) => a.email === user.email)
  );

  if (compNotFound || taskNotFound || !compId || !taskId) {
    return <NotFound title="Task not found" />;
  }

  if (!comp || !task || loading) {
    return <Loading>Loading route…</Loading>;
  }

  if (!isAdmin) {
    return (
      <div>
        <Breadcrumbs
          items={underTask(compId, comp.name, taskId, task.name)}
          current="Route"
        />
        <h1 className="mt-2 text-2xl font-bold">Route</h1>
        <p className="mt-2 text-muted-foreground">
          Editing a task&rsquo;s route is for competition admins. The route
          itself is on the task page, for everyone.
        </p>
      </div>
    );
  }

  // Both ways out land on the task, which is where the route is read.
  const backToTask = () =>
    navigate(taskPath(compId, comp.name, taskId, task.name));

  return (
    <Suspense fallback={<Loading>Loading the route editor…</Loading>}>
      <RouteEditor
        compId={compId}
        compName={comp.name}
        taskId={taskId}
        taskName={task.name}
        taskDate={task.task_date}
        xctsk={task.xctsk}
        openDistance={comp.scoring_format === "open_distance"}
        timezone={comp.timezone ?? null}
        onCancel={backToTask}
        onSaved={backToTask}
      />
    </Suspense>
  );
}
