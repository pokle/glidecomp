/**
 * Competition scores — React port of scores.ts. View transforms (class
 * rollups, top-3, teams) are reused from the shared scores-views module.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Tabs } from "@base-ui/react/tabs";
import {
  aggregateTeams,
  buildClassGroups,
  computeTop3Rows,
  type ClassStanding,
  type TaskInfo,
} from "../../scores-views";
import { formatScore, ordinal } from "../lib/format";

interface CompInfo {
  comp_id: string;
  name: string;
  category: "hg" | "pg";
  scoring_format: "gap" | "open_distance";
  pilot_count?: number;
}

interface CompScores {
  comp_id: string;
  tasks: TaskInfo[];
  standings: ClassStanding[];
}

function analysisHref(compId: string, taskId: string, pilotId: string): string {
  return `/analysis.html?compId=${encodeURIComponent(compId)}&taskId=${encodeURIComponent(taskId)}&pilotId=${encodeURIComponent(pilotId)}`;
}

export function Scores() {
  const [searchParams] = useSearchParams();
  const compId = searchParams.get("comp_id");
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "not-found" }
    | { kind: "ready"; comp: CompInfo; scores: CompScores }
  >({ kind: "loading" });

  useEffect(() => {
    if (!compId) {
      setState({ kind: "not-found" });
      return;
    }
    (async () => {
      try {
        const [compRes, scoresRes] = await Promise.all([
          fetch(`/api/comp/${encodeURIComponent(compId)}`, { credentials: "include" }),
          fetch(`/api/comp/${encodeURIComponent(compId)}/scores`, { credentials: "include" }),
        ]);
        if (!compRes.ok || !scoresRes.ok) {
          setState({ kind: "not-found" });
          return;
        }
        const comp = (await compRes.json()) as CompInfo;
        const scores = (await scoresRes.json()) as CompScores;
        document.title = `GlideComp - ${comp.name} Scores`;
        setState({ kind: "ready", comp, scores });
      } catch {
        setState({ kind: "not-found" });
      }
    })();
  }, [compId]);

  if (state.kind === "loading") return <p role="status">Loading scores…</p>;
  if (state.kind === "not-found") {
    return (
      <section>
        <p>Competition not found</p>
        <Link to="/comp">Back to Competitions</Link>
      </section>
    );
  }

  const { comp, scores } = state;
  const facts = [
    comp.category === "hg" ? "Hang gliding" : "Paragliding",
    comp.scoring_format === "open_distance" ? "Open distance" : "GAP",
    ...(typeof comp.pilot_count === "number" ? [`${comp.pilot_count} pilots`] : []),
  ];

  return (
    <section>
      <nav>
        <Link to="/comp">Competitions</Link> › <Link to={`/comp/${comp.comp_id}`}>{comp.name}</Link>
      </nav>
      <h1>{comp.name} — Scores</h1>
      <p>{facts.join(" · ")}</p>

      {scores.standings.length === 0 ? (
        <p>No scored tasks yet.</p>
      ) : (
        <ScoresViews scores={scores} />
      )}
    </section>
  );
}

function ScoresViews({ scores }: { scores: CompScores }) {
  const teams = useMemo(() => aggregateTeams(scores.standings), [scores]);
  const groups = useMemo(() => buildClassGroups(scores.standings), [scores]);
  const firstTab = `standings:${scores.standings[0].pilot_class}`;
  const [tab, setTab] = useState(firstTab);

  return (
    <Tabs.Root value={tab} onValueChange={(value) => setTab(value as string)}>
      <Tabs.List>
        {scores.standings.map((cls) => (
          <Tabs.Tab key={cls.pilot_class} value={`standings:${cls.pilot_class}`}>
            {cls.pilot_class}
          </Tabs.Tab>
        ))}
        <Tabs.Tab value="top3">Top 3 per task &amp; class</Tabs.Tab>
        {teams.length > 0 ? <Tabs.Tab value="teams">Teams</Tabs.Tab> : null}
      </Tabs.List>

      {scores.standings.map((cls) => (
        <Tabs.Panel key={cls.pilot_class} value={`standings:${cls.pilot_class}`}>
          <StandingsTable scores={scores} cls={cls} />
        </Tabs.Panel>
      ))}

      <Tabs.Panel value="top3">
        {groups.map((group) => (
          <section key={group.label}>
            <h2>{group.label}</h2>
            {group.classes.length > 1 ? <p>Combined: {group.classes.join(", ")}</p> : null}
            <Top3Table scores={scores} group={group} />
          </section>
        ))}
      </Tabs.Panel>

      {teams.length > 0 ? (
        <Tabs.Panel value="teams">
          <TeamsTable scores={scores} teams={teams} />
        </Tabs.Panel>
      ) : null}
    </Tabs.Root>
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
    <table>
      <thead>
        <tr>
          {columns.map((col, i) => (
            <th
              key={i}
              title={col.title}
              aria-sort={
                sort?.col === i ? (sort.dir === "asc" ? "ascending" : "descending") : undefined
              }
            >
              <button type="button" onClick={() => handleHeaderClick(i)}>
                {col.label}
                {sort?.col === i ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
              </button>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sortedRows.map((row, i) => (
          <tr key={i}>
            {row.map((cell, j) => (
              <td key={j}>{cell.node}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
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
          <a
            href={analysisHref(scores.comp_id, task.task_id, p.comp_pilot_id)}
            target="_blank"
            rel="noopener"
            title={`Analyse ${p.pilot_name}'s track for ${task.task_name}`}
          >
            {formatScore(entry.score)} <span>({ordinal(entry.rank)})</span>
          </a>
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
            <a
              href={analysisHref(scores.comp_id, row.task_id, entry.comp_pilot_id)}
              target="_blank"
              rel="noopener"
              title={`Analyse ${entry.pilot_name}'s track for ${row.label}`}
            >
              {content}
            </a>
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
          <div>{team.pilots.join(", ")}</div>
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
