/**
 * Create a test IGC (/comp/:compId/task/:taskId/test-igc) — ADMIN-ONLY and
 * NOT SSR'd (functions/comp/[[path]].ts serves it a noindex shell, like the
 * task's editors beside it).
 *
 * It was a dialog over the task page until 2026-11 (issue #822), handed the
 * task's route and the comp's zone in memory. A page cannot be: a reload or a
 * shared link has no task page underneath it, so this fetches both itself
 * (`useTaskAdminPage`, the load the task's editors share). The form is
 * comp/ForgeIgcForm.tsx.
 *
 * Nothing here navigates on success: what Create makes is a file, offered on
 * this page with the engine's verdict beside it, as the dialog did. The task
 * page is one browser Back away — the task page links here, so Back is where
 * the reader came from — and the breadcrumbs name it for anyone who arrived
 * some other way.
 */
import { useParams } from "react-router-dom";
import { NotFound } from "@/react/components/NotFound";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { Loading } from "@/react/rac/progress";
import { underTask } from "../lib/crumbs";
import { compUrlId, idFromSegment, taskTestIgcPath } from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { useTaskAdminPage } from "../lib/use-task-admin-page";
import { ForgeIgcForm } from "../comp/ForgeIgcForm";

const TITLE = "Create a test IGC";

export function TaskTestIgcPage() {
  const { compId: compParam, taskId: taskParam } = useParams<{
    compId: string;
    taskId: string;
  }>();
  const compId = idFromSegment(compParam ?? "");
  const taskId = idFromSegment(taskParam ?? "");

  const { comp, task, isAdmin, notFound, loading } = useTaskAdminPage(
    compId,
    taskId,
    (t) => `GlideComp - ${t.name} test IGC`
  );
  // The id every link carries: a hidden comp's share key rides along.
  const urlId = compUrlId(comp, compId);

  useCanonicalPath(
    comp && task ? taskTestIgcPath(urlId, comp.name, taskId, task.name) : null
  );

  if (notFound) return <NotFound title="Task not found" />;
  if (loading || !comp || !task) return <Loading>Loading…</Loading>;

  const crumbs = underTask(urlId, comp.name, taskId, task.name);
  if (!isAdmin || !task.xctsk) {
    return (
      <div>
        <Breadcrumbs items={crumbs} current={TITLE} />
        <h1 className="mt-2 text-2xl font-bold">{TITLE}</h1>
        <p className="mt-2 text-muted-foreground">
          {!isAdmin
            ? "Creating a test IGC is for the competition’s organisers."
            : // The task page offers this only once there is a route: there
              // is nothing to fly without one.
              "This task has no route yet, so there is no flight to make."}
        </p>
      </div>
    );
  }

  return (
    <ForgeIgcForm
      compId={urlId}
      taskId={taskId}
      taskName={task.name}
      taskDate={task.task_date}
      compName={comp.name}
      timezone={comp.timezone ?? null}
      category={comp.category === "pg" ? "pg" : "hg"}
      xctsk={task.xctsk}
    />
  );
}
