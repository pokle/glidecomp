import { initNav } from "./nav";

// ── Types ─────────────────────────────────────────────────────────────────────

interface CompInfo {
  comp_id: string;
  name: string;
}

interface TaskInfo {
  task_id: string;
  task_name: string;
  task_date: string;
}

interface PilotStanding {
  pilot_name: string;
  comp_pilot_id: string;
  rank: number;
  total_score: number;
  tasks: Array<{ task_id: string; task_date: string; score: number; rank: number }>;
}

interface ClassStanding {
  pilot_class: string;
  pilots: PilotStanding[];
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

// ── Render ────────────────────────────────────────────────────────────────────

function renderScoresPage(comp: CompInfo, scores: CompScores) {
  document.title = `GlideComp - ${comp.name} Scores`;
  document.getElementById("scores-comp-title")!.textContent = `${comp.name} — Scores`;

  const backLink = document.getElementById("scores-back-link") as HTMLAnchorElement;
  backLink.href = `/comp/${scores.comp_id}`;
  document.getElementById("scores-back-comp-name")!.textContent = comp.name;

  const tabsContainer = document.getElementById("scores-class-tabs")!;
  const panelsContainer = document.getElementById("scores-panels")!;
  const multiClass = scores.standings.length > 1;

  for (const cls of scores.standings) {
    // Panel
    const panel = document.createElement("div");
    panel.className = "class-panel";
    panel.dataset.class = cls.pilot_class;

    if (multiClass) {
      const h2 = document.createElement("h2");
      h2.className = "text-base font-semibold mb-3";
      h2.textContent = cls.pilot_class;
      panel.appendChild(h2);
    }

    // Standings table
    const table = document.createElement("table");
    table.className = "w-full text-sm border-collapse";

    // thead
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    headerRow.className = "text-left text-xs text-muted-foreground border-b border-border/50";

    const headers = ["#", "Pilot", ...scores.tasks.map((t) => t.task_name), "Total"];
    for (let i = 0; i < headers.length; i++) {
      const th = document.createElement("th");
      th.className = "py-1.5 pr-3 font-medium";
      th.textContent = headers[i];
      // Add task date as title tooltip for task columns
      if (i >= 2 && i < headers.length - 1) {
        th.title = scores.tasks[i - 2].task_date;
      }
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // tbody
    const tbody = document.createElement("tbody");
    for (let i = 0; i < cls.pilots.length; i++) {
      const p = cls.pilots[i];
      const tr = document.createElement("tr");
      tr.className = i % 2 === 1 ? "bg-muted/30" : "";

      // Rank
      const rankTd = document.createElement("td");
      rankTd.className = "py-1.5 pr-3";
      rankTd.textContent = String(p.rank);
      tr.appendChild(rankTd);

      // Pilot name
      const nameTd = document.createElement("td");
      nameTd.className = "py-1.5 pr-3";
      nameTd.textContent = p.pilot_name;
      tr.appendChild(nameTd);

      // Per-task score columns
      for (const task of scores.tasks) {
        const td = document.createElement("td");
        td.className = "py-1.5 pr-3";
        const entry = p.tasks.find((t) => t.task_id === task.task_id);
        if (entry) {
          td.innerHTML = `${Math.round(entry.score)} <span class="text-muted-foreground text-xs">(${ordinal(entry.rank)})</span>`;
        } else {
          td.innerHTML = `<span class="text-muted-foreground">—</span>`;
        }
        tr.appendChild(td);
      }

      // Total
      const totalTd = document.createElement("td");
      totalTd.className = "py-1.5 pr-3 font-medium";
      totalTd.textContent = Math.round(p.total_score).toString();
      tr.appendChild(totalTd);

      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    panel.appendChild(table);
    panelsContainer.appendChild(panel);
  }

  // Class tabs (only if multiple classes)
  if (multiClass) {
    tabsContainer.classList.remove("hidden");
    const panels = panelsContainer.querySelectorAll<HTMLElement>(".class-panel");

    for (let i = 0; i < scores.standings.length; i++) {
      const cls = scores.standings[i];
      const btn = document.createElement("button");
      btn.className = i === 0
        ? "btn btn-primary btn-sm text-xs"
        : "btn btn-secondary btn-sm text-xs";
      btn.textContent = cls.pilot_class;
      btn.addEventListener("click", () => {
        // Update button styles
        tabsContainer.querySelectorAll("button").forEach((b, j) => {
          b.className = j === i
            ? "btn btn-primary btn-sm text-xs"
            : "btn btn-secondary btn-sm text-xs";
        });
        // Show/hide panels
        panels.forEach((panel, j) => {
          panel.classList.toggle("hidden", j !== i);
        });
      });
      tabsContainer.appendChild(btn);
    }

    // Hide all panels except first
    panels.forEach((panel, i) => {
      if (i !== 0) panel.classList.add("hidden");
    });
  }

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
      document.getElementById("scores-comp-title")!.textContent = `${comp.name} — Scores`;
      const backLink = document.getElementById("scores-back-link") as HTMLAnchorElement;
      backLink.href = `/comp/${scores.comp_id}`;
      document.getElementById("scores-back-comp-name")!.textContent = comp.name;
      document.getElementById("scores-panels")!.innerHTML = `<p class="text-sm text-muted-foreground">No scored tasks yet.</p>`;
      return;
    }

    renderScoresPage(comp, scores);
  } catch {
    showNotFound();
  }
}

init();
