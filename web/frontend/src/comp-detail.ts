import { getCurrentUser } from "./auth/client";
import { api } from "./comp/api";
import type { XCTask } from "@glidecomp/engine";

// ── Types ────────────────────────────────────────────────────────────────────

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

  if (taskId) {
    await initTaskDetail(compId, taskId);
  } else {
    await initCompDetail(compId);
  }
}

// ── Task detail view ─────────────────────────────────────────────────────────

async function initTaskDetail(compId: string, taskId: string) {
  const user = await getCurrentUser();

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

  // Tracks section
  await setupTrackSection(compId, taskId, user != null, isAdmin, comp?.close_date ?? null);

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
  pilot_class: string;
  uploaded_at: string;
  file_size: number;
  penalty_points: number;
  penalty_reason: string | null;
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

async function setupTrackSection(
  compId: string,
  taskId: string,
  isAuthenticated: boolean,
  isAdmin: boolean,
  closeDate: string | null
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
    document.getElementById("task-closed-badge")!.classList.remove("hidden");
  }

  // Show upload buttons for authenticated users (unless comp is closed)
  if (isAuthenticated && !isClosed) {
    setupSelfUpload(compId, taskId, isAdmin, isClosed);
  }

  // Admin: upload on behalf of a registered pilot
  if (isAdmin && !isClosed) {
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

    const penaltyBadge =
      track.penalty_points !== 0
        ? `<span class="inline-flex items-center rounded-md bg-red-500/10 text-red-500 px-1.5 py-0.5 text-xs font-medium" title="${escapeHtml(track.penalty_reason ?? "")}">${track.penalty_points > 0 ? "-" : "+"}${Math.abs(track.penalty_points)} pts</span>`
        : "";

    div.innerHTML = `
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          <span class="font-medium text-sm">${escapeHtml(track.pilot_name)}</span>
          <span class="inline-flex items-center rounded-md bg-primary/10 text-primary px-1.5 py-0.5 text-xs font-medium">${escapeHtml(track.pilot_class)}</span>
          ${penaltyBadge}
        </div>
        <div class="text-xs text-muted-foreground mt-0.5">${uploadDate} &middot; ${formatFileSize(track.file_size)}</div>
      </div>
      <div class="flex items-center gap-1 shrink-0">
        <a href="/api/comp/${encodeURIComponent(compId)}/task/${encodeURIComponent(taskId)}/igc/${encodeURIComponent(track.comp_pilot_id)}/download"
           class="btn btn-ghost btn-sm text-xs" title="Download">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </a>
      </div>
    `;

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
      deleteBtn.className = "btn btn-ghost btn-sm text-xs text-destructive";
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
      // Reload track list
      const tracks = await loadTracks(compId, taskId);
      renderTrackList(tracks, compId, taskId, isAdmin, isClosed);
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

      // Reload track list
      const tracks = await loadTracks(compId, taskId);
      renderTrackList(tracks, compId, taskId, isAdmin, isClosed);

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

// ── Comp detail view ─────────────────────────────────────────────────────────

async function initCompDetail(compId: string) {
  const user = await getCurrentUser();
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

  // Show create task button for admins
  if (isAdmin) {
    document.getElementById("create-task-btn")!.classList.remove("hidden");
  }

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
  const adminsInput = document.getElementById(
    "settings-admins"
  ) as HTMLInputElement;
  const submitBtn = document.getElementById(
    "settings-submit-btn"
  ) as HTMLButtonElement;

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
      adminsInput.value = comp.admins.map((a) => a.email).join(", ");

      // Populate default class dropdown
      updateDefaultClassOptions();
      defaultClassSelect.value = comp.default_pilot_class;

      dialog.showModal();
    });

  document
    .getElementById("settings-cancel-btn")!
    .addEventListener("click", () => {
      dialog.close();
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
          admin_emails: adminEmails,
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
