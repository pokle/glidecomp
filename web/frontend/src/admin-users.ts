import './theme';
import { signInWithGoogle } from "./auth/client";
import { initNav } from "./nav";

interface AdminUser {
  id: string;
  name: string;
  email: string;
  username: string | null;
  email_verified: boolean;
  created_at: string;
  is_super_admin: boolean;
  track_count: number;
  task_count: number;
  admin_comp_count: number;
  pilot_comp_count: number;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderRow(u: AdminUser): string {
  const joined = new Date(u.created_at).toLocaleDateString();
  const badge = u.is_super_admin
    ? '<span class="ml-2 inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">super admin</span>'
    : "";
  const usernameLine = u.username
    ? `<a href="/u/${escapeHtml(u.username)}/" class="hover:underline">@${escapeHtml(u.username)}</a>`
    : '<span class="italic">no username</span>';
  const unverified = u.email_verified
    ? ""
    : ' <span class="text-xs text-amber-600 dark:text-amber-400">(unverified)</span>';

  return `<tr class="border-b border-border last:border-0">
    <td class="py-2 pr-4">
      <div class="font-medium">${escapeHtml(u.name)}${badge}</div>
      <div class="text-xs text-muted-foreground">${usernameLine}</div>
    </td>
    <td class="py-2 pr-4 text-muted-foreground">${escapeHtml(u.email)}${unverified}</td>
    <td class="py-2 pr-4 text-muted-foreground whitespace-nowrap">${joined}</td>
    <td class="py-2 pr-4 text-right">${u.track_count}</td>
    <td class="py-2 pr-4 text-right">${u.task_count}</td>
    <td class="py-2 pr-4 text-right">${u.admin_comp_count}</td>
    <td class="py-2 text-right">${u.pilot_comp_count}</td>
  </tr>`;
}

function showError(message: string) {
  document.getElementById("admin-users-loading")!.classList.add("hidden");
  const el = document.getElementById("admin-users-error")!;
  el.classList.remove("hidden");
  document.getElementById("admin-users-error-text")!.textContent = message;
}

async function init() {
  const user = await initNav();
  document.getElementById("admin-users-page")!.classList.remove("hidden");

  if (!user) {
    document.getElementById("admin-users-loading")!.classList.add("hidden");
    signInWithGoogle();
    return;
  }

  let users: AdminUser[];
  try {
    const res = await fetch("/api/admin/users", { credentials: "include" });
    if (res.status === 403) {
      showError("You don't have access to this page.");
      return;
    }
    if (!res.ok) {
      showError("Failed to load users.");
      return;
    }
    const data = (await res.json()) as { users: AdminUser[] };
    users = data.users;
  } catch {
    showError("Network error loading users.");
    return;
  }

  document.getElementById("admin-users-loading")!.classList.add("hidden");
  document.getElementById("admin-users-content")!.classList.remove("hidden");
  document.getElementById("admin-users-count")!.textContent =
    `${users.length} registered user${users.length !== 1 ? "s" : ""}`;

  document.getElementById("admin-users-tbody")!.innerHTML =
    users.map(renderRow).join("");
}

init();
