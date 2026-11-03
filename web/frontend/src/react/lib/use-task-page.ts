/**
 * The load every page of ONE TASK does: the task, the competition it belongs
 * to, the id this viewer's links carry, and the address bar settled on the
 * task's canonical path once both names are known.
 *
 * The QR code, the route diagram, the test IGC and the task's editors each
 * wrote this out — two `useSeededResource` calls with the same loaders, the
 * share-keyed id, a `useCanonicalPath` that had to wait for BOTH resources to
 * be the ones the URL names now. One of them forgot that last part (#833's
 * rule), which is the reason it is here once: `path` is applied only when the
 * data is `current`, so no page can write the previous URL back over the new
 * one.
 *
 * Both fetches go through `useSeededResource`, so a dropped request is retried
 * rather than recorded as "no such task" (issue #481). `seed` is the SSR
 * loader's data for the pages that are server-rendered (the diagram), null for
 * the noindex shells.
 */
import { api } from "../../comp/api";
import type { CompDetailData, TaskDetailData } from "../comp/types";
import { compUrlId } from "./slug";
import { useCanonicalPath } from "./use-canonical-path";
import { useSeededResource } from "./use-seeded-resource";

export interface TaskPage {
  comp: CompDetailData | null;
  task: TaskDetailData | null;
  /** The comp id this viewer's links carry: a hidden comp's share key rides along. */
  urlId: string;
  /** Either id named nothing that resolves: a dead URL. */
  notFound: boolean;
  /**
   * Both resources were loaded for the ids the page names now, not for the
   * URL it was on before (see `useSeededResource`'s `current`).
   */
  current: boolean;
}

export function useTaskPage({
  compId,
  taskId,
  seed = null,
  title,
  path,
  refresh,
}: {
  /** The comp id as the URL carries it. */
  compId: string;
  taskId: string;
  seed?: { comp: CompDetailData | null; task: TaskDetailData | null } | null;
  /** Page title once the task's name is known. */
  title?: (task: TaskDetailData) => string;
  /**
   * This page's canonical path, from the names: the address bar is settled
   * on it once the data is the URL's own. Left out by a page that settles
   * its own (the route editor's pages each have their own).
   */
  path?: (urlId: string, compName: string, taskId: string, taskName: string) => string;
  /** Bumped by a save so the page re-reads what was stored. */
  refresh?: number;
}): TaskPage {
  const { data: comp, notFound: compNotFound, current: compCurrent } =
    useSeededResource<CompDetailData>({
      ids: [compId],
      seed: seed?.comp ?? null,
      load: ([comp_id]) => api.api.comp[":comp_id"].$get({ param: { comp_id } }),
      refresh,
    });
  const { data: task, notFound: taskNotFound, current: taskCurrent } =
    useSeededResource<TaskDetailData>({
      ids: [compId, taskId],
      seed: seed?.task ?? null,
      load: ([comp_id, task_id]) =>
        api.api.comp[":comp_id"].task[":task_id"].$get({ param: { comp_id, task_id } }),
      title,
      refresh,
    });

  const urlId = compUrlId(comp, compId);
  const current = compCurrent && taskCurrent;
  useCanonicalPath(
    path && comp && task && current ? path(urlId, comp.name, taskId, task.name) : null
  );

  return {
    comp,
    task,
    urlId,
    notFound: compNotFound || taskNotFound || !compId || !taskId,
    current,
  };
}
