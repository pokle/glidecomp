import './theme';
import { initNav } from "./nav";
import type { AuthUser } from "./auth/client";
import { api } from "./comp/api";
import { setupPilotsSection } from "./comp/pilots-section";
import type { XCTask } from "@glidecomp/engine";

// ── Types ────────────────────────────────────────────────────────────────────

interface PilotStatusConfig {
  key: string;
  label: string;
  on_track_upload: "none" | "clear" | "set";
}

interface CompDetail {
  comp_id: string;
  name: string;
  category: string;
  creation_date: string;
  close_date: string | null;
  test: boolean;
  pilot_classes: string[];
  default_pilot_class: string;
  gap_params: unknown;
  open_igc_upload: boolean;
  pilot_statuses: PilotStatusConfig[];
  tasks: TaskSummary[];
  admins: Array<{ email: string; name: string }>;
  pilot_count: number;
  class_coverage_warnings: Array<{
    date: string;
    missing_classes?: string[];
    inconsistent_groupings?: boolean;
  }>;
}

interface TaskSummary {
  task_id: string;
  name: string;
  task_date: string;
  has_xctsk: boolean;
  pilot_classes: string[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  const el = document.createElement("span");
  el.textContent = str;
  return el.innerHTML;
}

function categoryLabel(cat: string): string {
  return cat === "hg" ? "HG" : "PG";
}

function categoryBadge(cat: string): string {
  const cls =
    cat === "hg"
      ? "bg-amber-500/10 text-amber-500"
      : "bg-sky-500/10 text-sky-500";
  return `<span class="inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium ${cls}">${categoryLabel(cat)}</span>`;
}

// ── Types for task detail ────────────────────────────────────────────────────

interface TaskDetail {
  task_id: string;
  comp_id: string;
  name: string;
  task_date: string;
  creation_date: string;
  xctsk: unknown;
  pilot_classes: string[];
  track_count: number;
}

// ── Types for scoring ────────────────────────────────────────────────────────

interface PilotScoreEntry {
  rank: number;
  comp_pilot_id: string;
  pilot_name: string;
  made_goal: boolean;
  reached_ess: boolean;
  flown_distance: number;
  speed_section_time: number | null;
  distance_points: number;
  time_points: number;
  leading_points: number;
  arrival_points: number;
  penalty_points: number;
  penalty_reason: string | null;
  total_score: number;
}

interface ClassScore {
  pilot_class: string;
  task_validity: { launch: number; distance: number; time: number; task: number };
  available_points: { distance: number; time: number; leading: number; arrival: number; total: number };
  pilots: PilotScoreEntry[];
}

interface TaskScoreData {
  task_id: string;
  comp_id: string;
  task_date: string;
  classes: ClassScore[];
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function init() {
  // Route: /comp/{comp_id} or /comp/{comp_id}/task/{task_id}
  const taskMatch = window.location.pathname.match(
    /^\/comp\/([a-z]+)\/task\/([a-z]+)\/?$/
  );
  const compMatch = window.location.pathname.match(/^\/comp\/([a-z]+)\/?$/);

  if (!taskMatch && !compMatch) {
    showNotFound();
    return;
  }

  const compId = (taskMatch ?? compMatch)![1];
  const taskId = taskMatch?.[2] ?? null;
  const page = document.getElementById("comp-detail-page")!;
  page.classList.remove("hidden");

  const user = await initNav({ active: "competitions" });

  if (taskId) {
    await initTaskDetail(compId, taskId, user);
  } else {
    await initCompDetail(compId, user);
  }
}

// ── Task detail view ─────────────────────────────────────────────────────────

async function initTaskDetail(compId: string, taskId: string, user: AuthUser | null) {

  let task: TaskDetail;
  let comp: CompDetail | null = null;

  try {
    // Fetch task first — this is the primary data we need
    const taskRes = await api.api.comp[":comp_id"].task[":task_id"].$get({
      param: { comp_id: compId, task_id: taskId },
    });

    if (!taskRes.ok) {
      showNotFound();
      return;
    }

    task = (await taskRes.json()) as unknown as TaskDetail;

    // Fetch comp for admin check + comp name (non-critical)
    try {
      const compRes = await api.api.comp[":comp_id"].$get({
        param: { comp_id: compId },
      });
      if (compRes.ok) {
        comp = (await compRes.json()) as unknown as CompDetail;
      }
    } catch {
      // Comp fetch failed — degrade gracefully (no admin features)
    }
  } catch {
    showNotFound();
    return;
  }

  document.title = `GlideComp - ${task.name}`;

  const isAdmin =
    user != null &&
    comp != null &&
    comp.admins.some((a) => a.email === user.email);

  // Back link
  const backLink = document.getElementById("task-back-link") as HTMLAnchorElement;
  backLink.href = `/comp/${compId}`;
  document.getElementById("task-back-comp-name")!.textContent =
    comp?.name ?? "Back to competition";

  // Task header
  document.getElementById("task-title")!.textContent = task.name;
  document.getElementById("task-date-badge")!.textContent = new Date(
    task.task_date + "T00:00:00"
  ).toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const xctskBadge = document.getElementById("task-xctsk-badge")!;
  if (task.xctsk) {
    xctskBadge.innerHTML = `<span class="inline-flex items-center rounded-md bg-green-500/10 text-green-500 px-1.5 py-0.5 text-xs font-medium">Task defined</span>`;
  } else {
    xctskBadge.innerHTML = `<span class="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">No task defined</span>`;
  }

  // Pilot class badges
  const classBadges = document.getElementById("task-class-badges")!;
  for (const cls of task.pilot_classes) {
    const span = document.createElement("span");
    span.className =
      "inline-flex items-center rounded-md bg-primary/10 text-primary px-1.5 py-0.5 text-xs font-medium";
    span.textContent = cls;
    classBadges.appendChild(span);
  }

  // Admin actions
  if (isAdmin && comp) {
    document.getElementById("task-admin-actions")!.classList.remove("hidden");
    setupEditTaskDialog(compId, taskId, task, comp.pilot_classes);
    setupDeleteTask(compId, taskId);
    setupTaskEditor(compId, taskId, task.xctsk as XCTask | null, false);
  } else if (task.xctsk) {
    // Non-admin: show read-only task viewer when task is defined
    setupTaskEditor(compId, taskId, task.xctsk as XCTask, true);
  }

  // Determine if current user can upload on behalf. Admins always can;
  // registered pilots can when comp.open_igc_upload is enabled. We look up
  // registration status by matching the user's email against the linked
  // email of a comp_pilot row — the pilot list endpoint includes linked_email
  // when a comp_pilot is linked to a GlideComp account.
  let canUploadOnBehalf = isAdmin;
  if (!isAdmin && user && comp?.open_igc_upload) {
    try {
      const pilotsRes = await api.api.comp[":comp_id"].pilot.$get({
        param: { comp_id: compId },
      });
      if (pilotsRes.ok) {
        const pilotsData = (await pilotsRes.json()) as {
          pilots: Array<{ linked_email?: string | null }>;
        };
        canUploadOnBehalf = pilotsData.pilots.some(
          (p) => p.linked_email === user.email
        );
      }
    } catch {
      // Non-critical — default to admin-only
    }
  }

  // Tracks section
  await setupTrackSection(
    compId,
    taskId,
    user != null,
    isAdmin,
    comp?.close_date ?? null,
    canUploadOnBehalf
  );

  // Pilot status (safety roll call) — authenticated users only. Anonymous
  // viewers don't need to see the status picker; when comp data failed
  // to load (comp == null) we skip too because we have no status config.
  if (comp) {
    setupPilotStatusSection(
      compId,
      taskId,
      comp.pilot_statuses ?? [],
      user,
      isAdmin,
      comp.open_igc_upload
    ).catch(() => {});
  }

  // Scores section (fire and forget — non-critical)
  setupScoreSection(compId, taskId).catch(() => {});

  // Show task detail, hide loading
  document.getElementById("comp-loading")!.classList.add("hidden");
  document.getElementById("task-detail")!.classList.remove("hidden");
}

function setupEditTaskDialog(
  compId: string,
  taskId: string,
  task: TaskDetail,
  compPilotClasses: string[]
) {
  const dialog = document.getElementById("edit-task-dialog") as HTMLDialogElement;
  const form = document.getElementById("edit-task-form") as HTMLFormElement;
  const nameInput = document.getElementById("edit-task-name") as HTMLInputElement;
  const dateInput = document.getElementById("edit-task-date") as HTMLInputElement;
  const classesContainer = document.getElementById("edit-task-classes-checkboxes")!;
  const submitBtn = document.getElementById("edit-task-submit-btn") as HTMLButtonElement;

  // Build class checkboxes
  classesContainer.innerHTML = "";
  for (const cls of compPilotClasses) {
    const label = document.createElement("label");
    label.className = "flex items-center gap-2 cursor-pointer";
    const checked = task.pilot_classes.includes(cls) ? "checked" : "";
    label.innerHTML = `
      <input type="checkbox" name="edit-task-class" value="${escapeHtml(cls)}" class="accent-primary w-4 h-4" ${checked}>
      <span class="text-sm">${escapeHtml(cls)}</span>
    `;
    classesContainer.appendChild(label);
  }

  document.getElementById("task-edit-btn")!.addEventListener("click", () => {
    nameInput.value = task.name;
    dateInput.value = task.task_date;
    dialog.showModal();
  });

  document.getElementById("edit-task-cancel-btn")!.addEventListener("click", () => {
    dialog.close();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving...";

    const selectedClasses = Array.from(
      classesContainer.querySelectorAll<HTMLInputElement>(
        'input[name="edit-task-class"]:checked'
      )
    ).map((cb) => cb.value);

    if (selectedClasses.length === 0) {
      alert("Select at least one pilot class");
      submitBtn.disabled = false;
      submitBtn.textContent = "Save";
      return;
    }

    try {
      const res = await api.api.comp[":comp_id"].task[":task_id"].$patch({
        param: { comp_id: compId, task_id: taskId },
        json: {
          name: nameInput.value.trim(),
          task_date: dateInput.value,
          pilot_classes: selectedClasses,
        },
      });

      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        alert(err.error || "Failed to update task");
        return;
      }

      dialog.close();
      window.location.reload();
    } catch {
      alert("Network error. Please try again.");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Save";
    }
  });
}

function setupDeleteTask(compId: string, taskId: string) {
  document.getElementById("task-delete-btn")!.addEventListener("click", async () => {
    if (!confirm("Delete this task? This cannot be undone.")) return;

    try {
      const res = await api.api.comp[":comp_id"].task[":task_id"].$delete({
        param: { comp_id: compId, task_id: taskId },
      });

      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        alert(err.error || "Failed to delete task");
        return;
      }

      window.location.href = `/comp/${compId}`;
    } catch {
      alert("Network error. Please try again.");
    }
  });
}

// ── Task editor integration ─────────────────────────────────────────────────

async function setupTaskEditor(
  compId: string,
  taskId: string,
  xctsk: XCTask | null,
  isReadOnly: boolean
) {
  const section = document.getElementById("task-editor-section")!;
  const container = document.getElementById("task-editor-container")!;
  const saveStatus = document.getElementById("task-save-status")!;
  section.classList.remove("hidden");

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let saving = false;

  function setSaveStatus(text: string) {
    saveStatus.textContent = text;
  }

  async function saveXctsk(task: XCTask) {
    if (saving) return;
    saving = true;
    setSaveStatus("Saving...");

    try {
      const res = await api.api.comp[":comp_id"].task[":task_id"].$patch({
        param: { comp_id: compId, task_id: taskId },
        json: { xctsk: task as unknown as Record<string, unknown> },
      });

      if (!res.ok) {
        setSaveStatus("Save failed");
      } else {
        setSaveStatus("Saved");
        // Update the xctsk badge to reflect task is now defined
        const badge = document.getElementById("task-xctsk-badge")!;
        badge.innerHTML = `<span class="inline-flex items-center rounded-md bg-green-500/10 text-green-500 px-1.5 py-0.5 text-xs font-medium">Task defined</span>`;
      }
    } catch {
      setSaveStatus("Save failed");
    } finally {
      saving = false;
    }
  }

  const { createTaskEditor } = await import("./analysis/task-editor");

  const editor = createTaskEditor({
    container,
    onTaskChanged: (task: XCTask) => {
      setSaveStatus("Unsaved changes");
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => saveXctsk(task), 1000);
    },
    hiddenAddMethods: ['search', 'map'],
    readOnly: isReadOnly,
  });

  // Load existing xctsk into the editor (null shows empty editor ready for use)
  editor.setTask(xctsk);
}

// ── Track section ───────────────────────────────────────────────────────────

interface TrackInfo {
  task_track_id: string;
  comp_pilot_id: string;
  pilot_name: string;
  igc_pilot_name: string | null;
  pilot_class: string;
  uploaded_at: string;
  file_size: number;
  penalty_points: number;
  penalty_reason: string | null;
  uploaded_by_name: string | null;
  /** True when the uploader is someone other than the pilot the track belongs to. */
  uploaded_on_behalf: boolean;
}

async function compressIgc(file: File): Promise<ArrayBuffer> {
  const stream = file.stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// ── Pilot status (safety roll call) section ────────────────────────────────

interface PilotStatusResponse {
  statuses: Array<{
    task_pilot_status_id: string;
    task_id: string;
    comp_pilot_id: string;
    pilot_name: string;
    status_key: string;
    status_label: string;
    note: string | null;
    set_by_name: string;
    set_at: string;
  }>;
}

/**
 * Render the pilot status roll-call section. Fetches:
 *   • the comp's registered pilots (to show everyone)
 *   • the current statuses for this task
 * and renders one row per pilot with a single-click-to-save dropdown
 * and an inline-editable note input.
 *
 * The dropdown fires an auto-save on `change` — no submit step. The note
 * field saves on `blur` or Enter. This matches the "one interaction,
 * done" UX the user asked for.
 */
async function setupPilotStatusSection(
  compId: string,
  taskId: string,
  statusConfig: PilotStatusConfig[],
  user: AuthUser | null,
  isAdmin: boolean,
  openIgcUpload: boolean
): Promise<void> {
  const section = document.getElementById("task-status-section")!;
  const list = document.getElementById("task-status-list")!;
  const empty = document.getElementById("task-status-empty")!;
  const hint = document.getElementById("task-status-hint")!;

  if (statusConfig.length === 0) {
    // No statuses configured — leave the section hidden.
    return;
  }

  // Load pilots + existing statuses in parallel
  const [pilotsRes, statusesRes] = await Promise.all([
    api.api.comp[":comp_id"].pilot.$get({ param: { comp_id: compId } }),
    api.api.comp[":comp_id"].task[":task_id"]["pilot-status"].$get({
      param: { comp_id: compId, task_id: taskId },
    }),
  ]);

  if (!pilotsRes.ok) return;
  const pilotsData = (await pilotsRes.json()) as {
    pilots: Array<{
      comp_pilot_id: string;
      name: string;
      linked_email: string | null;
      pilot_class: string;
    }>;
  };
  const statusesData = statusesRes.ok
    ? ((await statusesRes.json()) as PilotStatusResponse)
    : { statuses: [] };

  // Build lookup of current status per comp_pilot_id
  const byPilot = new Map<string, PilotStatusResponse["statuses"][number]>();
  for (const s of statusesData.statuses) {
    byPilot.set(s.comp_pilot_id, s);
  }

  section.classList.remove("hidden");

  if (pilotsData.pilots.length === 0) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  // Sort: pilots with a status first (most interesting for safety),
  // then alphabetical within each bucket.
  const sorted = pilotsData.pilots.slice().sort((a, b) => {
    const aHas = byPilot.has(a.comp_pilot_id) ? 0 : 1;
    const bHas = byPilot.has(b.comp_pilot_id) ? 0 : 1;
    if (aHas !== bHas) return aHas - bHas;
    return a.name.localeCompare(b.name);
  });

  // Quick summary in the hint slot
  const withStatus = statusesData.statuses.length;
  hint.textContent =
    withStatus === 0
      ? `${pilotsData.pilots.length} pilots`
      : `${withStatus} of ${pilotsData.pilots.length} marked`;

  list.innerHTML = "";
  for (const pilot of sorted) {
    list.appendChild(
      buildPilotStatusRow(
        compId,
        taskId,
        pilot,
        byPilot.get(pilot.comp_pilot_id) ?? null,
        statusConfig,
        user,
        isAdmin,
        openIgcUpload,
        hint,
        pilotsData.pilots.length
      )
    );
  }
}

/**
 * A single row: pilot name, status dropdown, note input. Permission logic
 * mirrors the server's `authorizeStatusMutation`: admin / self / buddy
 * (when open_igc_upload is on). Anyone without permission sees read-only
 * controls.
 */
function buildPilotStatusRow(
  compId: string,
  taskId: string,
  pilot: {
    comp_pilot_id: string;
    name: string;
    linked_email: string | null;
    pilot_class: string;
  },
  current: PilotStatusResponse["statuses"][number] | null,
  statusConfig: PilotStatusConfig[],
  user: AuthUser | null,
  isAdmin: boolean,
  openIgcUpload: boolean,
  hintEl: HTMLElement,
  totalPilots: number
): HTMLElement {
  const canEdit = user
    ? isAdmin ||
      pilot.linked_email === user.email ||
      // Buddy marking: rough check — the frontend doesn't know if the
      // caller is registered in this comp without an extra query. We
      // optimistically enable the controls when open_igc_upload is on; the
      // server re-validates and will reject with 403 if the caller isn't
      // registered, which we surface via the save-state UI.
      openIgcUpload
    : false;

  const row = document.createElement("div");
  row.className =
    "flex items-center gap-3 rounded-md border border-border/30 px-3 py-2 text-sm";

  // Name + class
  const nameWrap = document.createElement("div");
  nameWrap.className = "flex-1 min-w-0";
  const name = document.createElement("div");
  name.className = "font-medium truncate";
  name.textContent = pilot.name;
  nameWrap.appendChild(name);
  if (current) {
    const meta = document.createElement("div");
    meta.className = "text-xs text-muted-foreground";
    meta.textContent = `set by ${current.set_by_name}`;
    nameWrap.appendChild(meta);
  }
  row.appendChild(nameWrap);

  // Status dropdown — single interaction, auto-saves on change.
  const select = document.createElement("select");
  select.className = "input text-sm w-40";
  select.disabled = !canEdit;

  const blankOpt = document.createElement("option");
  blankOpt.value = "";
  blankOpt.textContent = "— no status —";
  select.appendChild(blankOpt);
  for (const s of statusConfig) {
    const opt = document.createElement("option");
    opt.value = s.key;
    opt.textContent = s.label;
    select.appendChild(opt);
  }
  select.value = current?.status_key ?? "";

  // Note input — editable in place; saves on blur or Enter.
  const noteInput = document.createElement("input");
  noteInput.type = "text";
  noteInput.className = "input text-sm w-48";
  noteInput.placeholder = "Add a note…";
  noteInput.value = current?.note ?? "";
  noteInput.maxLength = 128;
  noteInput.disabled = !canEdit || !select.value;

  const saveStatus = document.createElement("span");
  saveStatus.className = "text-xs text-muted-foreground w-12 text-right";
  saveStatus.textContent = "";

  /**
   * Inline save helper: issues the appropriate PUT/DELETE/PATCH, flashes
   * "saving…" then "saved", and surfaces errors in the save slot. Keeps
   * the whole interaction to one click without any modal.
   */
  async function saveStatusChange(newKey: string) {
    saveStatus.textContent = "saving…";
    try {
      if (newKey === "") {
        if (!current) {
          saveStatus.textContent = "";
          return;
        }
        const res = await api.api.comp[":comp_id"].task[":task_id"][
          "pilot-status"
        ][":comp_pilot_id"].$delete({
          param: {
            comp_id: compId,
            task_id: taskId,
            comp_pilot_id: pilot.comp_pilot_id,
          },
        });
        if (!res.ok) throw new Error(`${res.status}`);
        current = null;
        noteInput.value = "";
        noteInput.disabled = true;
      } else {
        const res = await api.api.comp[":comp_id"].task[":task_id"][
          "pilot-status"
        ][":comp_pilot_id"].$put({
          param: {
            comp_id: compId,
            task_id: taskId,
            comp_pilot_id: pilot.comp_pilot_id,
          },
          json: { status_key: newKey, note: noteInput.value || null },
        });
        if (!res.ok) throw new Error(`${res.status}`);
        const data = (await res.json()) as PilotStatusResponse["statuses"][number];
        current = data;
        noteInput.disabled = false;
      }
      saveStatus.textContent = "saved";
      setTimeout(() => {
        if (saveStatus.textContent === "saved") saveStatus.textContent = "";
      }, 1500);
      refreshHint();
    } catch (err) {
      const code = (err as Error).message;
      saveStatus.textContent = code === "403" ? "denied" : "error";
      // Revert select to prior value
      select.value = current?.status_key ?? "";
    }
  }

  async function saveNoteChange() {
    if (!current) return;
    if ((current.note ?? "") === (noteInput.value || "")) return;
    saveStatus.textContent = "saving…";
    try {
      const res = await api.api.comp[":comp_id"].task[":task_id"][
        "pilot-status"
      ][":comp_pilot_id"].$patch({
        param: {
          comp_id: compId,
          task_id: taskId,
          comp_pilot_id: pilot.comp_pilot_id,
        },
        json: { note: noteInput.value || null },
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = (await res.json()) as PilotStatusResponse["statuses"][number];
      current = data;
      saveStatus.textContent = "saved";
      setTimeout(() => {
        if (saveStatus.textContent === "saved") saveStatus.textContent = "";
      }, 1500);
    } catch (err) {
      const code = (err as Error).message;
      saveStatus.textContent = code === "403" ? "denied" : "error";
      noteInput.value = current?.note ?? "";
    }
  }

  function refreshHint() {
    // Re-count from the DOM — simpler than threading state.
    const selects = Array.from(
      document.querySelectorAll("#task-status-list select")
    ) as unknown as HTMLSelectElement[];
    const marked = selects.filter((s) => s.value !== "").length;
    hintEl.textContent =
      marked === 0 ? `${totalPilots} pilots` : `${marked} of ${totalPilots} marked`;
  }

  select.addEventListener("change", () => {
    void saveStatusChange(select.value);
  });
  noteInput.addEventListener("blur", () => {
    void saveNoteChange();
  });
  noteInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      noteInput.blur();
    }
  });

  row.appendChild(select);
  row.appendChild(noteInput);
  row.appendChild(saveStatus);
  return row;
}

async function setupTrackSection(
  compId: string,
  taskId: string,
  isAuthenticated: boolean,
  isAdmin: boolean,
  closeDate: string | null,
  canUploadOnBehalf: boolean
) {
  // Treat close_date as end-of-day local time (a date like "2026-12-31"
  // parsed by new Date() is midnight UTC, which is already past in UTC+ timezones)
  const isClosed =
    closeDate != null &&
    closeDate !== "" &&
    new Date() > new Date(closeDate + "T23:59:59");

  // Load tracks
  const tracks = await loadTracks(compId, taskId);
  renderTrackList(tracks, compId, taskId, isAdmin, isClosed);

  if (isClosed) {
    document.getElementById("task-closed-badge")!.style.display = "inline-flex";
  }

  // Show upload buttons for authenticated users (unless comp is closed)
  if (isAuthenticated && !isClosed) {
    setupSelfUpload(compId, taskId, isAdmin, isClosed);
  }

  // Upload on behalf: available to admins, and to registered pilots when
  // comp.open_igc_upload is enabled.
  if (canUploadOnBehalf && !isClosed) {
    setupUploadOnBehalf(compId, taskId, isAdmin, isClosed);
  }
}

async function loadTracks(
  compId: string,
  taskId: string
): Promise<TrackInfo[]> {
  try {
    const res = await api.api.comp[":comp_id"].task[":task_id"].igc.$get({
      param: { comp_id: compId, task_id: taskId },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { tracks: TrackInfo[] };
    return data.tracks;
  } catch {
    return [];
  }
}

function renderTrackList(
  tracks: TrackInfo[],
  compId: string,
  taskId: string,
  isAdmin: boolean,
  isClosed: boolean
) {
  const list = document.getElementById("track-list")!;
  const empty = document.getElementById("tracks-empty")!;
  const countEl = document.getElementById("task-track-count")!;

  countEl.textContent = `${tracks.length} track${tracks.length !== 1 ? "s" : ""}`;
  list.innerHTML = "";

  if (tracks.length === 0) {
    empty.classList.remove("hidden");
    return;
  }

  empty.classList.add("hidden");

  for (const track of tracks) {
    const div = document.createElement("div");
    div.className =
      "flex items-center justify-between rounded-lg border border-border/50 px-4 py-3";

    const uploadDate = new Date(track.uploaded_at).toLocaleDateString(
      undefined,
      { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
    );

    div.innerHTML = `
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          <span class="font-medium text-sm">${escapeHtml(track.pilot_name)}</span>
          <span class="inline-flex items-center rounded-md bg-primary/10 text-primary px-1.5 py-0.5 text-xs font-medium">${escapeHtml(track.pilot_class)}</span>
          <span class="js-igc-name-slot"></span>
        </div>
        <div class="text-xs text-muted-foreground mt-0.5">
          ${uploadDate} &middot; ${formatFileSize(track.file_size)}<span class="js-uploaded-by-slot"></span>
        </div>
      </div>
      <div class="flex items-center gap-1 shrink-0">
        <a href="/api/comp/${encodeURIComponent(compId)}/task/${encodeURIComponent(taskId)}/igc/${encodeURIComponent(track.comp_pilot_id)}/download"
           class="btn btn-ghost btn-sm text-xs" title="Download">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </a>
      </div>
    `;

    // IGC pilot name (when different from registered name)
    if (track.igc_pilot_name && track.igc_pilot_name !== track.pilot_name) {
      const slot = div.querySelector(".js-igc-name-slot")!;
      slot.className = "text-xs text-muted-foreground";
      slot.textContent = `(igc: ${track.igc_pilot_name})`;
    }

    // "Uploaded by X" attribution when the uploader is someone other than
    // the pilot the track belongs to (admin-on-behalf, or peer upload).
    if (track.uploaded_on_behalf && track.uploaded_by_name) {
      const slot = div.querySelector(".js-uploaded-by-slot")!;
      const sep = document.createTextNode(" · ");
      const label = document.createElement("span");
      label.textContent = `uploaded by ${track.uploaded_by_name}`;
      slot.appendChild(sep);
      slot.appendChild(label);
    }

    // Penalty badge — built with DOM so title is safe for any user-supplied text
    if (track.penalty_points !== 0) {
      const isBonus = track.penalty_points < 0;
      const badge = document.createElement("span");
      badge.className = `inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium ${isBonus ? "bg-green-500/10 text-green-500" : "bg-red-500/10 text-red-500"}`;
      badge.textContent = `${isBonus ? "+" : "-"}${Math.abs(track.penalty_points)} pts`;
      const inner = document.createElement("span");
      inner.className = "inline-flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5";
      inner.appendChild(badge);
      if (track.penalty_reason) {
        const reason = document.createElement("span");
        reason.className = "text-xs text-muted-foreground";
        reason.textContent = track.penalty_reason;
        inner.appendChild(reason);
      }
      div.querySelector(".flex.items-center.gap-2")!.appendChild(inner);
    }

    // Admin actions: penalty + delete (not when closed)
    if (isAdmin && !isClosed) {
      const actionsDiv = div.querySelector(".flex.items-center.gap-1")!;

      // Penalty button
      const penaltyBtn = document.createElement("button");
      penaltyBtn.className = "btn btn-ghost btn-sm text-xs";
      penaltyBtn.title = "Set penalty";
      penaltyBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>`;
      penaltyBtn.addEventListener("click", () => {
        openPenaltyDialog(compId, taskId, track, isAdmin, isClosed);
      });
      actionsDiv.appendChild(penaltyBtn);

      // Delete button
      const deleteBtn = document.createElement("button");
      deleteBtn.className = "btn-sm-destructive text-xs";
      deleteBtn.title = "Delete track";
      deleteBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
      deleteBtn.addEventListener("click", async () => {
        if (!confirm(`Delete track for ${track.pilot_name}?`)) return;
        try {
          const res = await api.api.comp[":comp_id"].task[":task_id"].igc[
            ":comp_pilot_id"
          ].$delete({
            param: {
              comp_id: compId,
              task_id: taskId,
              comp_pilot_id: track.comp_pilot_id,
            },
          });
          if (res.ok) {
            div.remove();
            const remaining = list.children.length;
            countEl.textContent = `${remaining} track${remaining !== 1 ? "s" : ""}`;
            if (remaining === 0) empty.classList.remove("hidden");
            setupScoreSection(compId, taskId).catch(() => {});
          } else {
            alert("Failed to delete track");
          }
        } catch {
          alert("Network error");
        }
      });
      actionsDiv.appendChild(deleteBtn);
    }

    list.appendChild(div);
  }
}

function openPenaltyDialog(
  compId: string,
  taskId: string,
  track: TrackInfo,
  isAdmin: boolean,
  isClosed: boolean
) {
  const dialog = document.getElementById("penalty-dialog") as HTMLDialogElement;
  const form = document.getElementById("penalty-form") as HTMLFormElement;
  const pilotNameEl = document.getElementById("penalty-pilot-name")!;
  const pointsInput = document.getElementById("penalty-points") as HTMLInputElement;
  const reasonInput = document.getElementById("penalty-reason") as HTMLInputElement;
  const submitBtn = document.getElementById("penalty-submit-btn") as HTMLButtonElement;

  pilotNameEl.textContent = track.pilot_name;
  pointsInput.value = String(track.penalty_points);
  reasonInput.value = track.penalty_reason ?? "";

  // Remove old listener by cloning
  const newForm = form.cloneNode(true) as HTMLFormElement;
  form.parentNode!.replaceChild(newForm, form);

  (newForm.querySelector("#penalty-cancel-btn") as HTMLButtonElement)
    .addEventListener("click", () => dialog.close());

  newForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = newForm.querySelector("#penalty-submit-btn") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "Saving...";

    try {
      const res = await api.api.comp[":comp_id"].task[":task_id"].igc[
        ":comp_pilot_id"
      ].$patch({
        param: {
          comp_id: compId,
          task_id: taskId,
          comp_pilot_id: track.comp_pilot_id,
        },
        json: {
          penalty_points: parseFloat(
            (newForm.querySelector("#penalty-points") as HTMLInputElement).value
          ),
          penalty_reason:
            (newForm.querySelector("#penalty-reason") as HTMLInputElement).value.trim() || null,
        },
      });

      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        alert(err.error || "Failed to set penalty");
        return;
      }

      dialog.close();
      // Reload track list and refresh scores (penalty changes the cache key)
      const tracks = await loadTracks(compId, taskId);
      renderTrackList(tracks, compId, taskId, isAdmin, isClosed);
      setupScoreSection(compId, taskId).catch(() => {});
    } catch {
      alert("Network error. Please try again.");
    } finally {
      btn.disabled = false;
      btn.textContent = "Save";
    }
  });

  dialog.showModal();
}

function setupSelfUpload(
  compId: string,
  taskId: string,
  isAdmin: boolean,
  isClosed: boolean
) {
  const btn = document.getElementById("upload-self-btn")!;
  const input = document.getElementById("track-upload-input") as HTMLInputElement;
  const statusDiv = document.getElementById("track-upload-status")!;
  const messageEl = document.getElementById("track-upload-message")!;

  btn.classList.remove("hidden");

  btn.addEventListener("click", () => input.click());

  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;

    if (!file.name.toLowerCase().endsWith(".igc")) {
      showUploadStatus(messageEl, statusDiv, "Please select an IGC file", true);
      input.value = "";
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      showUploadStatus(messageEl, statusDiv, "File too large (max 5MB)", true);
      input.value = "";
      return;
    }

    btn.setAttribute("disabled", "");
    btn.textContent = "Uploading...";
    showUploadStatus(messageEl, statusDiv, "Compressing and uploading...", false);

    try {
      const compressed = await compressIgc(file);

      const res = await fetch(
        `/api/comp/${encodeURIComponent(compId)}/task/${encodeURIComponent(taskId)}/igc`,
        {
          method: "POST",
          credentials: "include",
          body: compressed,
        }
      );

      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        showUploadStatus(messageEl, statusDiv, err.error || "Upload failed", true);
        return;
      }

      const data = (await res.json()) as { replaced: boolean };
      showUploadStatus(
        messageEl,
        statusDiv,
        data.replaced ? "Track replaced" : "Track uploaded",
        false
      );

      const tracks = await loadTracks(compId, taskId);
      renderTrackList(tracks, compId, taskId, isAdmin, isClosed);
      setupScoreSection(compId, taskId).catch(() => {});
    } catch {
      showUploadStatus(messageEl, statusDiv, "Network error", true);
    } finally {
      btn.removeAttribute("disabled");
      btn.textContent = "Upload for me";
      input.value = "";
    }
  });
}

function showUploadStatus(
  messageEl: HTMLElement,
  statusDiv: HTMLElement,
  msg: string,
  isError: boolean
) {
  statusDiv.classList.remove("hidden");
  messageEl.textContent = msg;
  messageEl.className = `text-sm ${isError ? "text-destructive" : "text-muted-foreground"}`;
}

function setupUploadOnBehalf(
  compId: string,
  taskId: string,
  isAdmin: boolean,
  isClosed: boolean
) {
  const btn = document.getElementById("upload-behalf-btn")!;
  btn.classList.remove("hidden");

  const dialog = document.getElementById("upload-behalf-dialog") as HTMLDialogElement;
  const pilotSelect = document.getElementById("behalf-pilot-select") as unknown as HTMLSelectElement;
  const fileInput = document.getElementById("behalf-file-input") as HTMLInputElement;
  const uploadBtn = document.getElementById("behalf-upload-btn") as HTMLButtonElement;
  const statusDiv = document.getElementById("behalf-upload-status")!;
  const messageEl = document.getElementById("behalf-upload-message")!;

  btn.addEventListener("click", async () => {
    // Fetch registered pilots
    pilotSelect.innerHTML = '<option value="">Loading...</option>';
    fileInput.value = "";
    statusDiv.classList.add("hidden");
    dialog.showModal();

    try {
      const res = await api.api.comp[":comp_id"].pilot.$get({
        param: { comp_id: compId },
      });
      if (!res.ok) {
        pilotSelect.innerHTML = '<option value="">Failed to load pilots</option>';
        return;
      }
      const data = (await res.json()) as {
        pilots: Array<{ comp_pilot_id: string; name: string; pilot_class: string }>;
      };
      pilotSelect.innerHTML = "";
      if (data.pilots.length === 0) {
        pilotSelect.innerHTML = '<option value="">No registered pilots</option>';
        return;
      }
      for (const p of data.pilots) {
        const opt = document.createElement("option");
        opt.value = p.comp_pilot_id;
        opt.textContent = `${p.name} (${p.pilot_class})`;
        pilotSelect.appendChild(opt);
      }
    } catch {
      pilotSelect.innerHTML = '<option value="">Network error</option>';
    }
  });

  document.getElementById("behalf-cancel-btn")!.addEventListener("click", () => {
    dialog.close();
  });

  uploadBtn.addEventListener("click", async () => {
    const selectedPilot = pilotSelect.value;
    if (!selectedPilot) {
      messageEl.textContent = "Select a pilot";
      messageEl.className = "text-sm text-destructive";
      statusDiv.classList.remove("hidden");
      return;
    }

    const file = fileInput.files?.[0];
    if (!file) {
      messageEl.textContent = "Select an IGC file";
      messageEl.className = "text-sm text-destructive";
      statusDiv.classList.remove("hidden");
      return;
    }

    if (!file.name.toLowerCase().endsWith(".igc")) {
      messageEl.textContent = "Please select an IGC file";
      messageEl.className = "text-sm text-destructive";
      statusDiv.classList.remove("hidden");
      return;
    }

    uploadBtn.disabled = true;
    uploadBtn.textContent = "Uploading...";
    messageEl.textContent = "Compressing and uploading...";
    messageEl.className = "text-sm text-muted-foreground";
    statusDiv.classList.remove("hidden");

    try {
      const compressed = await compressIgc(file);

      const res = await fetch(
        `/api/comp/${encodeURIComponent(compId)}/task/${encodeURIComponent(taskId)}/igc/${encodeURIComponent(selectedPilot)}`,
        {
          method: "POST",
          credentials: "include",
          body: compressed,
        }
      );

      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        messageEl.textContent = err.error || "Upload failed";
        messageEl.className = "text-sm text-destructive";
        return;
      }

      const data = (await res.json()) as { replaced: boolean };
      messageEl.textContent = data.replaced
        ? "Track replaced successfully"
        : "Track uploaded successfully";
      messageEl.className = "text-sm text-muted-foreground";

      // Reload track list and refresh scores
      const tracks = await loadTracks(compId, taskId);
      renderTrackList(tracks, compId, taskId, isAdmin, isClosed);
      setupScoreSection(compId, taskId).catch(() => {});

      // Close after a brief delay so user sees success
      setTimeout(() => dialog.close(), 1000);
    } catch {
      messageEl.textContent = "Network error. Please try again.";
      messageEl.className = "text-sm text-destructive";
    } finally {
      uploadBtn.disabled = false;
      uploadBtn.textContent = "Upload";
    }
  });
}

// ── Scoring section ──────────────────────────────────────────────────────────

function renderScoreClass(cls: ClassScore, showClassName: boolean): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "mb-6";

  if (showClassName) {
    const h3 = document.createElement("h3");
    h3.className = "text-sm font-semibold mb-2";
    h3.textContent = cls.pilot_class;
    wrapper.appendChild(h3);
  }

  const hasSpeed = cls.pilots.some((p) => p.speed_section_time !== null);
  const hasTimePoints = cls.pilots.some((p) => p.time_points !== 0);
  const hasLeadPoints = cls.pilots.some((p) => p.leading_points !== 0);
  const hasPenalties = cls.pilots.some((p) => p.penalty_points !== 0);

  const table = document.createElement("table");
  table.className = "w-full text-sm border-collapse";

  // thead
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  headerRow.className = "text-left text-xs text-muted-foreground border-b border-border/50";
  const headers = ["#", "Pilot", "Goal", "Distance"];
  if (hasSpeed) headers.push("Speed");
  headers.push("Dist Pts");
  if (hasTimePoints) headers.push("Time Pts");
  if (hasLeadPoints) headers.push("Lead Pts");
  if (hasPenalties) headers.push("Penalty");
  headers.push("Total");

  for (const h of headers) {
    const th = document.createElement("th");
    th.className = "py-1.5 pr-3 font-medium";
    th.textContent = h;
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

    const cells: string[] = [
      String(p.rank),
      escapeHtml(p.pilot_name),
      p.made_goal
        ? `<span class="text-green-500">✓</span>`
        : `<span class="text-muted-foreground">—</span>`,
      `${(p.flown_distance / 1000).toFixed(1)} km`,
    ];

    if (hasSpeed) {
      cells.push(
        p.speed_section_time !== null
          ? formatDuration(p.speed_section_time)
          : `<span class="text-muted-foreground">—</span>`
      );
    }

    cells.push(Math.round(p.distance_points).toString());
    if (hasTimePoints) cells.push(Math.round(p.time_points).toString());
    if (hasLeadPoints) cells.push(Math.round(p.leading_points).toString());

    for (const cellHtml of cells) {
      const td = document.createElement("td");
      td.className = "py-1.5 pr-3";
      td.innerHTML = cellHtml;
      tr.appendChild(td);
    }

    // Penalty td (conditional column) — DOM so .title is safe for any user text
    if (hasPenalties) {
      const penaltyTd = document.createElement("td");
      penaltyTd.className = "py-1.5 pr-3";
      if (p.penalty_points !== 0) {
        const badge = document.createElement("span");
        const isBonus = p.penalty_points < 0;
        badge.className = `inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium ${isBonus ? "bg-green-500/10 text-green-500" : "bg-red-500/10 text-red-500"}`;
        badge.textContent = isBonus ? `+${Math.abs(p.penalty_points)}` : `-${p.penalty_points}`;
        const inner = document.createElement("span");
        inner.className = "inline-flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5";
        inner.appendChild(badge);
        if (p.penalty_reason) {
          const reason = document.createElement("span");
          reason.className = "text-xs text-muted-foreground";
          reason.textContent = p.penalty_reason;
          inner.appendChild(reason);
        }
        penaltyTd.appendChild(inner);
      }
      tr.appendChild(penaltyTd);
    }

    // Total td
    const totalTd = document.createElement("td");
    totalTd.className = "py-1.5 pr-3";
    totalTd.textContent = String(Math.round(p.total_score));
    tr.appendChild(totalTd);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrapper.appendChild(table);

  // Validity summary
  const v = cls.task_validity;
  const ap = cls.available_points;
  const summary = document.createElement("p");
  summary.className = "text-xs text-muted-foreground mt-2";
  summary.textContent = `Task validity: ${(v.task * 100).toFixed(0)}% · Available: ${Math.round(ap.total)} pts (dist ${Math.round(ap.distance)}, time ${Math.round(ap.time)}, lead ${Math.round(ap.leading)})`;
  wrapper.appendChild(summary);

  return wrapper;
}

async function setupScoreSection(compId: string, taskId: string) {
  const content = document.getElementById("task-scores-content")!;
  const scoresLink = document.getElementById("task-scores-link") as HTMLAnchorElement;

  let data: TaskScoreData;
  try {
    const res = await api.api.comp[":comp_id"].task[":task_id"].score.$get({
      param: { comp_id: compId, task_id: taskId },
    });
    if (res.status === 422) {
      content.innerHTML = `<p class="text-sm text-muted-foreground">No scores yet — task route not defined</p>`;
      return;
    }
    if (!res.ok) {
      content.innerHTML = `<p class="text-sm text-muted-foreground">Scores not available</p>`;
      return;
    }
    data = (await res.json()) as unknown as TaskScoreData;
  } catch {
    content.innerHTML = `<p class="text-sm text-muted-foreground">Scores not available</p>`;
    return;
  }

  content.innerHTML = "";
  const showClassName = data.classes.length > 1;
  for (const cls of data.classes) {
    content.appendChild(renderScoreClass(cls, showClassName));
  }

  scoresLink.href = `/scores?comp_id=${encodeURIComponent(compId)}`;
  scoresLink.classList.remove("hidden");
}

// ── Comp detail view ─────────────────────────────────────────────────────────

async function initCompDetail(compId: string, user: AuthUser | null) {
  let comp: CompDetail;

  try {
    const res = await api.api.comp[":comp_id"].$get({
      param: { comp_id: compId },
    });

    if (!res.ok) {
      showNotFound();
      return;
    }

    comp = (await res.json()) as unknown as CompDetail;
  } catch {
    showNotFound();
    return;
  }

  document.title = `GlideComp - ${comp.name}`;

  // Check if current user is admin
  const isAdmin =
    user != null &&
    comp.admins.some((a) => a.email === user.email);

  // ── Populate header ────────────────────────────────────────────────────

  document.getElementById("comp-title")!.textContent = comp.name;
  document.getElementById("comp-category-badge")!.innerHTML = categoryBadge(
    comp.category
  );
  if (comp.test) {
    document.getElementById("comp-test-badge")!.classList.remove("hidden");
  }
  document.getElementById("comp-classes")!.textContent =
    comp.pilot_classes.join(", ");

  // Show settings button for admins
  if (isAdmin) {
    document.getElementById("comp-settings-btn")!.classList.remove("hidden");
  }

  // ── Class coverage warnings ────────────────────────────────────────────

  renderWarnings(comp.class_coverage_warnings);

  // ── Tasks ──────────────────────────────────────────────────────────────

  renderTasks(comp.tasks, compId);

  // Show scores link when there's at least one task with a defined route
  if (comp.tasks.some((t) => t.has_xctsk)) {
    const scoresLink = document.getElementById("comp-scores-link") as HTMLAnchorElement;
    scoresLink.href = `/scores?comp_id=${encodeURIComponent(compId)}`;
    scoresLink.classList.remove("hidden");
  }

  // Show create task button for admins
  if (isAdmin) {
    document.getElementById("create-task-btn")!.classList.remove("hidden");
  }

  // ── Pilots ─────────────────────────────────────────────────────────────
  setupPilotsSection(compId, comp.name, comp.pilot_classes, isAdmin);

  // ── Activity (audit log) ───────────────────────────────────────────────
  setupActivitySection(compId);

  // ── Admins ─────────────────────────────────────────────────────────────

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

  // ── Create task dialog ─────────────────────────────────────────────────

  if (isAdmin) {
    setupCreateTaskDialog(compId, comp.pilot_classes);
    setupSettingsDialog(compId, comp);
  }
}

// ── Activity (audit log) section ─────────────────────────────────────────────

interface AuditEntry {
  audit_id: number;
  timestamp: string;
  actor_name: string;
  subject_type: "comp" | "task" | "pilot" | "track";
  subject_id: string | null;
  subject_name: string | null;
  description: string;
}

interface AuditResponse {
  entries: AuditEntry[];
  has_more: boolean;
  next_before: number | null;
}

/**
 * Wire up the Activity section: initial load, filter tabs, load-more.
 * Uses plain fetch (not the Hono RPC client) to keep the response shape
 * simple and avoid bundling typed-client overhead for read-only data.
 */
function setupActivitySection(compId: string) {
  const list = document.getElementById("activity-list")!;
  const empty = document.getElementById("activity-empty")!;
  const loadMoreWrap = document.getElementById("activity-load-more-wrap")!;
  const loadMoreBtn = document.getElementById(
    "activity-load-more"
  ) as HTMLButtonElement;

  let currentFilter = "";
  let nextBefore: number | null = null;

  async function loadPage(reset: boolean) {
    const params = new URLSearchParams();
    params.set("limit", "25");
    if (currentFilter) params.set("subject_type", currentFilter);
    if (!reset && nextBefore !== null) {
      params.set("before", String(nextBefore));
    }
    try {
      const res = await fetch(
        `/api/comp/${encodeURIComponent(compId)}/audit?${params}`,
        { credentials: "include" }
      );
      if (!res.ok) {
        if (reset) {
          empty.classList.remove("hidden");
          empty.querySelector("p")!.textContent = "Could not load activity";
        }
        return;
      }
      const data = (await res.json()) as AuditResponse;
      if (reset) {
        list.innerHTML = "";
      }
      for (const entry of data.entries) {
        list.appendChild(renderAuditEntry(entry));
      }
      nextBefore = data.next_before;
      if (data.has_more) {
        loadMoreWrap.classList.remove("hidden");
      } else {
        loadMoreWrap.classList.add("hidden");
      }
      if (reset && data.entries.length === 0) {
        empty.classList.remove("hidden");
      } else {
        empty.classList.add("hidden");
      }
    } catch {
      // Silent — activity is non-critical
    }
  }

  // Filter tab wiring (Basecoat tabs — toggle aria-selected + aria-labelledby)
  const filterBtns = document.querySelectorAll<HTMLButtonElement>(
    ".activity-filter-btn"
  );
  const panel = document.getElementById("activity-panel")!;
  function setActiveFilter(filter: string) {
    currentFilter = filter;
    nextBefore = null;
    for (const btn of filterBtns) {
      const active = btn.dataset.filter === filter;
      btn.setAttribute("aria-selected", active ? "true" : "false");
      if (active) panel.setAttribute("aria-labelledby", btn.id);
    }
    loadPage(true);
  }
  for (const btn of filterBtns) {
    btn.addEventListener("click", () => setActiveFilter(btn.dataset.filter || ""));
  }

  loadMoreBtn.addEventListener("click", () => loadPage(false));

  // Initial load with "All" filter active
  setActiveFilter("");
}

function renderAuditEntry(entry: AuditEntry): HTMLElement {
  const row = document.createElement("div");
  row.className =
    "flex items-start gap-3 text-sm py-1.5 border-b border-border/30 last:border-b-0";

  const time = document.createElement("span");
  time.className = "text-xs text-muted-foreground/70 whitespace-nowrap pt-0.5 w-24 shrink-0";
  time.textContent = formatAuditTime(entry.timestamp);

  const main = document.createElement("div");
  main.className = "flex-1 min-w-0";

  const actor = document.createElement("span");
  actor.className = "font-medium text-foreground";
  actor.textContent = entry.actor_name;

  const desc = document.createElement("span");
  desc.className = "text-muted-foreground ml-2";
  desc.textContent = entry.description;

  main.appendChild(actor);
  main.appendChild(desc);
  row.appendChild(time);
  row.appendChild(main);
  return row;
}

function formatAuditTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

// ── Render tasks list ────────────────────────────────────────────────────────

function renderTasks(tasks: TaskSummary[], compId: string) {
  const tasksList = document.getElementById("tasks-list")!;
  const tasksEmpty = document.getElementById("tasks-empty")!;

  tasksList.innerHTML = "";

  if (tasks.length > 0) {
    tasksEmpty.classList.add("hidden");

    // Group tasks by date
    const byDate = new Map<string, TaskSummary[]>();
    for (const task of tasks) {
      const list = byDate.get(task.task_date) ?? [];
      list.push(task);
      byDate.set(task.task_date, list);
    }

    for (const [date, dateTasks] of byDate) {
      const dateLabel = document.createElement("div");
      dateLabel.className =
        "text-xs font-medium text-muted-foreground/70 mt-3 first:mt-0 mb-1";
      dateLabel.textContent = new Date(date + "T00:00:00").toLocaleDateString(
        undefined,
        { weekday: "short", year: "numeric", month: "short", day: "numeric" }
      );
      tasksList.appendChild(dateLabel);

      for (const task of dateTasks) {
        const a = document.createElement("a");
        a.href = `/comp/${compId}/task/${task.task_id}`;
        a.className =
          "flex items-center justify-between rounded-lg border border-border/50 px-4 py-3 hover:bg-muted/50 transition-colors";

        const xctskBadge = task.has_xctsk
          ? `<span class="inline-flex items-center rounded-md bg-green-500/10 text-green-500 px-1.5 py-0.5 text-xs font-medium">Task set</span>`
          : `<span class="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">No task</span>`;

        a.innerHTML = `
          <div class="flex-1 min-w-0">
            <div class="font-medium text-sm">${escapeHtml(task.name)}</div>
            <div class="flex items-center gap-2 mt-0.5">
              ${xctskBadge}
              <span class="text-xs text-muted-foreground">${escapeHtml(task.pilot_classes.join(", "))}</span>
            </div>
          </div>
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-muted-foreground/40 shrink-0">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
        `;
        tasksList.appendChild(a);
      }
    }
  } else {
    tasksEmpty.classList.remove("hidden");
  }
}

// ── Render class coverage warnings ───────────────────────────────────────────

function renderWarnings(
  warnings: CompDetail["class_coverage_warnings"]
) {
  const container = document.getElementById("class-warnings")!;
  if (warnings.length === 0) {
    container.classList.add("hidden");
    return;
  }

  container.classList.remove("hidden");
  container.innerHTML = "";

  const wrapper = document.createElement("div");
  wrapper.className =
    "rounded-lg border border-amber-500/30 bg-amber-500/5 p-4";
  wrapper.innerHTML = `
    <div class="flex items-center gap-2 mb-2">
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-amber-500"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      <span class="text-sm font-medium text-amber-500">Task Coverage Issues</span>
    </div>
  `;

  const list = document.createElement("ul");
  list.className = "space-y-1 ml-6";

  for (const w of warnings) {
    const dateStr = new Date(w.date + "T00:00:00").toLocaleDateString(
      undefined,
      { month: "short", day: "numeric" }
    );
    const parts: string[] = [];
    if (w.missing_classes && w.missing_classes.length > 0) {
      parts.push(
        `missing classes: <strong>${escapeHtml(w.missing_classes.join(", "))}</strong>`
      );
    }
    if (w.inconsistent_groupings) {
      parts.push("inconsistent task-class groupings");
    }
    const li = document.createElement("li");
    li.className = "text-xs text-amber-500/80";
    li.innerHTML = `<strong>${dateStr}</strong> &mdash; ${parts.join("; ")}`;
    list.appendChild(li);
  }

  wrapper.appendChild(list);
  container.appendChild(wrapper);
}

// ── Create task dialog ───────────────────────────────────────────────────────

function setupCreateTaskDialog(compId: string, pilotClasses: string[]) {
  const dialog = document.getElementById(
    "create-task-dialog"
  ) as HTMLDialogElement;
  const form = document.getElementById("create-task-form") as HTMLFormElement;
  const nameInput = document.getElementById("task-name") as HTMLInputElement;
  const dateInput = document.getElementById("task-date") as HTMLInputElement;
  const classesContainer = document.getElementById(
    "task-classes-checkboxes"
  )!;
  const submitBtn = document.getElementById(
    "task-submit-btn"
  ) as HTMLButtonElement;

  // Build class checkboxes
  classesContainer.innerHTML = "";
  for (const cls of pilotClasses) {
    const label = document.createElement("label");
    label.className = "flex items-center gap-2 cursor-pointer";
    label.innerHTML = `
      <input type="checkbox" name="task-class" value="${escapeHtml(cls)}" class="accent-primary w-4 h-4" checked>
      <span class="text-sm">${escapeHtml(cls)}</span>
    `;
    classesContainer.appendChild(label);
  }

  document.getElementById("create-task-btn")!.addEventListener("click", () => {
    nameInput.value = "";
    dateInput.value = new Date().toISOString().split("T")[0];
    // Check all classes by default
    classesContainer
      .querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
      .forEach((cb) => (cb.checked = true));
    dialog.showModal();
  });

  document.getElementById("task-cancel-btn")!.addEventListener("click", () => {
    dialog.close();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    submitBtn.disabled = true;
    submitBtn.textContent = "Creating...";

    const name = nameInput.value.trim();
    const taskDate = dateInput.value;
    const selectedClasses = Array.from(
      classesContainer.querySelectorAll<HTMLInputElement>(
        'input[name="task-class"]:checked'
      )
    ).map((cb) => cb.value);

    if (selectedClasses.length === 0) {
      alert("Select at least one pilot class");
      submitBtn.disabled = false;
      submitBtn.textContent = "Create";
      return;
    }

    try {
      const res = await api.api.comp[":comp_id"].task.$post({
        param: { comp_id: compId },
        json: { name, task_date: taskDate, pilot_classes: selectedClasses },
      });

      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        alert(err.error || "Failed to create task");
        return;
      }

      dialog.close();
      // Reload to show the new task
      window.location.reload();
    } catch {
      alert("Network error. Please try again.");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Create";
    }
  });
}

// ── Settings dialog ──────────────────────────────────────────────────────────

/**
 * Slugify a human label into a stable ASCII key for pilot_statuses.
 * Matches the validator regex: lowercase letters/digits/underscores.
 * Used when the admin creates a new status row — we derive the key from
 * the label automatically so admins don't have to think about it.
 */
function slugifyStatusKey(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

/**
 * Render the editable list of pilot statuses inside the settings dialog.
 * Each row is a label input + on_track_upload select + remove button.
 * The DOM is the source of truth for the form state — the submit handler
 * reads it back via `collectStatusRows`.
 */
function renderStatusRows(
  container: HTMLElement,
  statuses: PilotStatusConfig[]
) {
  container.innerHTML = "";
  for (const s of statuses) {
    container.appendChild(buildStatusRow(s));
  }
}

function buildStatusRow(
  s: PilotStatusConfig = { key: "", label: "", on_track_upload: "none" }
): HTMLElement {
  const row = document.createElement("div");
  row.className = "flex items-start gap-2";
  row.dataset.key = s.key;

  const labelInput = document.createElement("input");
  labelInput.type = "text";
  labelInput.className = "input flex-1 text-sm";
  labelInput.placeholder = "e.g. Safely landed";
  labelInput.value = s.label;
  labelInput.maxLength = 128;
  labelInput.dataset.field = "label";

  const select = document.createElement("select");
  select.className = "input text-sm w-28";
  select.dataset.field = "on_track_upload";
  for (const opt of [
    { value: "none", text: "Keep" },
    { value: "clear", text: "Clear" },
    { value: "set", text: "Set" },
  ]) {
    const option = document.createElement("option");
    option.value = opt.value;
    option.textContent = opt.text;
    if (s.on_track_upload === opt.value) option.selected = true;
    select.appendChild(option);
  }

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "btn-sm-destructive text-xs";
  removeBtn.textContent = "Remove";
  removeBtn.addEventListener("click", () => row.remove());

  row.appendChild(labelInput);
  row.appendChild(select);
  row.appendChild(removeBtn);
  return row;
}

function collectStatusRows(container: HTMLElement): PilotStatusConfig[] {
  const out: PilotStatusConfig[] = [];
  for (const row of Array.from(container.children)) {
    const el = row as HTMLElement;
    const labelInput = el.querySelector(
      'input[data-field="label"]'
    ) as HTMLInputElement | null;
    const select = el.querySelector(
      'select[data-field="on_track_upload"]'
    ) as HTMLSelectElement | null;
    if (!labelInput || !select) continue;
    const label = labelInput.value.trim();
    if (!label) continue;
    // Preserve existing key when present (so the server sees it as an
    // update, not a remove+add pair); otherwise derive one from the label.
    const existingKey = el.dataset.key || "";
    const key = existingKey || slugifyStatusKey(label);
    if (!key) continue;
    out.push({
      key,
      label,
      on_track_upload: select.value as PilotStatusConfig["on_track_upload"],
    });
  }
  return out;
}

function setupSettingsDialog(compId: string, comp: CompDetail) {
  const dialog = document.getElementById(
    "settings-dialog"
  ) as HTMLDialogElement;
  const form = document.getElementById("settings-form") as HTMLFormElement;
  const nameInput = document.getElementById(
    "settings-name"
  ) as HTMLInputElement;
  const pilotClassesInput = document.getElementById(
    "settings-pilot-classes"
  ) as HTMLInputElement;
  const defaultClassSelect = document.getElementById(
    "settings-default-class"
  ) as unknown as HTMLSelectElement;
  const closeDateInput = document.getElementById(
    "settings-close-date"
  ) as HTMLInputElement;
  const testCheckbox = document.getElementById(
    "settings-test"
  ) as HTMLInputElement;
  const openUploadCheckbox = document.getElementById(
    "settings-open-upload"
  ) as HTMLInputElement;
  const adminsInput = document.getElementById(
    "settings-admins"
  ) as HTMLInputElement;
  const submitBtn = document.getElementById(
    "settings-submit-btn"
  ) as HTMLButtonElement;
  const statusesList = document.getElementById(
    "settings-statuses-list"
  ) as HTMLElement;
  const addStatusBtn = document.getElementById(
    "settings-add-status-btn"
  ) as HTMLButtonElement;

  addStatusBtn.addEventListener("click", () => {
    statusesList.appendChild(buildStatusRow());
  });

  // Update default class dropdown when pilot classes change
  function updateDefaultClassOptions() {
    const classes = pilotClassesInput.value
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const currentDefault = defaultClassSelect.value;
    defaultClassSelect.innerHTML = "";
    for (const cls of classes) {
      const opt = document.createElement("option");
      opt.value = cls;
      opt.textContent = cls;
      if (cls === currentDefault) opt.selected = true;
      defaultClassSelect.appendChild(opt);
    }
  }

  pilotClassesInput.addEventListener("input", updateDefaultClassOptions);

  document
    .getElementById("comp-settings-btn")!
    .addEventListener("click", () => {
      // Populate form with current values
      nameInput.value = comp.name;
      (
        form.querySelector(
          `input[name="settings-category"][value="${comp.category}"]`
        ) as HTMLInputElement
      ).checked = true;
      pilotClassesInput.value = comp.pilot_classes.join(", ");
      closeDateInput.value = comp.close_date
        ? comp.close_date.split("T")[0]
        : "";
      testCheckbox.checked = comp.test;
      openUploadCheckbox.checked = comp.open_igc_upload ?? true;
      adminsInput.value = comp.admins.map((a) => a.email).join(", ");

      // Populate default class dropdown
      updateDefaultClassOptions();
      defaultClassSelect.value = comp.default_pilot_class;

      renderStatusRows(statusesList, comp.pilot_statuses ?? []);

      dialog.showModal();
    });

  document
    .getElementById("settings-cancel-btn")!
    .addEventListener("click", () => {
      dialog.close();
    });

  document
    .getElementById("comp-delete-btn")!
    .addEventListener("click", async () => {
      if (!confirm("Delete this competition and all its tasks and tracks? This cannot be undone.")) return;
      try {
        const res = await api.api.comp[":comp_id"].$delete({
          param: { comp_id: compId },
        });
        if (!res.ok) {
          const err = (await res.json()) as { error?: string };
          alert(err.error || "Failed to delete competition");
          return;
        }
        window.location.href = "/comp";
      } catch {
        alert("Network error. Please try again.");
      }
    });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving...";

    const name = nameInput.value.trim();
    const category = (
      form.querySelector(
        'input[name="settings-category"]:checked'
      ) as HTMLInputElement
    ).value as "hg" | "pg";
    const pilotClasses = pilotClassesInput.value
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const defaultPilotClass = defaultClassSelect.value;
    const closeDate = closeDateInput.value || null;
    const test = testCheckbox.checked;
    const openIgcUpload = openUploadCheckbox.checked;
    const adminEmails = adminsInput.value
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    if (pilotClasses.length === 0) {
      alert("At least one pilot class is required");
      submitBtn.disabled = false;
      submitBtn.textContent = "Save";
      return;
    }

    if (adminEmails.length === 0) {
      alert("At least one admin email is required");
      submitBtn.disabled = false;
      submitBtn.textContent = "Save";
      return;
    }

    const pilotStatuses = collectStatusRows(statusesList);
    // Guard against duplicate keys — can happen if an admin types a new
    // label that slugifies to the same key as an existing row.
    const keySeen = new Set<string>();
    for (const s of pilotStatuses) {
      if (keySeen.has(s.key)) {
        alert(`Duplicate status key "${s.key}" — rename one of the rows`);
        submitBtn.disabled = false;
        submitBtn.textContent = "Save";
        return;
      }
      keySeen.add(s.key);
    }

    try {
      const res = await api.api.comp[":comp_id"].$patch({
        param: { comp_id: compId },
        json: {
          name,
          category,
          pilot_classes: pilotClasses,
          default_pilot_class: defaultPilotClass,
          close_date: closeDate,
          test,
          open_igc_upload: openIgcUpload,
          admin_emails: adminEmails,
          pilot_statuses: pilotStatuses,
        },
      });

      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        alert(err.error || "Failed to update competition");
        return;
      }

      dialog.close();
      // Reload to reflect changes
      window.location.reload();
    } catch {
      alert("Network error. Please try again.");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Save";
    }
  });
}

// ── Not found ────────────────────────────────────────────────────────────────

function showNotFound() {
  const page = document.getElementById("comp-detail-page")!;
  page.classList.remove("hidden");
  document.getElementById("comp-loading")!.classList.add("hidden");
  document.getElementById("comp-not-found")!.classList.remove("hidden");
}

init();
