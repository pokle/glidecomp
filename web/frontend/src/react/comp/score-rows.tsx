/**
 * The rows every scores list is made of: the overall standings, the scores by
 * task, the top 3, the teams, the comp page's podium and one pilot's tasks.
 *
 * A scores view used to be a table whose CELLS were the links: on a phone,
 * strips of text 18 px tall, six to a row, in a table that scrolled sideways
 * inside a page that scrolled down, with the total off the right-hand edge.
 * Now a pilot is a ROW, the whole row is the one target (Apple's HIG: a list
 * row that leads somewhere is pressed anywhere and says so with a chevron),
 * and the row is as tall as its two lines — 60 px, never under 44.
 *
 * These are the kit's own pieces, not a new list: the list surface is
 * `NavList`'s, the row is `navRowClass`, and the inside of the row is
 * `RowContent`, the same three the settings and waypoint lists are built of.
 * The rows are real `<a>` elements, because the scores pages are
 * server-rendered and must work with JavaScript off (docs/ssr.md).
 */
import type { ReactNode } from "react";
import { Link as AriaLink } from "react-aria-components";
import { cn } from "@/react/lib/utils";
import { cardSurface } from "@/react/rac/card";
import { navRowClass } from "@/react/rac/nav-list";
import { RowContent } from "@/react/rac/grid-list";
import { formatRankedScore, ordinal } from "../lib/format";

/** The list surface: one card, rows divided by hairlines. */
export function ScoreList({
  label,
  children,
  className,
}: {
  /** The list's accessible name (a heading names a list visually). */
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <ul aria-label={label} className={cn(cardSurface, "divide-y divide-border overflow-hidden", className)}>
      {children}
    </ul>
  );
}

/**
 * The rank at the left of a row. Fixed width so the names line up down the
 * list; a figure, so tabular.
 */
function Rank({ children }: { children: ReactNode }) {
  return (
    <span className="w-10 shrink-0 text-right font-medium tabular-nums text-muted-foreground">
      {children}
    </span>
  );
}

/** The figure at the right of a row: the points that rank the list. */
export function Points({ value, className }: { value: number; className?: string }) {
  return (
    <span className={cn("w-20 shrink-0 text-right font-semibold tabular-nums", className)}>
      {formatRankedScore(value)}
      <span className="sr-only"> points</span>
    </span>
  );
}

interface RowProps {
  /** "1", or "1st" where the list reads as places (top 3, a pilot's tasks). */
  rank: ReactNode;
  title: ReactNode;
  /** The second line: the row's own facts. */
  detail?: ReactNode;
  detailClassName?: string;
  /** Right of the name: the points, and on a wide screen any columns. */
  figure: ReactNode;
}

/** A row that opens a page: the whole row is the link. */
export function ScoreLinkRow({ href, ...row }: RowProps & { href: string }) {
  return (
    <li>
      <AriaLink href={href} className={cn(navRowClass, "min-h-14")}>
        <RowContent
          leading={<Rank>{row.rank}</Rank>}
          title={row.title}
          detail={row.detail}
          detailClassName={row.detailClassName}
          action={row.figure}
          chevron
        />
      </AriaLink>
    </li>
  );
}

/**
 * A row with nothing behind it (a team has no page). No chevron, because a
 * row that opens nothing must not claim to — RowContent's own rule.
 */
export function ScoreStaticRow(row: RowProps) {
  return (
    <li className={cn(navRowClass, "min-h-14")}>
      <RowContent
        leading={<Rank>{row.rank}</Rank>}
        title={row.title}
        detail={row.detail}
        detailClassName={row.detailClassName}
        action={row.figure}
      />
    </li>
  );
}

// ── Task columns, on a screen wide enough for them ──────────────────────────

/**
 * Whether a screen has room for one column per task inside each row, and from
 * which width. Worked from the row's own parts (gutters, the rank, a name of at
 * least 160 px, the total, the chevron, the gaps) against the page's wide
 * column at each breakpoint: five 96 px columns fit at `lg`, six at `xl`.
 * Beyond that the second line carries the places and the pilot's own page
 * carries every task in full.
 */
export function taskColumnsAt(taskCount: number): "lg" | "xl" | null {
  if (taskCount <= 5) return "lg";
  if (taskCount <= 6) return "xl";
  return null;
}

/** Shown where the columns are, hidden where the second line takes over. */
export function columnsShownClass(at: "lg" | "xl" | null): string {
  return at === "lg" ? "hidden lg:flex" : at === "xl" ? "hidden xl:flex" : "hidden";
}

/** The second line's class where it gives way to columns. */
export function detailHiddenClass(at: "lg" | "xl" | null): string | undefined {
  return at === "lg" ? "lg:hidden" : at === "xl" ? "xl:hidden" : undefined;
}

/** One task's cell inside a row: the score, and the place in brackets. */
export function TaskColumn({
  score,
  rank,
  struck = false,
}: {
  score: number | null;
  rank?: number;
  /** Dropped under FTV. */
  struck?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "w-24 shrink-0 text-right text-sm tabular-nums",
        struck && "text-muted-foreground line-through"
      )}
    >
      {score === null ? (
        "—"
      ) : (
        <>
          {formatRankedScore(score)}
          {rank !== undefined ? (
            <span className="text-muted-foreground"> ({ordinal(rank)})</span>
          ) : null}
        </>
      )}
    </span>
  );
}

/**
 * The headings over a list of score rows. Where the screen has room for task
 * columns, a heading per column; where it does not, the second line's name
 * ("Pilot · place in each task") and the total's.
 *
 * Not a table header — the list is a list — so it is hidden from assistive
 * technology: each row already says in words what every figure in it is.
 */
export function TaskColumnsHeader({
  at,
  first,
  narrowFirst,
  tasks,
  last,
}: {
  at: "lg" | "xl" | null;
  first: string;
  narrowFirst: string;
  tasks: Array<{ task_id: string; task_name: string }>;
  last: string;
}) {
  const head = "items-end gap-3 px-4 pb-1.5 text-sm font-medium text-muted-foreground";
  return (
    <>
      <div
        aria-hidden="true"
        className={cn("flex", at === "lg" ? "lg:hidden" : at === "xl" ? "xl:hidden" : undefined, head)}
      >
        <span className="min-w-0 flex-1 truncate">{narrowFirst}</span>
        <span className="shrink-0 pr-7 text-right">{last}</span>
      </div>
      <div aria-hidden="true" className={cn(columnsShownClass(at), head)}>
        <span className="w-10 shrink-0" />
        <span className="min-w-0 flex-1">{first}</span>
        {tasks.map((t) => (
          <span key={t.task_id} className="w-24 shrink-0 truncate text-right" title={t.task_name}>
            {t.task_name}
          </span>
        ))}
        <span className="w-20 shrink-0 text-right">{last}</span>
        {/* The chevron's width, so the last heading sits over its figures. */}
        <span className="size-4 shrink-0" />
      </div>
    </>
  );
}
