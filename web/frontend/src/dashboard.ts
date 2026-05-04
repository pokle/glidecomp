import './theme';
import { signInWithGoogle, deleteAccount } from "./auth/client";
import { initNav } from "./nav";
import { storage, type StoredTask, type StoredTrack } from "./analysis/storage";
import { parseIGC, parseXCTask, sanitizeText } from "@glidecomp/engine";

// ── Relative time formatting ──────────────────────────────────────────────

function relativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

// ── File download ─────────────────────────────────────────────────────────

function downloadFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ── Card rendering ────────────────────────────────────────────────────────

function createTrackCard(track: StoredTrack, index: number): HTMLElement {
  const card = document.createElement("a");
  card.href = `/analysis.html?storedTrack=${encodeURIComponent(track.id)}`;
  card.className = "file-card file-card-track card-enter";
  card.style.animationDelay = `${index * 40}ms`;

  const meta: string[] = [];
  if (track.summary.glider) meta.push(sanitizeText(track.summary.glider));
  meta.push(sanitizeText(track.filename));

  card.innerHTML = `
    <div class="flex-1 min-w-0">
      <div class="font-medium text-sm text-foreground truncate">${sanitizeText(track.name)}</div>
      <div class="text-xs text-muted-foreground mt-0.5 truncate">${meta.join(" &middot; ")}</div>
    </div>
    <div class="flex items-center gap-2 shrink-0">
      <span class="text-xs text-muted-foreground/60">${relativeTime(track.lastAccessedAt)}</span>
      <button class="download-btn" data-track-id="${track.id}" title="Download IGC" aria-label="Download IGC">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
      </button>
      <button class="delete-btn" data-track-id="${track.id}" title="Remove track" aria-label="Remove track">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
  `;
  return card;
}

function createTaskCard(task: StoredTask, index: number): HTMLElement {
  const card = document.createElement("a");
  card.href = `/analysis.html?storedTask=${encodeURIComponent(task.id)}`;
  card.className = "file-card file-card-task card-enter";
  card.style.animationDelay = `${index * 40}ms`;

  const tpCount = task.task.turnpoints.length;

  card.innerHTML = `
    <div class="flex-1 min-w-0">
      <div class="font-medium text-sm text-foreground truncate">${sanitizeText(task.name)}</div>
      <div class="text-xs text-muted-foreground mt-0.5">${tpCount} turnpoint${tpCount !== 1 ? "s" : ""} &middot; ${sanitizeText(task.id)}</div>
    </div>
    <div class="flex items-center gap-2 shrink-0">
      <span class="text-xs text-muted-foreground/60">${relativeTime(task.lastAccessedAt)}</span>
      <button class="download-btn" data-task-id="${task.id}" title="Download XCTSK" aria-label="Download XCTSK">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
      </button>
      <button class="delete-btn" data-task-id="${task.id}" title="Remove task" aria-label="Remove task">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
  `;
  return card;
}

// ── Main init ─────────────────────────────────────────────────────────────

async function init() {
  const user = await initNav({ active: "flights" });

  if (!user) {
    signInWithGoogle();
    return;
  }

  if (!user.username) {
    window.location.href = "/onboarding.html";
    return;
  }

  // Redirect /u/me/ to the user's actual page
  if (window.location.pathname === "/u/me/") {
    window.location.replace(`/u/${user.username}/`);
    return;
  }

  // Show dashboard
  const container = document.getElementById("dashboard")!;
  container.classList.remove("hidden");

  // Initialize storage
  await storage.init();

  // DOM refs
  const tracksList = document.getElementById("tracks-list")!;
  const tasksList = document.getElementById("tasks-list")!;
  const tracksEmpty = document.getElementById("tracks-empty")!;
  const tasksEmpty = document.getElementById("tasks-empty")!;
  const tracksCount = document.getElementById("tracks-count")!;
  const tasksCount = document.getElementById("tasks-count")!;
  const tabTracks = document.getElementById("tab-tracks")!;
  const tabTasks = document.getElementById("tab-tasks")!;
  const panelTracks = document.getElementById("panel-tracks")!;
  const panelTasks = document.getElementById("panel-tasks")!;
  const igcInput = document.getElementById("igc-file-input") as HTMLInputElement;
  const taskInput = document.getElementById("task-file-input") as HTMLInputElement;
  const dropZone = document.getElementById("drop-zone")!;

  // ── Render lists ──────────────────────────────────────────────────────

  async function refreshLists() {
    const [tracks, tasks] = await Promise.all([
      storage.listTracks(),
      storage.listTasks(),
    ]);

    // Tracks
    tracksList.innerHTML = "";
    if (tracks.length > 0) {
      tracksEmpty.classList.add("hidden");
      tracksCount.textContent = String(tracks.length);
      tracksCount.classList.remove("hidden");
      tracks.forEach((t, i) => tracksList.appendChild(createTrackCard(t, i)));
    } else {
      tracksEmpty.classList.remove("hidden");
      tracksCount.classList.add("hidden");
    }

    // Tasks
    tasksList.innerHTML = "";
    if (tasks.length > 0) {
      tasksEmpty.classList.add("hidden");
      tasksCount.textContent = String(tasks.length);
      tasksCount.classList.remove("hidden");
      tasks.forEach((t, i) => tasksList.appendChild(createTaskCard(t, i)));
    } else {
      tasksEmpty.classList.remove("hidden");
      tasksCount.classList.add("hidden");
    }
  }

  await refreshLists();

  // ── Tab switching ─────────────────────────────────────────────────────

  function switchTab(tab: "tracks" | "tasks") {
    const isTracksActive = tab === "tracks";
    tabTracks.classList.toggle("tab-btn-active", isTracksActive);
    tabTracks.setAttribute("aria-selected", String(isTracksActive));
    tabTasks.classList.toggle("tab-btn-active", !isTracksActive);
    tabTasks.setAttribute("aria-selected", String(!isTracksActive));
    panelTracks.classList.toggle("hidden", !isTracksActive);
    panelTasks.classList.toggle("hidden", isTracksActive);
  }

  tabTracks.addEventListener("click", () => switchTab("tracks"));
  tabTasks.addEventListener("click", () => switchTab("tasks"));

  // ── File upload ───────────────────────────────────────────────────────

  async function handleFiles(files: FileList | File[]) {
    let addedTracks = false;
    let addedTasks = false;

    for (const file of files) {
      const name = file.name.toLowerCase();
      try {
        if (name.endsWith(".igc")) {
          const content = await file.text();
          const igcFile = parseIGC(content);
          await storage.storeTrack(file.name, content, igcFile);
          addedTracks = true;
        } else if (name.endsWith(".xctsk")) {
          const content = await file.text();
          const task = parseXCTask(content);
          // Use filename (without extension) as the task code for local files
          const code = file.name.replace(/\.xctsk$/i, "").toLowerCase().replace(/\s+/g, "-");
          await storage.storeTask(code, task, content);
          addedTasks = true;
        }
      } catch (err) {
        console.error(`Failed to parse ${file.name}:`, err);
      }
    }

    if (addedTracks || addedTasks) {
      await refreshLists();
      // Switch to the tab that had files added
      if (addedTasks && !addedTracks) switchTab("tasks");
    }
  }

  igcInput.addEventListener("change", async () => {
    if (igcInput.files?.length) {
      await handleFiles(igcInput.files);
      igcInput.value = "";
    }
  });

  taskInput.addEventListener("change", async () => {
    if (taskInput.files?.length) {
      await handleFiles(taskInput.files);
      taskInput.value = "";
    }
  });

  // ── Drag and drop (full page) ─────────────────────────────────────────

  document.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("drag-over");
  });

  document.addEventListener("dragleave", (e) => {
    if (e.relatedTarget === null) {
      dropZone.classList.remove("drag-over");
    }
  });

  document.addEventListener("drop", async (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    const files = e.dataTransfer?.files;
    if (files?.length) {
      await handleFiles(files);
    }
  });

  // ── Item action handlers (event delegation) ──────────────────────────

  tracksList.addEventListener("click", async (e) => {
    const target = e.target as HTMLElement;
    const downloadBtn = target.closest(".download-btn") as HTMLElement | null;
    if (downloadBtn) {
      e.preventDefault();
      e.stopPropagation();
      const trackId = downloadBtn.dataset.trackId;
      if (trackId) {
        const stored = await storage.getTrack(trackId);
        if (stored) downloadFile(stored.filename, stored.content, "application/octet-stream");
      }
      return;
    }
    const deleteBtn = target.closest(".delete-btn") as HTMLElement | null;
    if (deleteBtn) {
      e.preventDefault();
      e.stopPropagation();
      const trackId = deleteBtn.dataset.trackId;
      if (trackId) {
        await storage.deleteTrack(trackId);
        await refreshLists();
      }
    }
  });

  tasksList.addEventListener("click", async (e) => {
    const target = e.target as HTMLElement;
    const downloadBtn = target.closest(".download-btn") as HTMLElement | null;
    if (downloadBtn) {
      e.preventDefault();
      e.stopPropagation();
      const taskId = downloadBtn.dataset.taskId;
      if (taskId) {
        const stored = await storage.getTask(taskId);
        if (stored) downloadFile(`${stored.id}.xctsk`, stored.rawJson, "application/xctsk+json");
      }
      return;
    }
    const deleteBtn = target.closest(".delete-btn") as HTMLElement | null;
    if (deleteBtn) {
      e.preventDefault();
      e.stopPropagation();
      const taskId = deleteBtn.dataset.taskId;
      if (taskId) {
        await storage.deleteTask(taskId);
        await refreshLists();
      }
    }
  });

  // ── Delete account ────────────────────────────────────────────────────

  const deleteDialog = document.getElementById("delete-account-dialog") as HTMLDialogElement;

  document.getElementById("delete-account-btn")?.addEventListener("click", () => {
    deleteDialog.showModal();
  });

  document.getElementById("delete-cancel-btn")?.addEventListener("click", () => {
    deleteDialog.close();
  });

  document.getElementById("delete-confirm-btn")?.addEventListener("click", async (e) => {
    const btn = e.target as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "Deleting...";

    const result = await deleteAccount();
    if (result.success) {
      localStorage.clear();
      storage.close();
      indexedDB.deleteDatabase("glidecomp");
      window.location.href = "/";
    } else {
      btn.disabled = false;
      btn.textContent = "Delete my account";
      alert(result.error || "Failed to delete account. Please try again.");
    }
  });
}

init();
