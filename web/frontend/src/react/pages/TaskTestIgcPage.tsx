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
import { OrganisersOnly } from "@/react/components/OrganisersOnly";
import { SettingsPage } from "@/react/components/SettingsPage";
import { Loading } from "@/react/rac/progress";
import { underTask } from "../lib/crumbs";
import { idFromSegment, taskPath, taskTestIgcPath } from "../lib/slug";
import { useTaskAdminPage } from "../lib/use-task-admin-page";
import { ForgeIgcForm } from "../comp/ForgeIgcForm";

/** The bar has one line: the short name there, the sentence in its menu. */
const TITLE = "Test IGC";
const FULL_TITLE = "Create a test IGC";

export function TaskTestIgcPage() {
  const { compId: compParam, taskId: taskParam } = useParams<{
    compId: string;
    taskId: string;
  }>();
  const compId = idFromSegment(compParam ?? "");
  const taskId = idFromSegment(taskParam ?? "");

  // `urlId` is the id every link carries: a hidden comp's share key rides
  // along. The address bar settles only once both resources are this URL's.
  const { comp, task, urlId, isAdmin, notFound, loading } = useTaskAdminPage({
    compId,
    taskId,
    title: (t) => `GlideComp - ${t.name} test IGC`,
    path: taskTestIgcPath,
  });

  if (notFound) return <NotFound title="Task not found" />;
  if (loading || !comp || !task) {
    // The bar is there before the data, so the page does not jump.
    return (
      <SettingsPage
        crumbs={underTask(urlId, comp?.name, taskId, task?.name)}
        title={TITLE}
        fullTitle={FULL_TITLE}
      >
        <Loading>Loading…</Loading>
      </SettingsPage>
    );
  }

  if (!isAdmin) return <OrganisersOnly to={taskPath(urlId, comp.name, taskId, task.name)} />;
  if (!task.xctsk) {
    // The task page offers this only once there is a route: there is nothing
    // to fly without one.
    return (
      <SettingsPage
        crumbs={underTask(urlId, comp.name, taskId, task.name)}
        title={TITLE}
        fullTitle={FULL_TITLE}
      >
        <p className="text-muted-foreground">
          This task has no route yet, so there is no flight to make.
        </p>
      </SettingsPage>
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
