import './theme';
import { initNav } from "./nav";
import {
  aggregateTeams,
  buildClassGroups,
  computeTop3Rows,
  tasksForGroup,
  type ClassStanding,
  type TaskInfo,
} from "./scores-views";

// ── Types ─────────────────────────────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

function analysisHref(compId: string, taskId: string, pilotId: string): string {
  return `/analysis.html?compId=${encodeURIComponent(compId)}&taskId=${encodeURIComponent(taskId)}&pilotId=${encodeURIComponent(pilotId)}`;
}

/** Round and add thousands separators: 225033.4 → "225,033". */
function formatScore(score: number): string {
  return Math.round(score).toLocaleString("en-US");
}

// ── Sortable tables ───────────────────────────────────────────────────────────

/** Reapply zebra striping after rows are reordered. */
function restripe(tbody: HTMLTableSectionElement) {
  Array.from(tbody.rows).forEach((row, i) => {
    row.classList.toggle("bg-muted/30", i % 2 === 1);
  });
}

/**
 * Make every column header clickable to sort the table. Cells sort by their
 * `data-sort` attribute when present, falling back to text content. A header
 * may set `data-default-dir` ("asc"/"desc") for its first-click direction —
 * score columns default to descending, names and ranks to ascending.
 */
function makeSortable(table: HTMLTableElement) {
  const headers = Array.from(table.querySelectorAll<HTMLTableCellElement>("thead th"));
  for (const th of headers) {
    th.classList.add("cursor-pointer", "select-none");
    const indicator = document.createElement("span");
    indicator.className = "sort-indicator";
    indicator.setAttribute("aria-hidden", "true");
    th.appendChild(indicator);
  }

  headers.forEach((th, col) => {
    th.addEventListener("click", () => {
      const tbody = table.tBodies[0];
      if (!tbody) return;
      const rows = Array.from(tbody.rows);
      const values = rows.map(
        (row) => row.cells[col]?.dataset.sort ?? row.cells[col]?.textContent?.trim() ?? ""
      );
      const numeric = values.every((v) => v === "" || !Number.isNaN(Number(v)));

      const dir =
        th.dataset.dir === "asc" || th.dataset.dir === "desc"
          ? th.dataset.dir === "asc"
            ? "desc"
            : "asc"
          : th.dataset.defaultDir ?? (numeric ? "desc" : "asc");

      for (const h of headers) {
        delete h.dataset.dir;
        h.querySelector(".sort-indicator")!.textContent = "";
      }
      th.dataset.dir = dir;
      th.querySelector(".sort-indicator")!.textContent = dir === "asc" ? " ▲" : " ▼";

      rows
        .map((row, i) => ({ row, value: values[i] }))
        .sort((a, b) => {
          let cmp: number;
          if (numeric) {
            // Empty cells ("—") always sort to the bottom of a score column
            const av = a.value === "" ? -Infinity : Number(a.value);
            const bv = b.value === "" ? -Infinity : Number(b.value);
            cmp = av - bv;
          } else {
            cmp = a.value.localeCompare(b.value);
          }
          return dir === "asc" ? cmp : -cmp;
        })
        .forEach(({ row }) => tbody.appendChild(row));

      restripe(tbody);
    });
  });
}

// ── Table building ────────────────────────────────────────────────────────────

interface ColumnSpec {
  label: string;
  title?: string;
  /** First-click sort direction; scores read best-first when descending. */
  defaultDir?: "asc" | "desc";
  /** Right-align numeric columns so digits line up. */
  align?: "right";
}

function createTable(columns: ColumnSpec[]): { table: HTMLTableElement; tbody: HTMLTableSectionElement } {
  const table = document.createElement("table");
  table.className = "w-full text-sm border-collapse";

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  headerRow.className = "text-left text-xs text-muted-foreground border-b border-border/50";
  for (const col of columns) {
    const th = document.createElement("th");
    th.className = `py-1.5 pr-3 font-medium${col.align === "right" ? " text-right" : ""}`;
    th.textContent = col.label;
    if (col.title) th.title = col.title;
    if (col.defaultDir) th.dataset.defaultDir = col.defaultDir;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  table.appendChild(tbody);
  makeSortable(table);
  return { table, tbody };
}

function addCell(tr: HTMLTableRowElement, className = "py-1.5 pr-3"): HTMLTableCellElement {
  const td = document.createElement("td");
  td.className = className;
  tr.appendChild(td);
  return td;
}

/** A panel holding one table; every panel after the first starts a new
 * printed page. */
function createPanel(
  container: HTMLElement,
  panelClass: string,
  heading: string | null
): HTMLDivElement {
  const panel = document.createElement("div");
  const pageBreak = container.childElementCount > 0 ? " print:break-before-page" : "";
  panel.className = `${panelClass}${pageBreak}`;

  if (heading) {
    const h2 = document.createElement("h2");
    h2.className = "text-base font-semibold mb-3";
    h2.textContent = heading;
    panel.appendChild(h2);
  }
  container.appendChild(panel);
  return panel;
}

// ── Standings view (one table per pilot class) ────────────────────────────────

function renderStandings(scores: CompScores, container: HTMLElement) {
  const multiClass = scores.standings.length > 1;

  for (const cls of scores.standings) {
    // Only show columns for tasks flown by this pilot class — classes fly
    // different tasks, so mixing them would leave every off-class cell blank.
    const classTasks = scores.tasks.filter((t) => t.classes.includes(cls.pilot_class));

    const panel = createPanel(container, "class-panel", multiClass ? cls.pilot_class : null);
    panel.dataset.class = cls.pilot_class;

    const { table, tbody } = createTable([
      { label: "#", defaultDir: "asc" },
      { label: "Pilot", defaultDir: "asc" },
      ...classTasks.map((t) => ({
        label: t.task_name,
        title: t.task_date,
        defaultDir: "desc" as const,
        align: "right" as const,
      })),
      { label: "Total", defaultDir: "desc", align: "right" },
    ]);

    for (let i = 0; i < cls.pilots.length; i++) {
      const p = cls.pilots[i];
      const tr = document.createElement("tr");
      tr.className = i % 2 === 1 ? "bg-muted/30" : "";

      addCell(tr).textContent = String(p.rank);
      addCell(tr).textContent = p.pilot_name;

      // Per-task score columns — each score links to the analysis page for
      // that pilot's track on that task
      for (const task of classTasks) {
        const td = addCell(tr, "py-1.5 pr-3 text-right");
        const entry = p.tasks.find((t) => t.task_id === task.task_id);
        if (entry) {
          td.dataset.sort = String(entry.score);
          const link = document.createElement("a");
          link.href = analysisHref(scores.comp_id, task.task_id, p.comp_pilot_id);
          link.target = "_blank";
          link.rel = "noopener";
          link.className = "hover:underline";
          link.title = `Analyse ${p.pilot_name}'s track for ${task.task_name}`;
          link.innerHTML = `${formatScore(entry.score)} <span class="text-muted-foreground text-xs">(${ordinal(entry.rank)})</span>`;
          td.appendChild(link);
        } else {
          td.dataset.sort = "";
          td.innerHTML = `<span class="text-muted-foreground">—</span>`;
        }
      }

      const totalTd = addCell(tr, "py-1.5 pr-3 font-medium text-right");
      totalTd.dataset.sort = String(p.total_score);
      totalTd.textContent = formatScore(p.total_score);

      tbody.appendChild(tr);
    }
    panel.appendChild(table);
  }
}

// ── Top 3 per task & class view ───────────────────────────────────────────────

function renderTop3(scores: CompScores, container: HTMLElement) {
  const groups = buildClassGroups(scores.standings);

  for (const group of groups) {
    const panel = createPanel(container, "top3-panel", group.label);
    if (group.classes.length > 1) {
      const sub = document.createElement("p");
      sub.className = "text-xs text-muted-foreground -mt-2 mb-3";
      sub.textContent = `Combined: ${group.classes.join(", ")}`;
      panel.appendChild(sub);
    }

    const { table, tbody } = createTable([
      { label: "Task", defaultDir: "asc" },
      { label: "1st", defaultDir: "desc" },
      { label: "2nd", defaultDir: "desc" },
      { label: "3rd", defaultDir: "desc" },
    ]);

    const rows = computeTop3Rows(group, scores.tasks);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const isTotal = row.task_id === null;
      const tr = document.createElement("tr");
      tr.className = i % 2 === 1 ? "bg-muted/30" : "";

      const labelTd = addCell(tr, isTotal ? "py-1.5 pr-3 font-medium" : "py-1.5 pr-3");
      labelTd.textContent = row.label;
      if (row.task_date) labelTd.title = row.task_date;

      for (let place = 0; place < 3; place++) {
        const entry = row.entries[place];
        const td = addCell(tr);
        if (!entry) {
          td.dataset.sort = "";
          td.innerHTML = `<span class="text-muted-foreground">—</span>`;
          continue;
        }
        td.dataset.sort = String(entry.score);
        const dot = document.createElement("span");
        dot.className = "text-muted-foreground";
        dot.textContent = " · ";
        const scoreSpan = document.createElement("span");
        if (isTotal) scoreSpan.className = "font-medium";
        scoreSpan.textContent = formatScore(entry.score);

        if (row.task_id) {
          const link = document.createElement("a");
          link.href = analysisHref(scores.comp_id, row.task_id, entry.comp_pilot_id);
          link.target = "_blank";
          link.rel = "noopener";
          link.className = "hover:underline";
          link.title = `Analyse ${entry.pilot_name}'s track for ${row.label}`;
          link.appendChild(document.createTextNode(entry.pilot_name));
          link.appendChild(dot);
          link.appendChild(scoreSpan);
          td.appendChild(link);
        } else {
          td.appendChild(document.createTextNode(entry.pilot_name));
          td.appendChild(dot);
          td.appendChild(scoreSpan);
        }
      }
      tbody.appendChild(tr);
    }
    panel.appendChild(table);
  }
}

// ── Teams view ────────────────────────────────────────────────────────────────

function renderTeams(scores: CompScores, container: HTMLElement): boolean {
  const teams = aggregateTeams(scores.standings);
  if (teams.length === 0) return false;

  const panel = createPanel(container, "teams-panel", "Teams");

  const { table, tbody } = createTable([
    { label: "#", defaultDir: "asc" },
    { label: "Team", defaultDir: "asc" },
    ...scores.tasks.map((t) => ({
      label: t.task_name,
      title: t.task_date,
      defaultDir: "desc" as const,
      align: "right" as const,
    })),
    { label: "Total", defaultDir: "desc", align: "right" },
  ]);

  for (let i = 0; i < teams.length; i++) {
    const team = teams[i];
    const tr = document.createElement("tr");
    tr.className = i % 2 === 1 ? "bg-muted/30" : "";

    addCell(tr, "py-1.5 pr-3 align-top").textContent = String(team.rank);

    // Team name with its members listed underneath
    const teamTd = addCell(tr, "py-1.5 pr-3 align-top");
    teamTd.dataset.sort = team.team_name;
    const nameDiv = document.createElement("div");
    nameDiv.className = "font-medium";
    nameDiv.textContent = team.team_name;
    const membersDiv = document.createElement("div");
    membersDiv.className = "text-xs text-muted-foreground";
    membersDiv.textContent = team.pilots.join(", ");
    teamTd.appendChild(nameDiv);
    teamTd.appendChild(membersDiv);

    for (const task of scores.tasks) {
      const td = addCell(tr, "py-1.5 pr-3 text-right align-top");
      const score = team.task_scores[task.task_id];
      if (score !== undefined) {
        td.dataset.sort = String(score);
        td.textContent = formatScore(score);
      } else {
        td.dataset.sort = "";
        td.innerHTML = `<span class="text-muted-foreground">—</span>`;
      }
    }

    const totalTd = addCell(tr, "py-1.5 pr-3 font-medium text-right align-top");
    totalTd.dataset.sort = String(team.total_score);
    totalTd.textContent = formatScore(team.total_score);

    tbody.appendChild(tr);
  }
  panel.appendChild(table);
  return true;
}

// ── View switching ────────────────────────────────────────────────────────────

interface Tab {
  label: string;
  select: () => void;
}

function setupTabs(scores: CompScores, hasTeams: boolean) {
  const tabsContainer = document.getElementById("scores-class-tabs")!;
  const standingsContainer = document.getElementById("scores-panels")!;
  const top3Container = document.getElementById("scores-top3")!;
  const teamsContainer = document.getElementById("scores-teams")!;
  const classPanels = Array.from(
    standingsContainer.querySelectorAll<HTMLElement>(".class-panel")
  );

  const showView = (view: "standings" | "top3" | "teams", activeClass?: string) => {
    standingsContainer.classList.toggle("hidden", view !== "standings");
    top3Container.classList.toggle("hidden", view !== "top3");
    teamsContainer.classList.toggle("hidden", view !== "teams");
    if (view === "standings") {
      for (const panel of classPanels) {
        // not-print:hidden (not plain hidden) so printing the standings view
        // includes every class table, each on its own page
        panel.classList.toggle("not-print:hidden", panel.dataset.class !== activeClass);
      }
    }
  };

  const tabs: Tab[] = [
    ...scores.standings.map((cls) => ({
      label: cls.pilot_class,
      select: () => showView("standings", cls.pilot_class),
    })),
    { label: "Top 3 per task & class", select: () => showView("top3") },
    ...(hasTeams ? [{ label: "Teams", select: () => showView("teams") }] : []),
  ];

  const buttons = tabs.map((tab, i) => {
    const btn = document.createElement("button");
    btn.textContent = tab.label;
    btn.addEventListener("click", () => {
      buttons.forEach((b, j) => {
        b.className = j === i
          ? "btn btn-primary btn-sm text-xs"
          : "btn btn-secondary btn-sm text-xs";
      });
      tab.select();
    });
    tabsContainer.appendChild(btn);
    return btn;
  });

  tabsContainer.classList.remove("hidden");
  buttons[0].className = "btn btn-primary btn-sm text-xs";
  buttons.slice(1).forEach((b) => (b.className = "btn btn-secondary btn-sm text-xs"));
  tabs[0].select();
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderHeader(comp: CompInfo, compId: string) {
  document.title = `GlideComp - ${comp.name} Scores`;
  document.getElementById("scores-comp-title")!.textContent = `${comp.name} — Scores`;

  const facts = [
    comp.category === "hg" ? "Hang gliding" : "Paragliding",
    comp.scoring_format === "open_distance" ? "Open distance" : "GAP",
  ];
  if (typeof comp.pilot_count === "number") facts.push(`${comp.pilot_count} pilots`);
  document.getElementById("scores-comp-info")!.textContent = facts.join(" · ");

  const backLink = document.getElementById("scores-back-link") as HTMLAnchorElement;
  backLink.href = `/comp/${compId}`;
  document.getElementById("scores-back-comp-name")!.textContent = comp.name;
}

function renderScoresPage(comp: CompInfo, scores: CompScores) {
  renderHeader(comp, scores.comp_id);

  renderStandings(scores, document.getElementById("scores-panels")!);
  renderTop3(scores, document.getElementById("scores-top3")!);
  const hasTeams = renderTeams(scores, document.getElementById("scores-teams")!);

  setupTabs(scores, hasTeams);

  document.getElementById("scores-loading")!.classList.add("hidden");
  document.getElementById("scores-content")!.classList.remove("hidden");
}

function showNotFound() {
  document.getElementById("scores-loading")!.classList.add("hidden");
  document.getElementById("scores-not-found")!.classList.remove("hidden");
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  const page = document.getElementById("scores-page")!;
  page.classList.remove("hidden");

  await initNav({ active: "competitions" });

  // initNav replaces the placeholder divs, so print styling goes on the
  // rendered elements: score tables print without the app chrome
  document.querySelector("header")?.classList.add("print:hidden");
  document.querySelector("footer")?.classList.add("print:hidden");

  const compId = new URLSearchParams(window.location.search).get("comp_id");
  if (!compId) {
    showNotFound();
    return;
  }

  try {
    const [compRes, scoresRes] = await Promise.all([
      fetch(`/api/comp/${encodeURIComponent(compId)}`, { credentials: "include" }),
      fetch(`/api/comp/${encodeURIComponent(compId)}/scores`, { credentials: "include" }),
    ]);

    if (!compRes.ok || !scoresRes.ok) {
      showNotFound();
      return;
    }

    const comp = (await compRes.json()) as CompInfo;
    const scores = (await scoresRes.json()) as CompScores;

    if (!scores.standings || scores.standings.length === 0) {
      document.getElementById("scores-loading")!.classList.add("hidden");
      document.getElementById("scores-content")!.classList.remove("hidden");
      renderHeader(comp, scores.comp_id);
      document.getElementById("scores-panels")!.innerHTML = `<p class="text-sm text-muted-foreground">No scored tasks yet.</p>`;
      return;
    }

    renderScoresPage(comp, scores);
  } catch {
    showNotFound();
  }
}

init();
