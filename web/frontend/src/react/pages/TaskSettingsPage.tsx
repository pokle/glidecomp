/**
 * Task settings (/comp/:compId/task/:taskId/settings) — ADMIN-ONLY and NOT
 * SSR'd (functions/comp/[[path]].ts serves it a noindex shell).
 *
 * The sibling of pages/CompSettingsPage.tsx, and it exists for the same
 * reason: these settings used to be a dialog over the task page, and a form
 * taller than the viewport inside a centred modal is the desktop-most thing an
 * app can do. See comp/settings/TaskSettings.tsx for why this hierarchy is
 * flat where the competition's is an index — flat enough that it has no
 * sub-pages at all, which is why there is no `:group` param here.
 */
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { NotFound } from "@/react/components/NotFound";
import { OrganisersOnly } from "@/react/components/OrganisersOnly";
import { Loading } from "@/react/rac/progress";
import { idFromSegment, taskPath, taskSettingsPath } from "../lib/slug";
import { useTaskAdminPage } from "../lib/use-task-admin-page";
import { TaskSettings } from "../comp/settings/TaskSettings";

export function TaskSettingsPage() {
  const { compId: compParam, taskId: taskParam } = useParams<{
    compId: string;
    taskId: string;
  }>();
  const compId = idFromSegment(compParam ?? "");
  const taskId = idFromSegment(taskParam ?? "");
  const navigate = useNavigate();
  // Bumped after a save so the page re-reads the stored values rather than
  // showing what it loaded before the edit.
  const [refresh, setRefresh] = useState(0);

  // The address bar settles on the canonical slugged path once both names
  // are known — the comp's name is half of it — for THIS URL's ids.
  const { comp, task, isAdmin, notFound, loading } = useTaskAdminPage({
    compId,
    taskId,
    title: (t) => `GlideComp - ${t.name} settings`,
    path: taskSettingsPath,
    refresh,
  });

  if (notFound) return <NotFound title="Task not found" />;
  if (loading || !comp || !task) return <Loading>Loading settings…</Loading>;

  if (!isAdmin) return <OrganisersOnly to={taskPath(compId, comp.name, taskId, task.name)} />;

  return (
    <TaskSettings
      compId={compId}
      taskId={taskId}
      comp={comp}
      task={task}
      onSaved={() => {
        setRefresh((r) => r + 1);
        // Back to the task, which is what the admin was looking at.
        navigate(taskPath(compId, comp.name, taskId, task.name));
      }}
    />
  );
}
