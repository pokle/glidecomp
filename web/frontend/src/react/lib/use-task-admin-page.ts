/**
 * The load every routed TASK EDITOR does — {@link useTaskPage}, the load
 * every page of one task does — plus whether the viewer may edit, and the
 * session it waits for to know.
 *
 * The task's editors (settings, the route, the weather notes, the test IGC)
 * each need BOTH resources before they can render anything: the comp carries
 * the pilot classes, the timezone, the scoring format and the admin list, the
 * task carries everything else. A page that mounted its editor with either
 * missing would show an admin an empty form over content that exists, because
 * those editors seed their state from the loaded values in `useState`
 * initialisers. `loading` is true until both are here and the session is
 * known; a viewer who is not an organiser is then sent on
 * (components/OrganisersOnly.tsx).
 *
 * Seeds nothing: none of these pages is server-rendered (they are admin-only
 * noindex shells, `comp-routes.ts`), so there is never SSR data to start from.
 */
import { useAdminView, useUser } from "./user";
import { useTaskPage, type TaskPage } from "./use-task-page";

export interface TaskAdminPage extends TaskPage {
  /** The viewer may edit — a comp admin, or a super admin not previewing. */
  isAdmin: boolean;
  /** Still waiting on a resource or on the session. */
  loading: boolean;
}

export function useTaskAdminPage(options: Parameters<typeof useTaskPage>[0]): TaskAdminPage {
  const { loading: userLoading } = useUser();
  const page = useTaskPage(options);
  const isAdmin = useAdminView(!!page.comp?.is_admin);
  return { ...page, isAdmin, loading: !page.comp || !page.task || userLoading };
}
