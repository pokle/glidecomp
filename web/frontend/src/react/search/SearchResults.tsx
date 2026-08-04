/**
 * Search results as the hierarchy they live in: competition → task → pilot.
 *
 * The endpoint only returns what MATCHED, and this renders that literally —
 * a level nobody asked about collapses to a count and a link. So a turnpoint
 * query shows the tasks that fly through it and says "47 pilots"; a pilot's
 * name shows them under each task they flew. The alternative, filling in the
 * levels nobody asked about, buries the answer in the thing it was found in.
 *
 * Rendered client-side only (see Competitions.tsx): search results are not
 * something to server-render or index.
 */
import { Link as AriaLink } from "react-aria-components";
import { Loading } from "@/react/rac/progress";
import { cardSurface } from "@/react/rac/card";
import { cn } from "@/react/lib/utils";
import { compPath, compPilotsPath, pilotPath, taskPath } from "../lib/slug";
import { categoryLabel, formatDate, scoringFormatLabel } from "../lib/format";
import type { SearchComp, SearchState, SearchTask } from "./use-site-search";

export function SearchResults({ state, query }: { state: SearchState; query: string }) {
  if (state.status === "idle") return null;

  if (state.status === "error") {
    // Deliberately not "no matches": a dropped request is not the fact that
    // nothing was found, and a visitor would act on the two differently.
    return (
      <p role="alert" className="mt-4">
        Search is unavailable right now. Please try again.
      </p>
    );
  }

  const searching = state.status === "searching";
  const results = state.results;

  if (!results) {
    return <Loading className="mt-4">Searching…</Loading>;
  }

  const total = results.comps.length;

  return (
    <div className="mt-4" aria-busy={searching || undefined}>
      <p role="status" className="sr-only">
        {searching
          ? "Searching…"
          : total === 0
            ? `No matches for ${query}`
            : total === 1
              ? `1 competition matches ${query}`
              : `${total} competitions match ${query}`}
      </p>

      {total === 0 ? (
        <p className="text-muted-foreground">
          Nothing matches “{query.trim()}”. Try a competition, a pilot, or a
          turnpoint code such as KANGCK.
        </p>
      ) : (
        <ul className="space-y-2.5">
          {results.comps.map((comp) => (
            <li key={comp.comp_id}>
              <CompResult comp={comp} />
            </li>
          ))}
        </ul>
      )}

      {results.truncated ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Only the closest matches are shown. Add another word to narrow the
          search.
        </p>
      ) : null}
    </div>
  );
}

function CompResult({ comp }: { comp: SearchComp }) {
  const meta = [
    categoryLabel(comp.category),
    scoringFormatLabel(comp.scoring_format),
    `${comp.task_count} task${comp.task_count === 1 ? "" : "s"}`,
  ].join(" · ");

  return (
    <div className={cn(cardSurface, "overflow-hidden")}>
      <AriaLink
        href={compPath(comp.comp_id, comp.name)}
        className="block rounded-t-lg px-4 py-3 transition-colors outline-none data-hovered:bg-muted data-focus-visible:border-ring data-focus-visible:ring-3 data-focus-visible:ring-ring/50"
      >
        <span className="block font-semibold">
          {comp.name}
          {comp.test ? (
            <span className="ml-2 inline-flex items-center rounded-full border px-2 py-0.5 align-middle text-xs font-medium text-muted-foreground">
              Hidden
            </span>
          ) : null}
        </span>
        <span className="block text-sm text-muted-foreground">{meta}</span>
      </AriaLink>

      {comp.tasks.length > 0 || comp.pilots.length > 0 ? (
        <div className="border-t px-4 py-2">
          {comp.tasks.length > 0 ? (
            <ul className="divide-y">
              {comp.tasks.map((task) => (
                <li key={task.task_id} className="py-2">
                  <TaskResult comp={comp} task={task} />
                </li>
              ))}
            </ul>
          ) : null}

          {comp.pilots.length > 0 ? (
            <p className="py-2 text-sm">
              {/* Registered but with no flight yet, so there is no per-task
                  page to send them to — the roster is where they exist. */}
              <AriaLink
                href={compPilotsPath(comp.comp_id, comp.name)}
                className="underline underline-offset-4 outline-none data-focus-visible:ring-3 data-focus-visible:ring-ring/50"
              >
                {comp.pilots.map((p) => p.name).join(", ")}
              </AriaLink>{" "}
              <span className="text-muted-foreground">
                — on the roster, no task flown yet
              </span>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TaskResult({ comp, task }: { comp: SearchComp; task: SearchTask }) {
  return (
    <div>
      <AriaLink
        href={taskPath(comp.comp_id, comp.name, task.task_id, task.name)}
        className="flex flex-wrap items-baseline gap-x-3 rounded-md outline-none data-hovered:underline data-focus-visible:ring-3 data-focus-visible:ring-ring/50"
      >
        <span className="font-medium">{task.name}</span>
        <span className="text-sm text-muted-foreground">
          {task.task_date ? formatDate(task.task_date) : null}
        </span>
      </AriaLink>

      {task.matched_turnpoints.length > 0 ? (
        <p className="mt-0.5 text-sm text-muted-foreground">
          via {task.matched_turnpoints.join(", ")}
        </p>
      ) : null}

      {task.pilots.length > 0 ? (
        <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
          {task.pilots.map((pilot) => (
            <li key={pilot.comp_pilot_id}>
              <AriaLink
                href={pilotPath(
                  comp.comp_id,
                  comp.name,
                  task.task_id,
                  task.name,
                  pilot.comp_pilot_id,
                  pilot.name
                )}
                className="text-sm underline underline-offset-4 outline-none data-focus-visible:ring-3 data-focus-visible:ring-ring/50"
              >
                {pilot.name}
              </AriaLink>
            </li>
          ))}
        </ul>
      ) : task.pilot_count > 0 ? (
        <p className="mt-0.5 text-sm text-muted-foreground">
          {task.pilot_count} pilot{task.pilot_count === 1 ? "" : "s"}
        </p>
      ) : null}
    </div>
  );
}
