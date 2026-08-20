/**
 * The load every routed TASK EDITOR does: the task, the competition it belongs
 * to, and whether the viewer may edit them.
 *
 * Three pages need exactly this — task settings, the route editor and the
 * weather notes (issue #637) — and each needs BOTH resources before it can
 * render anything: the comp carries the pilot classes, the timezone, the
 * scoring format and the admin list, the task carries everything else. A page
 * that mounted its editor with either missing would show an admin an empty
 * form over content that exists, because those editors seed their state from
 * the loaded values in `useState` initialisers.
 *
 * Both fetches go through `useSeededResource`, so a dropped request is retried
 * rather than recorded as "no such task" (issue #481) — the whole point being
 * that these pages are reached by a URL, so a blip on a cold load has no
 * previous render to fall back on.
 *
 * Seeds nothing: none of these pages is server-rendered (they are admin-only
 * and in `NOINDEX_SHELL_ROUTES`), so there is never SSR data to start from.
 */
import { api } from "../../comp/api";
import { useAdminView, useUser } from "./user";
import { useSeededResource } from "./use-seeded-resource";
import type { CompDetailData, TaskDetailData } from "../comp/types";

export interface TaskAdminPage {
  comp: CompDetailData | null;
  task: TaskDetailData | null;
  /** The viewer may edit — a comp admin, or a super admin not previewing. */
  isAdmin: boolean;
  /** Either id named nothing that resolves: a dead URL. */
  notFound: boolean;
  /** Still waiting on a resource or on the session. */
  loading: boolean;
}

export function useTaskAdminPage(
  compId: string,
  taskId: string,
  /** Page title once the task's name is known. */
  title: (task: TaskDetailData) => string,
  /** Bumped by a save so the page re-reads what was stored. */
  refresh?: number
): TaskAdminPage {
  const { user, loading: userLoading } = useUser();

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
      title,
      refresh,
    });

  const isAdmin = useAdminView(
    user != null &&
      comp != null &&
      comp.admins.some((a) => a.email === user.email)
  );

  return {
    comp,
    task,
    isAdmin,
    notFound: compNotFound || taskNotFound || !compId || !taskId,
    loading: !comp || !task || userLoading,
  };
}
