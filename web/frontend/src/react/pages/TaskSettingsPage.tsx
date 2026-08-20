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
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { Loading } from "@/react/rac/progress";
import { underTask } from "../lib/crumbs";
import { idFromSegment, taskPath, taskSettingsPath } from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
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

  const { comp, task, isAdmin, notFound, loading } = useTaskAdminPage(
    compId,
    taskId,
    (t) => `GlideComp - ${t.name} settings`,
    refresh
  );

  // Settle the address bar on the canonical slugged path once both names are
  // known — the comp's name is half of it.
  useCanonicalPath(
    comp && task ? taskSettingsPath(compId, comp.name, taskId, task.name) : null
  );

  if (notFound) return <NotFound title="Task not found" />;
  if (loading || !comp || !task) return <Loading>Loading settings…</Loading>;

  if (!isAdmin) {
    return (
      <div>
        <Breadcrumbs
          items={underTask(compId, comp.name, taskId, task.name)}
          current="Settings"
        />
        <h1 className="mt-2 text-2xl font-bold">Settings</h1>
        <p className="mt-2 text-muted-foreground">
          Task settings are for competition admins.
        </p>
      </div>
    );
  }

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
