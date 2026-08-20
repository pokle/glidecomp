/**
 * The task's weather notes (/comp/:compId/task/:taskId/weather) — ADMIN-ONLY
 * to write and NOT SSR'd (functions/comp/[[path]].ts serves it a noindex
 * shell). The notes themselves are public to READ, on the task page.
 *
 * A sibling of /settings and /route rather than a child of either: all three
 * are editors of one part of the task, each reached from the part of the task
 * page it edits. See comp/TaskWeatherNotes.tsx for the form.
 */
import { useNavigate, useParams } from "react-router-dom";
import { NotFound } from "@/react/components/NotFound";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { Loading } from "@/react/rac/progress";
import { underTask } from "../lib/crumbs";
import { idFromSegment, taskPath, taskWeatherPath } from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { useTaskAdminPage } from "../lib/use-task-admin-page";
import { TaskWeatherNotes } from "../comp/TaskWeatherNotes";

export function TaskWeatherPage() {
  const { compId: compParam, taskId: taskParam } = useParams<{
    compId: string;
    taskId: string;
  }>();
  const compId = idFromSegment(compParam ?? "");
  const taskId = idFromSegment(taskParam ?? "");
  const navigate = useNavigate();

  const { comp, task, isAdmin, notFound, loading } = useTaskAdminPage(
    compId,
    taskId,
    (t) => `GlideComp - ${t.name} weather notes`
  );

  useCanonicalPath(
    comp && task ? taskWeatherPath(compId, comp.name, taskId, task.name) : null
  );

  if (notFound) return <NotFound title="Task not found" />;
  if (loading || !comp || !task) return <Loading>Loading…</Loading>;

  if (!isAdmin) {
    return (
      <div>
        <Breadcrumbs
          items={underTask(compId, comp.name, taskId, task.name)}
          current="Weather notes"
        />
        <h1 className="mt-2 text-2xl font-bold">Weather notes</h1>
        <p className="mt-2 text-muted-foreground">
          Writing the day&rsquo;s weather notes is for competition admins. The
          notes themselves are on the task page, for everyone.
        </p>
      </div>
    );
  }

  return (
    <TaskWeatherNotes
      compId={compId}
      taskId={taskId}
      comp={comp}
      task={task}
      // Back to the task page, where the notes are read — and where the
      // Weather section this was opened from is.
      onSaved={() => navigate(taskPath(compId, comp.name, taskId, task.name))}
    />
  );
}
