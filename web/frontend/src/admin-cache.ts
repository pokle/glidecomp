import './theme';
import { signInWithGoogle } from "./auth/client";
import { initNav } from "./nav";
import { confirmDialog, toast } from "./feedback";

interface NamespaceStats {
  name: string;
  item_count: number;
  by_prefix: Record<string, number>;
}

interface CacheStats {
  total_items: number;
  namespaces: NamespaceStats[];
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderNamespace(ns: NamespaceStats): string {
  const prefixRows = Object.entries(ns.by_prefix)
    .sort(([, a], [, b]) => b - a)
    .map(
      ([label, count]) =>
        `<div class="flex justify-between py-1 text-sm">
           <span class="text-muted-foreground">${escapeHtml(label)}</span>
           <span>${count}</span>
         </div>`
    )
    .join("");

  return `<div class="p-4 rounded-lg border border-border bg-card">
    <div class="flex justify-between items-baseline mb-2">
      <h2 class="font-medium">${escapeHtml(ns.name)}</h2>
      <span class="text-sm text-muted-foreground">${ns.item_count} item${ns.item_count !== 1 ? "s" : ""}</span>
    </div>
    ${prefixRows || '<p class="text-sm text-muted-foreground italic">Empty</p>'}
  </div>`;
}

function renderStats(stats: CacheStats) {
  document.getElementById("admin-cache-total")!.textContent = String(stats.total_items);
  document.getElementById("admin-cache-namespaces")!.innerHTML =
    stats.namespaces.map(renderNamespace).join("");
}

function showError(message: string) {
  document.getElementById("admin-cache-loading")!.classList.add("hidden");
  const el = document.getElementById("admin-cache-error")!;
  el.classList.remove("hidden");
  document.getElementById("admin-cache-error-text")!.textContent = message;
}

async function loadStats(): Promise<CacheStats | null> {
  try {
    const res = await fetch("/api/admin/cache/stats", { credentials: "include" });
    if (res.status === 403) {
      showError("You don't have access to this page.");
      return null;
    }
    if (!res.ok) {
      showError("Failed to load cache stats.");
      return null;
    }
    return (await res.json()) as CacheStats;
  } catch {
    showError("Network error loading cache stats.");
    return null;
  }
}

async function handleClear() {
  const confirmed = await confirmDialog({
    title: "Clear entire cache?",
    message:
      "This deletes every cached score, comp score, and flight analysis. The next request for each will recompute from scratch — pages may load slower until the cache warms back up.",
    confirmLabel: "Clear cache",
    destructive: true,
  });
  if (!confirmed) return;

  const button = document.getElementById("admin-cache-clear-btn") as HTMLButtonElement;
  button.disabled = true;
  const status = document.getElementById("admin-cache-status")!;
  status.textContent = "Clearing…";

  try {
    const res = await fetch("/api/admin/cache", {
      method: "DELETE",
      credentials: "include",
    });
    if (!res.ok) {
      toast.error("Failed to clear cache.");
      status.textContent = "";
      return;
    }
    const data = (await res.json()) as { cleared: number };
    toast.success(`Cleared ${data.cleared} cached item${data.cleared !== 1 ? "s" : ""}.`);
    status.textContent = "";

    const stats = await loadStats();
    if (stats) renderStats(stats);
  } catch {
    toast.error("Network error clearing cache.");
    status.textContent = "";
  } finally {
    button.disabled = false;
  }
}

async function init() {
  const user = await initNav();
  document.getElementById("admin-cache-page")!.classList.remove("hidden");

  if (!user) {
    document.getElementById("admin-cache-loading")!.classList.add("hidden");
    signInWithGoogle();
    return;
  }

  const stats = await loadStats();
  if (!stats) return;

  document.getElementById("admin-cache-loading")!.classList.add("hidden");
  document.getElementById("admin-cache-content")!.classList.remove("hidden");
  renderStats(stats);

  document.getElementById("admin-cache-clear-btn")!.addEventListener("click", handleClear);
}

init();
