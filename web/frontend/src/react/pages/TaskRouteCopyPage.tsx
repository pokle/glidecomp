/**
 * Copy from another competition (/comp/:c/task/:t/route/copy[?q=…]) — a whole
 * route from another task's saved one. A page of the route editor, like Load
 * from XContest (#812): ADMIN-ONLY and NOT SSR'd (a noindex shell in
 * functions/comp/[[path]].ts), and it edits the same DRAFT
 * (comp/route-draft.ts), so going here and back is not leaving the editor.
 *
 * Every saved route the organiser can see, nearest first: measured from each
 * route's take-off to the nearest of this competition's waypoints and route
 * turnpoints, so last year's routes at the same site come to the top
 * (competition-api's route-sources.ts). A competition that knows no place
 * yet lists the newest first. The distance orders the list and never filters
 * it, and the search box narrows it by competition or task name for a route
 * flown somewhere else. The search is in the URL (`?q=`), so a reload or
 * Back keeps it.
 *
 * Choosing a route reads that task through the ordinary task route (so a
 * hidden competition's route is there for its organisers and nobody else),
 * moves its start gates, goal deadline and take-off window to the same LOCAL
 * time on this task's day (`rebaseRouteTimes`), puts it into the draft —
 * asking first when that would replace turnpoints already there — and goes
 * back to the route. Nothing is saved until Save on the route.
 */
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { Button } from "@/react/rac/button";
import { SearchField } from "@/react/rac/field";
import { ActionErrorBanner, useAction } from "@/react/rac/form";
import { NavActionRow, NavList } from "@/react/rac/nav-list";
import { Loading } from "@/react/rac/progress";
import type { XCTask } from "@glidecomp/engine";
import { api } from "../../comp/api";
import { SectionHeader } from "../components/SectionHeader";
import { formatRouteDistance, rebaseRouteTimes } from "../comp/comp-copy";
import { routeEditorGate } from "../comp/RouteEditorGate";
import { fetchWithRetry } from "../comp/types";
import { useLoadRoute, useRouteEditor, type RouteEditorState } from "../comp/use-route-editor";
import { underTaskRoute } from "../lib/crumbs";
import { formatTaskDate } from "../lib/format";
import { taskRouteCopyPath } from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";

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
  const editor = useRouteEditor();
  const { urlId, compName, taskId, taskName } = editor;
  useCanonicalPath(
    editor.comp && editor.task && editor.current
      ? taskRouteCopyPath(urlId, compName, taskId, taskName)
      : null
  );
  const gate = routeEditorGate(editor);
  if (gate) return gate;
  return <CopyRoute editor={editor} />;
}

function CopyRoute({ editor }: { editor: RouteEditorState }) {
  const { urlId, compName, taskId, taskName } = editor;
  const loadRoute = useLoadRoute(editor);
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(() => params.get("q") ?? "");
  const [query, setQuery] = useState(text.trim());
  const [result, setResult] = useState<{ query: string; data: RouteSources } | null>(null);
  const [failed, setFailed] = useState(false);
  // Choosing a route is an action, not a form: one press at a time, the row
  // pressed says it is busy, and a refusal sits beside the list (rac/form).
  const action = useAction();

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
              { param: { comp_id: urlId, task_id: taskId }, query: query ? { q: query } : {} },
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
  }, [urlId, taskId, query]);

  async function choose(source: RouteSource) {
    const res = await action.run(
      // A dropped request is not a missing route (#481).
      () =>
        fetchWithRetry(() =>
          api.api.comp[":comp_id"].task[":task_id"].$get({
            param: { comp_id: source.comp_id, task_id: source.task_id },
          })
        ),
      { key: source.task_id, fallback: `Could not read the route of ${source.task_name}.` }
    );
    if (!res) return;
    const body = (await res.json()) as unknown as { task_date: string; xctsk: XCTask | null };
    if (!body.xctsk) {
      action.refuse(`${source.task_name} has no saved route any more.`);
      return;
    }
    const task = rebaseRouteTimes(
      body.xctsk,
      body.task_date,
      editor.task?.task_date ?? body.task_date,
      editor.tz
    );
    const label = source.this_comp
      ? source.task_name
      : `${source.task_name} (${source.comp_name})`;
    // The load may have asked first ("Replace the route…?").
    if (await loadRoute(task, label)) editor.leave();
  }

  const data = result?.data ?? null;
  return (
    <div className="max-w-2xl">
      <Breadcrumbs items={underTaskRoute(urlId, compName, taskId, taskName)} current={TITLE} />
      <SectionHeader
        as="h1"
        className="mt-2"
        title={TITLE}
        action={
          <Button variant="outline" onPress={() => editor.leave()}>
            Cancel
          </Button>
        }
      />
      <p className="mt-2 text-sm text-muted-foreground">
        Choose a route to load into {taskName}. It replaces the route; nothing is saved until
        you press Save.
      </p>
      <div className="mt-6 flex flex-col gap-4">
        <SearchField
          aria-label="Search by competition or task name"
          placeholder="Search by competition or task name"
          value={text}
          onChange={setText}
        />
        <ActionErrorBanner action={action} />
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
                  <NavActionRow
                    key={r.task_id}
                    onPress={() => void choose(r)}
                    isPending={action.pendingKey === r.task_id}
                    pendingLabel={`Loading ${r.task_name}`}
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
