/**
 * The comp analysis's way into each task's own analysis: the chapters the
 * comp page collects, one per task of the class being read.
 *
 * One list, two shapes, and only CSS between them — never two components:
 *  - on a phone, an inset grouped list (the iOS Settings shape, and the comp
 *    page's task rows): the whole row is the target, 44 px and up, with a
 *    chevron saying it opens a page;
 *  - from `sm` up, the same rows as tiles side by side, because this page is
 *    shown on a big screen as often as on a phone, and a row stretched across
 *    a projector is a long way from its own chevron.
 *
 * They were inline text links, a "Per task:" sentence of them, 20 px tall on
 * a phone. They are links, not buttons, at every width: they go somewhere.
 */
import { Link as AriaLink } from "react-aria-components";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "@/react/lib/utils";
import { CardTitle, cardSurface } from "@/react/rac/card";
import { navRowClass } from "@/react/rac/nav-list";
import { formatTaskDate } from "../lib/format";

export interface TaskAnalysisLink {
  taskId: string;
  /** The column header this task has in the tables below ("T1"). */
  label: string;
  /** The task's name, as the organiser wrote it. */
  name: string;
  /** YYYY-MM-DD. */
  date: string;
  /** Pilots analysed in this task for this class; absent on an older API. */
  pilotCount?: number;
  href: string;
}

export function TaskAnalysisList({
  tasks,
  className,
}: {
  tasks: TaskAnalysisLink[];
  className?: string;
}) {
  if (tasks.length === 0) return null;
  return (
    <nav aria-labelledby="task-analyses-heading" className={className}>
      <CardTitle id="task-analyses-heading" className="mb-2">
        Task analyses
      </CardTitle>
      <ul
        className={cn(
          cardSurface,
          "divide-y divide-border overflow-hidden",
          // From sm up the list's own surface goes and each row becomes one.
          "sm:grid sm:grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] sm:gap-3 sm:divide-y-0 sm:overflow-visible sm:rounded-none sm:border-0 sm:bg-transparent sm:shadow-none"
        )}
      >
        {tasks.map((t) => (
          <li key={t.taskId} className="flex">
            <AriaLink
              href={t.href}
              className={cn(
                navRowClass,
                "sm:h-full sm:rounded-xl sm:border sm:bg-card sm:shadow-card sm:data-focus-visible:ring-offset-0"
              )}
            >
              {/* The column header the tables use for this task, so a reader
                  can carry "T2" from the table to the row that opens it. */}
              <span className="w-7 shrink-0 text-sm font-medium tabular-nums text-muted-foreground">
                {t.label}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium">{t.name}</span>
                <span className="text-sm tabular-nums text-muted-foreground">
                  {formatTaskDate(t.date, {
                    weekday: "short",
                    day: "numeric",
                    month: "short",
                  })}
                  {t.pilotCount !== undefined
                    ? ` · ${t.pilotCount} pilot${t.pilotCount === 1 ? "" : "s"}`
                    : null}
                </span>
              </span>
              <ChevronRightIcon
                aria-hidden
                className="size-4 shrink-0 text-muted-foreground"
              />
            </AriaLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
