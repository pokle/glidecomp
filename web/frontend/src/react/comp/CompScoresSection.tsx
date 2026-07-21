/**
 * Whole-competition scores, inline on the comp page (IA v2 #277 — the comp
 * page is the canonical scores surface; the old /scores route redirects
 * here). View transforms (class rollups, top-3, teams) come from the shared
 * scores-views module; the "Results by task" tab reuses the task page's
 * ScoresSection one task at a time. Built on the RAC kit: the view tabs are
 * ARIA tabs, and each view is a sortable ARIA-grid table (RAC sorting with
 * per-column first-click directions — scores read best-first).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link as AriaLink, type SortDescriptor } from "react-aria-components";
import { Button } from "@/react/rac/button";
import { Select, SelectItem } from "@/react/rac/select";
import { Table, TableHeader, TableBody, Column, Row, Cell } from "@/react/rac/table";
import { Tabs, TabList, Tab, TabPanel } from "@/react/rac/tabs";
import {
  aggregateTeams,
  buildClassGroups,
  computeTop3Rows,
  type ClassStanding,
} from "../../scores-views";
import { ScoreFreshness } from "./ScoreFreshness";
import { ScoresSection } from "./ScoresSection";
import { toast } from "../lib/toast";
import { formatScore, formatTaskDate, ordinal } from "../lib/format";
import type { TaskSummary } from "./types";
// Single source of truth for the /scores response shape, shared with the loader.
import type { CompScores } from "../loaders";

function scoreDetailHref(compId: string, taskId: string, pilotId: string): string {
  return `/comp/${encodeURIComponent(compId)}/task/${encodeURIComponent(taskId)}/pilot/${encodeURIComponent(pilotId)}`;
}

const cellLinkClass =
  "underline underline-offset-4 outline-none data-focus-visible:ring-2 data-focus-visible:ring-ring/50";

export function CompScoresSection({
  compId,
  timezone,
  tasks,
  defaultTaskId,
  initialScores,
  initialScoresEtag,
  isAdmin = false,
}: {
  compId: string;
  timezone: string | null;
  /** The comp's tasks, for the "Results by task" picker. */
  tasks: TaskSummary[];
  /** Task pre-selected in "Results by task" (the hero task). */
  defaultTaskId: string | null;
  /** SSR-seeded scores so they appear in the first paint (server HTML). */
  initialScores?: CompScores;
  initialScoresEtag?: string | null;
  /** Admins get an actionable empty state (false during SSR/first paint). */
  isAdmin?: boolean;
}) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "unavailable" }
    | { kind: "ready"; scores: CompScores; etag: string | null }
  >(
    initialScores
      ? { kind: "ready", scores: initialScores, etag: initialScoresEtag ?? null }
      : { kind: "loading" }
  );
  // Freshness is handled by ScoreFreshness's polling, so — like before — we
  // fetch once per compId. When seeded from SSR, that first fetch is already
  // satisfied; skip it so the first render stays identical to the server.
  const seededRef = useRef(initialScores != null);
  const [rescoring, setRescoring] = useState(false);

  useEffect(() => {
    if (seededRef.current) {
      seededRef.current = false;
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/comp/${encodeURIComponent(compId)}/scores`, {
          credentials: "include",
        });
        if (cancelled) return;
        if (!res.ok) {
          setState({ kind: "unavailable" });
          return;
        }
        const scores = (await res.json()) as CompScores;
        if (cancelled) return;
        setState({ kind: "ready", scores, etag: res.headers.get("ETag") });
      } catch {
        if (!cancelled) setState({ kind: "unavailable" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [compId]);

  /**
   * Admin "Recompute scores" action (issue #343). POSTs the rescore trigger,
   * then re-reads /scores so the now-stale body + ETag flow into
   * ScoreFreshness, which polls and surfaces the "re-scoring… / finished"
   * notice — giving the explicit rescore affordance Tom asked for.
   */
  async function handleRescore() {
    setRescoring(true);
    try {
      const res = await fetch(`/api/comp/${encodeURIComponent(compId)}/rescore`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        toast.error("Couldn't start the re-score. Please try again.");
        return;
      }
      const refreshed = await fetch(
        `/api/comp/${encodeURIComponent(compId)}/scores`,
        { credentials: "include" }
      );
      if (refreshed.ok) {
        const scores = (await refreshed.json()) as CompScores;
        setState({ kind: "ready", scores, etag: refreshed.headers.get("ETag") });
      }
      toast.success("Re-scoring started — scores will refresh shortly.");
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setRescoring(false);
    }
  }

  return (
    <section id="scores" className="scroll-mt-4 break-before-page">
      <div className="mt-8 flex items-center justify-between gap-4">
        <h2 className="text-lg font-bold">Scores</h2>
        {isAdmin && state.kind === "ready" && state.scores.standings.length > 0 ? (
          <Button
            variant="outline"
            size="sm"
            onPress={() => void handleRescore()}
            isDisabled={rescoring}
          >
            {rescoring ? "Re-scoring…" : "Recompute scores"}
          </Button>
        ) : null}
      </div>
      {state.kind === "loading" ? (
        <p className="mt-2 text-muted-foreground">Loading scores…</p>
      ) : state.kind === "unavailable" ? (
        <ScoresEmptyState isAdmin={isAdmin} />
      ) : (
        <>
          <ScoreFreshness
            computedAt={state.scores.computed_at}
            stale={state.scores.stale}
            timezone={timezone}
            etag={state.etag}
            pollUrl={`/api/comp/${encodeURIComponent(compId)}/scores`}
          />
          {state.scores.standings.length === 0 ? (
            <ScoresEmptyState isAdmin={isAdmin} />
          ) : (
            <>
              <ScoresViews
                scores={state.scores}
                compId={compId}
                timezone={timezone}
                tasks={tasks}
                defaultTaskId={defaultTaskId}
              />
              <p className="mt-4 text-sm text-muted-foreground">
                Click any score for a step-by-step explanation. Questions about a score?{" "}
                <a href="#admins" className="underline underline-offset-4">
                  Ask the comp admins
                </a>
                .
              </p>
            </>
          )}
        </>
      )}
    </section>
  );
}

/**
 * Role-aware empty state: visitors learn why there's nothing here; admins
 * are pointed at the action that produces scores. isAdmin resolves after
 * hydration, so SSR always renders the visitor sentence.
 */
function ScoresEmptyState({ isAdmin }: { isAdmin: boolean }) {
  return (
    <div className="mt-2 text-muted-foreground">
      <p>No scores yet — they appear automatically once pilots submit tracks for a task.</p>
      {isAdmin ? (
        <p className="mt-1">
          Set a{" "}
          <a href="#tasks" className="underline underline-offset-4">
            task's route
          </a>{" "}
          and submit tracks to see scores here.
        </p>
      ) : null}
    </div>
  );
}

function ScoresViews({
  scores,
  compId,
  timezone,
  tasks,
  defaultTaskId,
}: {
  scores: CompScores;
  compId: string;
  timezone: string | null;
  tasks: TaskSummary[];
  defaultTaskId: string | null;
}) {
  const teams = useMemo(() => aggregateTeams(scores.standings), [scores]);
  const groups = useMemo(() => buildClassGroups(scores.standings), [scores]);
  const firstTab = `standings:${scores.standings[0].pilot_class}`;
  const [tab, setTab] = useState(firstTab);
  const scorableTasks = tasks.filter((t) => t.has_xctsk);
  const [pickedTaskId, setPickedTaskId] = useState(
    defaultTaskId ?? scorableTasks[0]?.task_id ?? null
  );

  return (
    <Tabs
      selectedKey={tab}
      onSelectionChange={(key) => setTab(String(key))}
      className="mt-4"
    >
      <TabList aria-label="Score views">
        {scores.standings.map((cls) => (
          <Tab key={cls.pilot_class} id={`standings:${cls.pilot_class}`}>
            {cls.pilot_class}
          </Tab>
        ))}
        <Tab id="top3">Top 3 per task &amp; class</Tab>
        {teams.length > 0 ? <Tab id="teams">Teams</Tab> : null}
        {scorableTasks.length > 0 ? <Tab id="bytask">Results by task</Tab> : null}
      </TabList>

      {scores.standings.map((cls) => (
        <TabPanel key={cls.pilot_class} id={`standings:${cls.pilot_class}`}>
          <StandingsTable scores={scores} cls={cls} />
        </TabPanel>
      ))}

      <TabPanel id="top3">
        {groups.map((group) => (
          <section key={group.label}>
            <h3 className="mt-6 font-bold">{group.label}</h3>
            {group.classes.length > 1 ? (
              <p className="text-sm text-muted-foreground">
                Combined: {group.classes.join(", ")}
              </p>
            ) : null}
            <Top3Table scores={scores} group={group} />
          </section>
        ))}
      </TabPanel>

      {teams.length > 0 ? (
        <TabPanel id="teams">
          <TeamsTable scores={scores} teams={teams} />
        </TabPanel>
      ) : null}

      {scorableTasks.length > 0 && pickedTaskId ? (
        <TabPanel id="bytask">
          {/* One task at a time — every task's full tables at once is too
              heavy for long comps. */}
          <Select
            label="Task"
            className="mt-2 w-fit"
            selectedKey={pickedTaskId}
            onSelectionChange={(key) => {
              if (key != null) setPickedTaskId(String(key));
            }}
          >
            {scorableTasks.map((t) => (
              <SelectItem key={t.task_id} id={t.task_id}>
                {`${t.name} — ${formatTaskDate(t.task_date)}`}
              </SelectItem>
            ))}
          </Select>
          <ScoresSection
            key={pickedTaskId}
            compId={compId}
            taskId={pickedTaskId}
            refresh={0}
            timezone={timezone}
            onReplayAvailable={() => {}}
            embedded
          />
        </TabPanel>
      ) : null}
    </Tabs>
  );
}

// ── Sortable table ────────────────────────────────────────────────────────────

interface ColumnSpec {
  label: string;
  title?: string;
  /** First-click sort direction; scores read best-first when descending. */
  defaultDir?: "asc" | "desc";
  /**
   * Right-align the header and every cell in this column (with tabular figures),
   * so quantities line up digit-for-digit and can be compared down the column.
   * Columns are left-aligned by default — set this only for pure numbers.
   */
  align?: "right";
  /** The one column whose cells name each row for AT (exactly one per table). */
  isRowHeader?: boolean;
}

interface CellSpec {
  /** Value used for ordering; "" always sorts to the bottom of score columns. */
  sort: string;
  node: React.ReactNode;
}

function SortableTable({
  label,
  columns,
  rows,
}: {
  /** Accessible name for the grid. */
  label: string;
  columns: ColumnSpec[];
  rows: CellSpec[][];
}) {
  const [sort, setSort] = useState<SortDescriptor | null>(null);

  const numericColumn = (col: number) => {
    const values = rows.map((row) => row[col]?.sort ?? "");
    return values.every((v) => v === "" || !Number.isNaN(Number(v)));
  };

  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    const col = Number(sort.column);
    const values = rows.map((row) => row[col]?.sort ?? "");
    const numeric = values.every((v) => v === "" || !Number.isNaN(Number(v)));
    return rows
      .map((row, i) => ({ row, value: values[i] }))
      .sort((a, b) => {
        let cmp: number;
        if (numeric) {
          const av = a.value === "" ? -Infinity : Number(a.value);
          const bv = b.value === "" ? -Infinity : Number(b.value);
          cmp = av - bv;
        } else {
          cmp = a.value.localeCompare(b.value);
        }
        return sort.direction === "ascending" ? cmp : -cmp;
      })
      .map(({ row }) => row);
  }, [rows, sort]);

  return (
    <div className="mt-3 overflow-x-auto rounded-lg border">
      <Table
        aria-label={label}
        sortDescriptor={sort ?? undefined}
        onSortChange={(desc) =>
          setSort((prev) => {
            // Same column: RAC already toggled the direction relative to prev.
            if (prev && prev.column === desc.column) return desc;
            // New column: start from its default direction, not RAC's
            // always-ascending — scores read best-first (descending).
            const col = Number(desc.column);
            const dir =
              columns[col]?.defaultDir ?? (numericColumn(col) ? "desc" : "asc");
            return {
              column: desc.column,
              direction: dir === "asc" ? "ascending" : "descending",
            };
          })
        }
      >
        <TableHeader>
          {columns.map((col, i) => (
            <Column
              key={i}
              id={String(i)}
              allowsSorting
              isRowHeader={col.isRowHeader ?? false}
              className={
                col.align === "right"
                  ? "cursor-pointer text-right data-hovered:bg-muted/50"
                  : "cursor-pointer data-hovered:bg-muted/50"
              }
            >
              {({ sortDirection }) => (
                // The date tooltip rides on an inner span — RAC Columns filter
                // out non-ARIA DOM attributes like title.
                <span title={col.title}>
                  {col.label}
                  {sortDirection ? (sortDirection === "ascending" ? " ▲" : " ▼") : ""}
                </span>
              )}
            </Column>
          ))}
        </TableHeader>
        <TableBody>
          {sortedRows.map((row, i) => (
            <Row key={i}>
              {row.map((cell, j) => (
                <Cell
                  key={j}
                  className={
                    columns[j]?.align === "right" ? "text-right tabular-nums" : undefined
                  }
                >
                  {cell.node}
                </Cell>
              ))}
            </Row>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ── Views ─────────────────────────────────────────────────────────────────────

function StandingsTable({ scores, cls }: { scores: CompScores; cls: ClassStanding }) {
  // Only show columns for tasks flown by this pilot class — classes fly
  // different tasks, so mixing them would leave every off-class cell blank.
  const classTasks = scores.tasks.filter((t) => t.classes.includes(cls.pilot_class));

  const columns: ColumnSpec[] = [
    { label: "#", defaultDir: "asc", align: "right" },
    { label: "Pilot", defaultDir: "asc", isRowHeader: true },
    ...classTasks.map((t) => ({
      label: t.task_name,
      title: t.task_date,
      defaultDir: "desc" as const,
      align: "right" as const,
    })),
    { label: "Total", defaultDir: "desc", align: "right" },
  ];

  const rows: CellSpec[][] = cls.pilots.map((p) => [
    { sort: String(p.rank), node: p.rank },
    { sort: p.pilot_name, node: p.pilot_name },
    ...classTasks.map((task): CellSpec => {
      const entry = p.tasks.find((t) => t.task_id === task.task_id);
      if (!entry) return { sort: "", node: "—" };
      return {
        sort: String(entry.score),
        node: (
          <AriaLink
            href={scoreDetailHref(scores.comp_id, task.task_id, p.comp_pilot_id)}
            aria-label={`How ${p.pilot_name}'s score for ${task.task_name} was calculated`}
            className={cellLinkClass}
          >
            {formatScore(entry.score)}{" "}
            <span className="text-muted-foreground">({ordinal(entry.rank)})</span>
          </AriaLink>
        ),
      };
    }),
    { sort: String(p.total_score), node: <strong>{formatScore(p.total_score)}</strong> },
  ]);

  return (
    <SortableTable label={`Standings — ${cls.pilot_class}`} columns={columns} rows={rows} />
  );
}

function Top3Table({
  scores,
  group,
}: {
  scores: CompScores;
  group: ReturnType<typeof buildClassGroups>[number];
}) {
  const rows = computeTop3Rows(group, scores.tasks);

  // Left-aligned throughout: the place columns read "PilotName · score", so the
  // number sits behind a name of varying length and right-aligning it would not
  // line the scores up anyway.
  const columns: ColumnSpec[] = [
    { label: "Task", defaultDir: "asc", isRowHeader: true },
    { label: "1st", defaultDir: "desc" },
    { label: "2nd", defaultDir: "desc" },
    { label: "3rd", defaultDir: "desc" },
  ];

  const tableRows: CellSpec[][] = rows.map((row) => {
    const isTotal = row.task_id === null;
    return [
      {
        sort: row.label,
        node: isTotal ? <strong title={row.task_date ?? undefined}>{row.label}</strong> : row.label,
      },
      ...[0, 1, 2].map((place): CellSpec => {
        const entry = row.entries[place];
        if (!entry) return { sort: "", node: "—" };
        const content = (
          <>
            {entry.pilot_name} · {isTotal ? <strong>{formatScore(entry.score)}</strong> : formatScore(entry.score)}
          </>
        );
        return {
          sort: String(entry.score),
          node: row.task_id ? (
            <AriaLink
              href={scoreDetailHref(scores.comp_id, row.task_id, entry.comp_pilot_id)}
              aria-label={`How ${entry.pilot_name}'s score for ${row.label} was calculated`}
              className={cellLinkClass}
            >
              {content}
            </AriaLink>
          ) : (
            content
          ),
        };
      }),
    ];
  });

  return (
    <SortableTable label={`Top 3 — ${group.label}`} columns={columns} rows={tableRows} />
  );
}

function TeamsTable({
  scores,
  teams,
}: {
  scores: CompScores;
  teams: ReturnType<typeof aggregateTeams>;
}) {
  const columns: ColumnSpec[] = [
    { label: "#", defaultDir: "asc", align: "right" },
    { label: "Team", defaultDir: "asc", isRowHeader: true },
    ...scores.tasks.map((t) => ({
      label: t.task_name,
      title: t.task_date,
      defaultDir: "desc" as const,
      align: "right" as const,
    })),
    { label: "Total", defaultDir: "desc", align: "right" },
  ];

  const rows: CellSpec[][] = teams.map((team) => [
    { sort: String(team.rank), node: team.rank },
    {
      sort: team.team_name,
      node: (
        <>
          <div>
            <strong>{team.team_name}</strong>
          </div>
          <div className="text-sm text-muted-foreground">{team.pilots.join(", ")}</div>
        </>
      ),
    },
    ...scores.tasks.map((task): CellSpec => {
      const score = team.task_scores[task.task_id];
      return score !== undefined
        ? { sort: String(score), node: formatScore(score) }
        : { sort: "", node: "—" };
    }),
    { sort: String(team.total_score), node: <strong>{formatScore(team.total_score)}</strong> },
  ]);

  return <SortableTable label="Team standings" columns={columns} rows={rows} />;
}
