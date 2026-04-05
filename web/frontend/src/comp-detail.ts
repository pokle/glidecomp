import { api } from "./comp/api";

function escapeHtml(str: string): string {
  const el = document.createElement("span");
  el.textContent = str;
  return el.innerHTML;
}

function categoryLabel(cat: string): string {
  return cat === "hg" ? "HG" : "PG";
}

function categoryBadge(cat: string): string {
  const cls = cat === "hg"
    ? "bg-amber-500/10 text-amber-500"
    : "bg-sky-500/10 text-sky-500";
  return `<span class="inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium ${cls}">${categoryLabel(cat)}</span>`;
}

async function init() {
  // Extract comp_id from URL: /comp/{comp_id}
  const match = window.location.pathname.match(/^\/comp\/([a-z]+)\/?$/);
  if (!match) {
    showNotFound();
    return;
  }

  const compId = match[1];
  const page = document.getElementById("comp-detail-page")!;
  page.classList.remove("hidden");

  try {
    const res = await api.api.comp[":comp_id"].$get({
      param: { comp_id: compId },
    });

    if (!res.ok) {
      showNotFound();
      return;
    }

    const comp = (await res.json()) as unknown as {
      comp_id: string;
      name: string;
      category: string;
      test: boolean;
      pilot_classes: string[];
      tasks: Array<{
        task_id: string;
        name: string;
        task_date: string;
        has_xctsk: boolean;
        pilot_classes: string[];
      }>;
      admins: Array<{ email: string; name: string }>;
      pilot_count: number;
    };

    document.title = `GlideComp - ${comp.name}`;

    // Populate header
    document.getElementById("comp-title")!.textContent = comp.name;
    document.getElementById("comp-category-badge")!.innerHTML = categoryBadge(comp.category);
    if (comp.test) {
      document.getElementById("comp-test-badge")!.classList.remove("hidden");
    }
    document.getElementById("comp-classes")!.textContent = comp.pilot_classes.join(", ");

    // Tasks
    const tasksList = document.getElementById("tasks-list")!;
    const tasksEmpty = document.getElementById("tasks-empty")!;
    if (comp.tasks.length > 0) {
      tasksEmpty.classList.add("hidden");
      for (const task of comp.tasks) {
        const div = document.createElement("a");
        div.href = `/comp/${compId}/task/${task.task_id}`;
        div.className = "flex items-center justify-between rounded-lg border border-border/50 px-4 py-3 hover:bg-muted/50 transition-colors";
        div.innerHTML = `
          <div class="flex-1 min-w-0">
            <div class="font-medium text-sm">${escapeHtml(task.name)}</div>
            <div class="text-xs text-muted-foreground mt-0.5">${task.task_date} &middot; ${escapeHtml(task.pilot_classes.join(", "))}</div>
          </div>
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-muted-foreground/40 shrink-0">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
        `;
        tasksList.appendChild(div);
      }
    }

    // Admins
    const adminsList = document.getElementById("admins-list")!;
    for (const admin of comp.admins) {
      const div = document.createElement("div");
      div.className = "text-sm text-muted-foreground";
      div.textContent = `${admin.name} (${admin.email})`;
      adminsList.appendChild(div);
    }

    // Show detail, hide loading
    document.getElementById("comp-loading")!.classList.add("hidden");
    document.getElementById("comp-detail")!.classList.remove("hidden");
  } catch {
    showNotFound();
  }
}

function showNotFound() {
  const page = document.getElementById("comp-detail-page")!;
  page.classList.remove("hidden");
  document.getElementById("comp-loading")!.classList.add("hidden");
  document.getElementById("comp-not-found")!.classList.remove("hidden");
}

init();
