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
import { OrganisersOnly } from "@/react/components/OrganisersOnly";
import { Loading } from "@/react/rac/progress";
import { idFromSegment, taskPath, taskWeatherPath } from "../lib/slug";
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

  const { comp, task, isAdmin, notFound, loading } = useTaskAdminPage({
    compId,
    taskId,
    title: (t) => `GlideComp - ${t.name} weather notes`,
    path: taskWeatherPath,
  });

  if (notFound) return <NotFound title="Task not found" />;
  if (loading || !comp || !task) return <Loading>Loading…</Loading>;

  // The notes themselves are on the task page, for everyone.
  if (!isAdmin) return <OrganisersOnly to={taskPath(compId, comp.name, taskId, task.name)} />;

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
