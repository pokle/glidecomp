/**
 * Task settings (/comp/:compId/task/:taskId/settings[/:sub]) — ADMIN-ONLY and
 * NOT SSR'd (functions/comp/[[path]].ts serves it a noindex shell).
 *
 * The sibling of pages/CompSettingsPage.tsx, and it exists for the same
 * reason: these settings used to be a dialog over the task page, and a form
 * taller than the viewport inside a centred modal is the desktop-most thing an
 * app can do. See comp/settings/TaskSettings.tsx for why this hierarchy is
 * flat where the competition's is an index.
 *
 * Both resources are loaded here rather than in the sub-components: the comp
 * supplies the pilot classes, the timezone and the admin list, and the task
 * supplies everything else. Neither is optional, so a page that lost either
 * would be a form with fields it could not fill.
 */
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { NotFound } from "@/react/components/NotFound";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { Loading } from "@/react/rac/progress";
import { api } from "../../comp/api";
import { useAdminView, useUser } from "../lib/user";
import { underTask } from "../lib/crumbs";
import { idFromSegment, taskPath, taskSettingsPath } from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { useSeededResource } from "../lib/use-seeded-resource";
import type { CompDetailData, TaskDetailData } from "../comp/types";
import { TaskSettings } from "../comp/settings/TaskSettings";
import { WeatherNotesSettings } from "../comp/settings/WeatherNotesSettings";

/** Sub-pages of the flat settings form. Anything else is a dead URL. */
const TASK_SETTINGS_SUBS = ["weather"] as const;
type TaskSettingsSub = (typeof TASK_SETTINGS_SUBS)[number];

export function TaskSettingsPage() {
  const {
    compId: compParam,
    taskId: taskParam,
    sub,
  } = useParams<{ compId: string; taskId: string; sub?: string }>();
  const compId = idFromSegment(compParam ?? "");
  const taskId = idFromSegment(taskParam ?? "");
  const navigate = useNavigate();
  const { user, loading } = useUser();
  // Bumped after a save so the page re-reads the stored values rather than
  // showing what it loaded before the edit.
  const [refresh, setRefresh] = useState(0);

  const { data: comp, notFound: compNotFound } =
    useSeededResource<CompDetailData>({
      ids: [compId],
      seed: null,
      load: ([comp_id]) => api.api.comp[":comp_id"].$get({ param: { comp_id } }),
      refresh,
    });
  const { data: task, notFound: taskNotFound } =
    useSeededResource<TaskDetailData>({
      ids: [compId, taskId],
      seed: null,
      load: ([comp_id, task_id]) =>
        api.api.comp[":comp_id"].task[":task_id"].$get({
          param: { comp_id, task_id },
        }),
      title: (t) => `GlideComp - ${t.name} settings`,
      refresh,
    });

  // Settle the address bar on the canonical slugged path once both names are
  // known — the comp's name is half of it.
  useCanonicalPath(
    comp && task
      ? taskSettingsPath(compId, comp.name, taskId, task.name, sub)
      : null
  );

  const isAdmin = useAdminView(
    user != null &&
      comp != null &&
      comp.admins.some((a) => a.email === user.email)
  );

  if (compNotFound || taskNotFound || !compId || !taskId) {
    return <NotFound title="Task not found" />;
  }
  if (sub !== undefined && !TASK_SETTINGS_SUBS.includes(sub as TaskSettingsSub)) {
    return <NotFound />;
  }

  if (!comp || !task || loading) {
    return <Loading>Loading settings…</Loading>;
  }

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

  // Saving a sub-page returns to the settings form; saving the form itself
  // returns to the task, which is what the admin was looking at.
  const onSaved = (to: string) => () => {
    setRefresh((r) => r + 1);
    navigate(to);
  };

  if (sub === "weather") {
    return (
      <WeatherNotesSettings
        compId={compId}
        taskId={taskId}
        comp={comp}
        task={task}
        onSaved={onSaved(
          taskSettingsPath(compId, comp.name, taskId, task.name)
        )}
      />
    );
  }

  return (
    <TaskSettings
      compId={compId}
      taskId={taskId}
      comp={comp}
      task={task}
      onSaved={onSaved(taskPath(compId, comp.name, taskId, task.name))}
    />
  );
}
