/**
 * Whole-competition scores, inline on the comp page (IA v2 #277 — the comp
 * page is the canonical scores surface; the old /scores route redirects
 * here). View transforms (class rollups, top-3, teams) come from the shared
 * scores-views module; the "Results by task" tab reuses the task page's
 * ScoresSection one task at a time.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/react/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/react/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/react/ui/tabs";
import {
  aggregateTeams,
  buildClassGroups,
  computeTop3Rows,
  type ClassStanding,
} from "../../scores-views";
import { ScoreFreshness } from "./ScoreFreshness";
import { ScoresSection } from "./ScoresSection";
import { formatScore, formatTaskDate, ordinal } from "../lib/format";
import type { TaskSummary } from "./types";
// Single source of truth for the /scores response shape, shared with the loader.
import type { CompScores } from "../loaders";

function scoreDetailHref(compId: string, taskId: string, pilotId: string): string {
  return `/comp/${encodeURIComponent(compId)}/task/${encodeURIComponent(taskId)}/pilot/${encodeURIComponent(pilotId)}`;
}

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

  return (
    <section id="scores" className="scroll-mt-4 break-before-page">
      <h2 className="mt-8 text-lg font-bold">Scores</h2>
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
    <Tabs value={tab} onValueChange={(value) => setTab(value as string)} className="mt-4">
      <TabsList>
        {scores.standings.map((cls) => (
          <TabsTrigger key={cls.pilot_class} value={`standings:${cls.pilot_class}`}>
            {cls.pilot_class}
          </TabsTrigger>
        ))}
        <TabsTrigger value="top3">Top 3 per task &amp; class</TabsTrigger>
        {teams.length > 0 ? <TabsTrigger value="teams">Teams</TabsTrigger> : null}
        {scorableTasks.length > 0 ? (
          <TabsTrigger value="bytask">Results by task</TabsTrigger>
        ) : null}
      </TabsList>

      {scores.standings.map((cls) => (
        <TabsContent key={cls.pilot_class} value={`standings:${cls.pilot_class}`}>
          <StandingsTable scores={scores} cls={cls} />
        </TabsContent>
      ))}

      <TabsContent value="top3">
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
      </TabsContent>

      {teams.length > 0 ? (
        <TabsContent value="teams">
          <TeamsTable scores={scores} teams={teams} />
        </TabsContent>
      ) : null}

      {scorableTasks.length > 0 && pickedTaskId ? (
        <TabsContent value="bytask">
          {/* One task at a time — every task's full tables at once is too
              heavy for long comps. */}
          <label className="mt-2 block text-sm font-medium">
            Task{" "}
            <select
              className="ml-2 rounded-md border bg-background px-2 py-1.5 text-sm"
              value={pickedTaskId}
              onChange={(e) => setPickedTaskId(e.target.value)}
            >
              {scorableTasks.map((t) => (
                <option key={t.task_id} value={t.task_id}>
                  {t.name} — {formatTaskDate(t.task_date)}
                </option>
              ))}
            </select>
          </label>
          <ScoresSection
            key={pickedTaskId}
            compId={compId}
            taskId={pickedTaskId}
            refresh={0}
            timezone={timezone}
            onReplayAvailable={() => {}}
            embedded
          />
        </TabsContent>
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
}

interface CellSpec {
  /** Value used for ordering; "" always sorts to the bottom of score columns. */
  sort: string;
  node: React.ReactNode;
}

function SortableTable({ columns, rows }: { columns: ColumnSpec[]; rows: CellSpec[][] }) {
  const [sort, setSort] = useState<{ col: number; dir: "asc" | "desc" } | null>(null);

  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    const { col, dir } = sort;
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
        return dir === "asc" ? cmp : -cmp;
      })
      .map(({ row }) => row);
  }, [rows, sort]);

  function handleHeaderClick(col: number) {
    setSort((prev) => {
      if (prev?.col === col) return { col, dir: prev.dir === "asc" ? "desc" : "asc" };
      const values = rows.map((row) => row[col]?.sort ?? "");
      const numeric = values.every((v) => v === "" || !Number.isNaN(Number(v)));
      return { col, dir: columns[col].defaultDir ?? (numeric ? "desc" : "asc") };
    });
  }

  return (
    <div className="mt-3 overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((col, i) => (
              <TableHead
                key={i}
                title={col.title}
                aria-sort={
                  sort?.col === i ? (sort.dir === "asc" ? "ascending" : "descending") : undefined
                }
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="-ml-2"
                  onClick={() => handleHeaderClick(i)}
                >
                  {col.label}
                  {sort?.col === i ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
                </Button>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortedRows.map((row, i) => (
            <TableRow key={i}>
              {row.map((cell, j) => (
                <TableCell key={j}>{cell.node}</TableCell>
              ))}
            </TableRow>
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
    { label: "#", defaultDir: "asc" },
    { label: "Pilot", defaultDir: "asc" },
    ...classTasks.map((t) => ({ label: t.task_name, title: t.task_date, defaultDir: "desc" as const })),
    { label: "Total", defaultDir: "desc" },
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
          <Link
            to={scoreDetailHref(scores.comp_id, task.task_id, p.comp_pilot_id)}
            title={`How ${p.pilot_name}'s score for ${task.task_name} was calculated`}
            className="underline underline-offset-4"
          >
            {formatScore(entry.score)}{" "}
            <span className="text-muted-foreground">({ordinal(entry.rank)})</span>
          </Link>
        ),
      };
    }),
    { sort: String(p.total_score), node: <strong>{formatScore(p.total_score)}</strong> },
  ]);

  return <SortableTable columns={columns} rows={rows} />;
}

function Top3Table({
  scores,
  group,
}: {
  scores: CompScores;
  group: ReturnType<typeof buildClassGroups>[number];
}) {
  const rows = computeTop3Rows(group, scores.tasks);

  const columns: ColumnSpec[] = [
    { label: "Task", defaultDir: "asc" },
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
            <Link
              to={scoreDetailHref(scores.comp_id, row.task_id, entry.comp_pilot_id)}
              title={`How ${entry.pilot_name}'s score for ${row.label} was calculated`}
              className="underline underline-offset-4"
            >
              {content}
            </Link>
          ) : (
            content
          ),
        };
      }),
    ];
  });

  return <SortableTable columns={columns} rows={tableRows} />;
}

function TeamsTable({
  scores,
  teams,
}: {
  scores: CompScores;
  teams: ReturnType<typeof aggregateTeams>;
}) {
  const columns: ColumnSpec[] = [
    { label: "#", defaultDir: "asc" },
    { label: "Team", defaultDir: "asc" },
    ...scores.tasks.map((t) => ({ label: t.task_name, title: t.task_date, defaultDir: "desc" as const })),
    { label: "Total", defaultDir: "desc" },
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

  return <SortableTable columns={columns} rows={rows} />;
}
