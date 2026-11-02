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
 *
 * `?from_comp=…&from_task=…` is a route chosen on the copy page
 * (pages/TaskRouteCopyPage.tsx). This page fetches that task as well, moves
 * its start gates to the same local time on this task's day
 * (`rebaseRouteTimes`), and hands it to the editor, which loads it as unsaved
 * work. The editor waits for it, for the same reason it waits for the task.
 */
import { Suspense, lazy, useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { XCTask } from "@glidecomp/engine";
import { Alert, AlertDescription } from "@/react/rac/alert";
import { NotFound } from "@/react/components/NotFound";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { Loading } from "@/react/rac/progress";
import { api } from "../../comp/api";
import { useAdminView, useUser } from "../lib/user";
import { underTask } from "../lib/crumbs";
import {
  compUrlId,
  idFromSegment,
  taskPath,
  taskRouteCopyPath,
  taskRoutePath,
} from "../lib/slug";
import { rebaseRouteTimes } from "../comp/comp-copy";
import { fetchWithRetry } from "../comp/types";
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
  const { loading } = useUser();

  const { data: comp, notFound: compNotFound, current: compCurrent } =
    useSeededResource<CompDetailData>({
      ids: [compId],
      seed: null,
      load: ([comp_id]) => api.api.comp[":comp_id"].$get({ param: { comp_id } }),
    });
  const { data: task, notFound: taskNotFound, current: taskCurrent } =
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
    comp && task && compCurrent && taskCurrent
      ? taskRoutePath(compUrlId(comp, compId), comp.name, taskId, task.name)
      : null
  );

  const isAdmin = useAdminView(!!comp?.is_admin);
  const copy = useCopiedRoute();

  if (compNotFound || taskNotFound || !compId || !taskId) {
    return <NotFound title="Task not found" />;
  }

  if (!comp || !task || loading || copy.state === "loading") {
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
          Editing a task&rsquo;s route is for the competition’s organisers. The route
          itself is on the task page, for everyone.
        </p>
      </div>
    );
  }

  // Both ways out land on the task, which is where the route is read.
  const backToTask = () =>
    navigate(taskPath(compId, comp.name, taskId, task.name));

  const urlId = compUrlId(comp, compId);
  const copyFrom =
    copy.state === "loaded" && copy.source.xctsk
      ? {
          task: rebaseRouteTimes(
            copy.source.xctsk,
            copy.source.task_date,
            task.task_date,
            comp.timezone ?? null
          ),
          label: copy.source.name,
        }
      : null;

  return (
    <Suspense fallback={<Loading>Loading the route editor…</Loading>}>
      {copy.state === "failed" || (copy.state === "loaded" && !copy.source.xctsk) ? (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>
            The route to copy could not be loaded. The route below is the saved one.
          </AlertDescription>
        </Alert>
      ) : null}
      <RouteEditor
        copyFrom={copyFrom}
        copyPickerPath={taskRouteCopyPath(urlId, comp.name, taskId, task.name)}
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

interface CopySource {
  name: string;
  task_date: string;
  xctsk: XCTask | null;
}

type CopiedRoute =
  | { state: "none" }
  | { state: "loading" }
  | { state: "loaded"; source: CopySource }
  | { state: "failed" };

/**
 * The task named by `?from_comp=&from_task=`, if any. Read through the
 * ordinary task route, so a hidden competition's route is there for its
 * organisers and nobody else.
 */
function useCopiedRoute(): CopiedRoute {
  const [params] = useSearchParams();
  const fromComp = params.get("from_comp");
  const fromTask = params.get("from_task");
  const [result, setResult] = useState<{ key: string; value: CopiedRoute } | null>(null);
  const key = fromComp && fromTask ? `${fromComp}/${fromTask}` : null;

  useEffect(() => {
    if (!fromComp || !fromTask) return;
    let cancelled = false;
    const k = `${fromComp}/${fromTask}`;
    void (async () => {
      try {
        // A dropped request is not a missing route (#481).
        const res = await fetchWithRetry(() =>
          api.api.comp[":comp_id"].task[":task_id"].$get({
            param: { comp_id: fromComp, task_id: fromTask },
          })
        );
        if (cancelled) return;
        if (!res.ok) {
          setResult({ key: k, value: { state: "failed" } });
          return;
        }
        const body = (await res.json()) as unknown as CopySource;
        if (!cancelled) setResult({ key: k, value: { state: "loaded", source: body } });
      } catch {
        if (!cancelled) setResult({ key: k, value: { state: "failed" } });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fromComp, fromTask]);

  if (!key) return { state: "none" };
  return result && result.key === key ? result.value : { state: "loading" };
}
