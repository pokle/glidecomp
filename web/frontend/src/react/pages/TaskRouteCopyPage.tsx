/**
 * Choosing a route to copy into this task
 * (/comp/:compId/task/:taskId/route/copy[?q=…]) — ADMIN-ONLY and NOT SSR'd
 * (functions/comp/[[path]].ts serves it a noindex shell). Reached from the
 * route editor's "Copy from another competition".
 *
 * Every saved route the organiser can see, nearest first: measured from each
 * route's take-off to the nearest of this competition's waypoints and route
 * turnpoints, so last year's routes at the same site come to the top
 * (competition-api's route-sources.ts). A competition that knows no place
 * yet lists the newest first. The distance orders the list and never filters
 * it, and the search box narrows it by competition or task name for a route
 * flown somewhere else. The search is in the URL (`?q=`), so Back from the
 * editor returns to the list as it was left.
 *
 * Choosing a route opens the editor with it loaded as UNSAVED work
 * (`taskRouteCopyFromPath`): the source is in the URL, so the editor fetches
 * it itself rather than being handed it in memory, and nothing is written
 * until Save, which is the ordinary route save with its own checks, audit
 * entry and rescoring.
 */
import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { NotFound } from "@/react/components/NotFound";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { SearchField } from "@/react/rac/field";
import { NavList, NavRow } from "@/react/rac/nav-list";
import { Loading } from "@/react/rac/progress";
import { api } from "../../comp/api";
import { formatRouteDistance } from "../comp/comp-copy";
import { fetchWithRetry, type CompDetailData, type TaskDetailData } from "../comp/types";
import { underTaskRoute } from "../lib/crumbs";
import { formatTaskDate } from "../lib/format";
import {
  compUrlId,
  idFromSegment,
  taskRouteCopyFromPath,
  taskRouteCopyPath,
} from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { useSeededResource } from "../lib/use-seeded-resource";
import { useAdminView, useUser } from "../lib/user";

const TITLE = "Copy a route";

/** How long typing settles before the list is asked again. */
const SEARCH_DELAY_MS = 250;
/** Turnpoint names shown per route before "…". */
const NAMES_SHOWN = 6;

interface RouteSource {
  comp_id: string;
  comp_name: string;
  this_comp: boolean;
  task_id: string;
  task_name: string;
  task_date: string;
  turnpoints: string[];
  distance_m: number | null;
}

interface RouteSources {
  reference: "both" | "waypoints" | "routes" | "none";
  more: boolean;
  routes: RouteSource[];
}

export function TaskRouteCopyPage() {
  const { compId: compParam, taskId: taskParam } = useParams<{
    compId: string;
    taskId: string;
  }>();
  const compId = idFromSegment(compParam ?? "");
  const taskId = idFromSegment(taskParam ?? "");
  const { loading } = useUser();

  const { data: comp, notFound: compNotFound, current: compCurrent } =
    useSeededResource<CompDetailData>({
      ids: [compId],
      seed: null,
      load: ([comp_id]) => api.api.comp[":comp_id"].$get({ param: { comp_id } }),
    });
  const { data: task, notFound: taskNotFound, current: taskCurrent } =
    useSeededResource<TaskDetailData>({
      ids: [compId, taskId],
      seed: null,
      load: ([comp_id, task_id]) =>
        api.api.comp[":comp_id"].task[":task_id"].$get({ param: { comp_id, task_id } }),
      title: (t) => `GlideComp - Copy a route into ${t.name}`,
    });
  const urlId = comp ? compUrlId(comp, compId) : compId;
  useCanonicalPath(
    comp && task && compCurrent && taskCurrent
      ? taskRouteCopyPath(urlId, comp.name, taskId, task.name)
      : null
  );
  const isAdmin = useAdminView(!!comp?.is_admin);

  if (compNotFound || taskNotFound || !compId || !taskId) {
    return <NotFound title="Task not found" />;
  }
  if (!comp || !task || loading) return <Loading>Loading…</Loading>;

  const crumbs = underTaskRoute(urlId, comp.name, taskId, task.name);
  if (!isAdmin) {
    return (
      <div>
        <Breadcrumbs items={crumbs} current={TITLE} />
        <h1 className="mt-2 text-2xl font-bold">{TITLE}</h1>
        <p className="mt-2 text-muted-foreground">
          Editing a task&rsquo;s route is for the competition’s organisers.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl">
      <Breadcrumbs items={crumbs} current={TITLE} />
      <h1 className="mt-2 text-2xl font-bold">{TITLE}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Choose a route to load into {task.name}. Nothing is saved until you press Save in the
        route editor.
      </p>
      <RouteSourceList compId={urlId} comp={comp} taskId={taskId} task={task} />
    </div>
  );
}

function RouteSourceList({
  compId,
  comp,
  taskId,
  task,
}: {
  compId: string;
  comp: CompDetailData;
  taskId: string;
  task: TaskDetailData;
}) {
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(() => params.get("q") ?? "");
  const [query, setQuery] = useState(text.trim());
  const [result, setResult] = useState<{ query: string; data: RouteSources } | null>(null);
  const [failed, setFailed] = useState(false);

  // The search box is in the URL, replacing rather than pushing, so Back
  // leaves the page instead of walking back through every letter typed.
  useEffect(() => {
    const handle = setTimeout(() => {
      const q = text.trim();
      setQuery(q);
      setParams(q ? { q } : {}, { replace: true, preventScrollReset: true });
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the text alone
  }, [text]);

  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    void (async () => {
      try {
        // A dropped request is not an empty list (#481).
        const res = await fetchWithRetry(
          () =>
            api.api.comp[":comp_id"].task[":task_id"]["route-sources"].$get(
              { param: { comp_id: compId, task_id: taskId }, query: query ? { q: query } : {} },
              { init: { signal: controller.signal } }
            ),
          { signal: controller.signal }
        );
        if (controller.signal.aborted) return;
        if (!res.ok) {
          setFailed(true);
          return;
        }
        setResult({ query, data: (await res.json()) as RouteSources });
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
    })();
    return () => controller.abort();
  }, [compId, taskId, query]);

  const data = result?.data ?? null;
  return (
    <div className="mt-6 flex flex-col gap-4">
      <SearchField
        aria-label="Search by competition or task name"
        placeholder="Search by competition or task name"
        value={text}
        onChange={setText}
      />
      {failed ? (
        <p className="text-muted-foreground">Could not load the routes. Try again.</p>
      ) : !data ? (
        <Loading>Loading routes…</Loading>
      ) : (
        <>
          <p className="text-sm text-muted-foreground" role="status">
            {orderNote(data, result?.query ?? "")}
          </p>
          {data.routes.length > 0 ? (
            <NavList>
              {data.routes.map((r) => (
                <NavRow
                  key={r.task_id}
                  to={taskRouteCopyFromPath(compId, comp.name, taskId, task.name, {
                    compId: r.comp_id,
                    taskId: r.task_id,
                  })}
                  label={r.task_name}
                  description={[
                    r.this_comp ? "This competition" : r.comp_name,
                    formatTaskDate(r.task_date),
                    routeNames(r.turnpoints),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  value={formatRouteDistance(r.distance_m) ?? undefined}
                />
              ))}
            </NavList>
          ) : null}
        </>
      )}
    </div>
  );
}

/** "ELLIOT → CORRYG → … → GOAL", shortened past {@link NAMES_SHOWN}. */
function routeNames(names: string[]): string {
  if (names.length <= NAMES_SHOWN) return names.join(" → ");
  return [...names.slice(0, NAMES_SHOWN - 1), "…", names[names.length - 1]].join(" → ");
}

/** What the list is, in order, and why: said before the list. */
function orderNote(data: RouteSources, query: string): string {
  const n = data.routes.length;
  if (n === 0) {
    return query ? `No route matches “${query}”.` : "No other task has a saved route yet.";
  }
  const order =
    data.reference === "none"
      ? "Newest first. Once this competition has waypoints or a route, the nearest come first."
      : data.reference === "routes"
        ? "Nearest to this competition’s routes first."
        : data.reference === "waypoints"
          ? "Nearest to this competition’s waypoints first."
          : "Nearest to this competition’s waypoints and routes first.";
  return data.more ? `${order} Showing the first ${n}; search to find others.` : order;
}
