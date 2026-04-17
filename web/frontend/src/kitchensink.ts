import "./theme";
import { initNav } from "./nav";

initNav({ active: "flights" });

// ── Helpers ──────────────────────────────────────────────────────────────────

function section(title: string, ...children: HTMLElement[]): HTMLElement {
  const wrapper = document.createElement("section");
  wrapper.className = "space-y-4";
  const h = document.createElement("h2");
  h.className = "text-lg font-semibold border-b border-border pb-2";
  h.textContent = title;
  wrapper.appendChild(h);
  for (const child of children) wrapper.appendChild(child);
  return wrapper;
}

function row(...children: HTMLElement[]): HTMLElement {
  const div = document.createElement("div");
  div.className = "flex flex-wrap items-center gap-3";
  for (const child of children) div.appendChild(child);
  return div;
}

function btn(cls: string, label: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = cls;
  b.textContent = label;
  return b;
}

function label(text: string): HTMLElement {
  const span = document.createElement("span");
  span.className = "text-xs text-muted-foreground w-28 shrink-0";
  span.textContent = text;
  return span;
}

function labelledRow(labelText: string, ...children: HTMLElement[]): HTMLElement {
  const div = document.createElement("div");
  div.className = "flex flex-wrap items-center gap-3";
  div.appendChild(label(labelText));
  for (const child of children) div.appendChild(child);
  return div;
}

// ── Buttons ───────────────────────────────────────────────────────────────────

function buildButtons(): HTMLElement {
  const variants: [string, string][] = [
    ["btn btn-primary",     "Primary"],
    ["btn btn-secondary",   "Secondary"],
    ["btn-outline",         "Outline"],
    ["btn btn-ghost",       "Ghost"],
    ["btn btn-destructive", "Destructive"],
  ];
  const smVariants: [string, string][] = [
    ["btn-sm-primary",     "Primary"],
    ["btn-sm-secondary",   "Secondary"],
    ["btn-sm-outline",     "Outline"],
    ["btn-sm-ghost",       "Ghost"],
    ["btn-sm-destructive", "Destructive"],
  ];
  const lgVariants: [string, string][] = [
    ["btn-lg-primary",     "Primary"],
    ["btn-lg-secondary",   "Secondary"],
    ["btn-lg-outline",     "Outline"],
    ["btn-lg-ghost",       "Ghost"],
    ["btn-lg-destructive", "Destructive"],
  ];

  return section(
    "Buttons",
    labelledRow("Default", ...variants.map(([cls, lbl]) => btn(cls, lbl))),
    labelledRow("Small (btn-sm-*)", ...smVariants.map(([cls, lbl]) => btn(cls, lbl))),
    labelledRow("Large (btn-lg-*)", ...lgVariants.map(([cls, lbl]) => btn(cls, lbl))),
    labelledRow("Disabled", ...variants.map(([cls, lbl]) => {
      const b = btn(cls, lbl);
      b.disabled = true;
      return b;
    })),
  );
}

// ── Inputs ────────────────────────────────────────────────────────────────────

function buildInputs(): HTMLElement {
  const grid = document.createElement("div");
  grid.className = "grid grid-cols-1 sm:grid-cols-2 gap-4";

  function inputGroup(lbl: string, inputEl: HTMLElement): HTMLElement {
    const div = document.createElement("div");
    div.className = "space-y-1";
    const l = document.createElement("label");
    l.className = "text-sm font-medium";
    l.textContent = lbl;
    div.appendChild(l);
    div.appendChild(inputEl);
    return div;
  }

  function makeInput(placeholder: string, cls = "input w-full"): HTMLInputElement {
    const i = document.createElement("input");
    i.type = "text";
    i.className = cls;
    i.placeholder = placeholder;
    return i;
  }

  function makeSelect(): HTMLSelectElement {
    const s = document.createElement("select");
    s.className = "select w-full";
    for (const opt of ["Option A", "Option B", "Option C"]) {
      const o = document.createElement("option");
      o.textContent = opt;
      s.appendChild(o);
    }
    return s;
  }

  function makeTextarea(): HTMLTextAreaElement {
    const t = document.createElement("textarea");
    t.className = "textarea w-full";
    t.rows = 3;
    t.placeholder = "Type something...";
    return t;
  }

  grid.appendChild(inputGroup("Text input", makeInput("Placeholder text")));
  grid.appendChild(inputGroup("Select", makeSelect() as unknown as HTMLElement));
  grid.appendChild(inputGroup("Textarea", makeTextarea()));

  const disabledInput = makeInput("Disabled input");
  disabledInput.disabled = true;
  grid.appendChild(inputGroup("Disabled input", disabledInput));

  return section("Form Inputs", grid);
}

// ── Checkboxes & Radios ───────────────────────────────────────────────────────

function buildChecks(): HTMLElement {
  function checkRow(lbl: string, checked = false): HTMLElement {
    const div = document.createElement("div");
    div.className = "flex items-center gap-2";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "checkbox";
    cb.checked = checked;
    const l = document.createElement("label");
    l.className = "text-sm";
    l.textContent = lbl;
    div.appendChild(cb);
    div.appendChild(l);
    return div;
  }

  function radioRow(lbl: string, name: string, checked = false): HTMLElement {
    const div = document.createElement("div");
    div.className = "flex items-center gap-2";
    const rb = document.createElement("input");
    rb.type = "radio";
    rb.className = "radio";
    rb.name = name;
    rb.checked = checked;
    const l = document.createElement("label");
    l.className = "text-sm";
    l.textContent = lbl;
    div.appendChild(rb);
    div.appendChild(l);
    return div;
  }

  const checksCol = document.createElement("div");
  checksCol.className = "space-y-2";
  checksCol.appendChild(checkRow("Checked", true));
  checksCol.appendChild(checkRow("Unchecked"));
  checksCol.appendChild(checkRow("Disabled checked", true));
  (checksCol.lastElementChild!.querySelector("input") as HTMLInputElement).disabled = true;

  const radiosCol = document.createElement("div");
  radiosCol.className = "space-y-2";
  radiosCol.appendChild(radioRow("Option A", "demo-radio", true));
  radiosCol.appendChild(radioRow("Option B", "demo-radio"));
  radiosCol.appendChild(radioRow("Option C", "demo-radio"));

  const cols = document.createElement("div");
  cols.className = "grid grid-cols-2 gap-8";
  cols.appendChild(checksCol);
  cols.appendChild(radiosCol);

  return section("Checkboxes & Radios", cols);
}

// ── Badges ────────────────────────────────────────────────────────────────────

function buildBadges(): HTMLElement {
  const badges: [string, string][] = [
    ["badge badge-default",     "Default"],
    ["badge badge-secondary",   "Secondary"],
    ["badge badge-outline",     "Outline"],
    ["badge badge-destructive", "Destructive"],
  ];

  return section(
    "Badges",
    row(...badges.map(([cls, lbl]) => {
      const span = document.createElement("span");
      span.className = cls;
      span.textContent = lbl;
      return span;
    })),
  );
}

// ── Alerts ────────────────────────────────────────────────────────────────────

function buildAlerts(): HTMLElement {
  function alert(cls: string, title: string, msg: string): HTMLElement {
    const div = document.createElement("div");
    div.className = `alert ${cls}`;
    const t = document.createElement("h2");
    t.textContent = title;
    const m = document.createElement("section");
    m.textContent = msg;
    div.appendChild(t);
    div.appendChild(m);
    return div;
  }

  return section(
    "Alerts",
    alert("alert-info",        "Info",    "This is an informational message."),
    alert("alert-success",     "Success", "Operation completed successfully."),
    alert("alert-warning",     "Warning", "Proceed with caution."),
    alert("alert-destructive", "Error",   "Something went wrong. Please try again."),
  );
}

// ── Cards ─────────────────────────────────────────────────────────────────────

function buildCards(): HTMLElement {
  const grid = document.createElement("div");
  grid.className = "grid grid-cols-1 sm:grid-cols-2 gap-4";

  function card(title: string, body: string, footer?: HTMLElement): HTMLElement {
    const div = document.createElement("div");
    div.className = "card p-4 space-y-2";
    const h = document.createElement("h3");
    h.className = "font-semibold";
    h.textContent = title;
    const p = document.createElement("p");
    p.className = "text-sm text-muted-foreground";
    p.textContent = body;
    div.appendChild(h);
    div.appendChild(p);
    if (footer) div.appendChild(footer);
    return div;
  }

  const footerRow = row(btn("btn-sm-primary", "Action"), btn("btn-sm-secondary", "Cancel"));

  grid.appendChild(card("Simple Card", "Cards use the --card background and --card-foreground text color."));
  grid.appendChild(card("Card with Actions", "This card has buttons in the footer.", footerRow));

  return section("Cards", grid);
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

function buildTabs(): HTMLElement {
  const tabRow = document.createElement("div");
  tabRow.className = "flex gap-1";
  for (const [lbl, active] of [["Active Tab", true], ["Inactive", false], ["Another", false]] as [string, boolean][]) {
    const b = document.createElement("button");
    b.className = active ? "tab-btn tab-btn-active" : "tab-btn";
    b.textContent = lbl;
    tabRow.appendChild(b);
  }
  return section("Tabs", tabRow);
}

// ── Table ─────────────────────────────────────────────────────────────────────

function buildTable(): HTMLElement {
  const table = document.createElement("table");
  table.className = "w-full text-sm";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  headRow.className = "border-b border-border";
  for (const h of ["Pilot", "Distance", "Score", "Status"]) {
    const th = document.createElement("th");
    th.className = "text-left py-2 px-2 font-semibold";
    th.textContent = h;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const [name, dist, score, status] of [
    ["Alice", "142.3 km", "985", "Landed"],
    ["Bob", "138.7 km", "961", "DNF"],
    ["Carol", "135.1 km", "943", "Landed"],
  ]) {
    const tr = document.createElement("tr");
    tr.className = "border-b border-border/50";
    for (const val of [name, dist, score, status]) {
      const td = document.createElement("td");
      td.className = "py-2 px-2";
      td.textContent = val;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  return section("Table", table);
}

// ── Dialogs (confirmation pattern) ───────────────────────────────────────────

function buildDialogTrigger(): HTMLElement {
  const demo = document.createElement("div");
  demo.className = "flex items-center gap-4";

  const triggerBtn = btn("btn btn-destructive", "Delete something");
  const status = document.createElement("span");
  status.className = "text-sm text-muted-foreground";
  status.textContent = "(no action yet)";

  triggerBtn.addEventListener("click", () => {
    if (confirm("Are you sure you want to delete this item? This cannot be undone.")) {
      status.textContent = "Confirmed delete";
      status.className = "text-sm text-destructive";
    } else {
      status.textContent = "Cancelled";
      status.className = "text-sm text-muted-foreground";
    }
  });

  demo.appendChild(triggerBtn);
  demo.appendChild(status);
  return section("Destructive Action Pattern", demo);
}

// ── Typography ────────────────────────────────────────────────────────────────

function buildTypography(): HTMLElement {
  const block = document.createElement("div");
  block.className = "space-y-3";

  const sizes: [string, string, string][] = [
    ["text-3xl font-bold", "3xl / Heading", "Competition Results"],
    ["text-2xl font-bold", "2xl / Page title", "Corryong Cup 2026"],
    ["text-xl font-semibold", "xl / Section", "Task 1 — Race to Goal"],
    ["text-base", "base / Body", "The task covers 142 km across the Alps with 3 turnpoints."],
    ["text-sm", "sm / Secondary", "Submitted 14 minutes ago by Alice"],
    ["text-xs text-muted-foreground", "xs / Caption", "GPS fix · 2026-04-12 08:42 UTC"],
  ];

  for (const [cls, lbl, text] of sizes) {
    const row = document.createElement("div");
    row.className = "flex items-baseline gap-4";
    const labelEl = document.createElement("span");
    labelEl.className = "text-xs text-muted-foreground w-40 shrink-0";
    labelEl.textContent = lbl;
    const sample = document.createElement("span");
    sample.className = cls;
    sample.textContent = text;
    row.appendChild(labelEl);
    row.appendChild(sample);
    block.appendChild(row);
  }

  return section("Typography", block);
}

// ── File Cards ────────────────────────────────────────────────────────────────

function buildFileCards(): HTMLElement {
  function fileCard(type: "track" | "task", name: string, meta: string, time: string): HTMLElement {
    const a = document.createElement("a");
    a.href = "#";
    a.className = `file-card file-card-${type}`;
    a.innerHTML = `
      <div class="flex-1 min-w-0">
        <div class="font-medium text-sm text-foreground truncate">${name}</div>
        <div class="text-xs text-muted-foreground truncate">${meta}</div>
      </div>
      <span class="text-xs text-muted-foreground/60 shrink-0">${time}</span>`;
    return a;
  }

  const list = document.createElement("div");
  list.className = "space-y-1";
  list.appendChild(fileCard("track", "Alice Smith — 2026-04-05", "alice_050426.igc", "2h ago"));
  list.appendChild(fileCard("track", "Bob Jones — 2026-04-05", "bob_050426.igc", "3h ago"));
  list.appendChild(fileCard("task", "Task 1 — Race to Goal", "task1.xctsk", "1d ago"));
  list.appendChild(fileCard("task", "Task 2 — Elapsed Time", "task2.xctsk", "2d ago"));

  return section("File Cards (track = primary border, task = ring border)", list);
}

// ── Render ────────────────────────────────────────────────────────────────────

const root = document.getElementById("kitchensink-root")!;
root.className = "space-y-12";

for (const s of [
  buildButtons(),
  buildInputs(),
  buildChecks(),
  buildBadges(),
  buildAlerts(),
  buildCards(),
  buildTabs(),
  buildTable(),
  buildDialogTrigger(),
  buildFileCards(),
  buildTypography(),
]) {
  root.appendChild(s);
}
