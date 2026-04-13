import './theme';
import { signInWithGoogle } from "./auth/client";
import { initNav } from "./nav";
import { api } from "./comp/api";

interface PilotProfile {
  name: string;
  civl_id: string | null;
  safa_id: string | null;
  ushpa_id: string | null;
  bhpa_id: string | null;
  dhv_id: string | null;
  ffvl_id: string | null;
  fai_id: string | null;
  phone: string | null;
  glider: string | null;
}

const PROFILE_FIELDS = [
  { key: "name", el: "profile-name" },
  { key: "civl_id", el: "profile-civl" },
  { key: "safa_id", el: "profile-safa" },
  { key: "ushpa_id", el: "profile-ushpa" },
  { key: "bhpa_id", el: "profile-bhpa" },
  { key: "dhv_id", el: "profile-dhv" },
  { key: "ffvl_id", el: "profile-ffvl" },
  { key: "fai_id", el: "profile-fai" },
  { key: "phone", el: "profile-phone" },
  { key: "glider", el: "profile-glider" },
] as const;

async function init() {
  const user = await initNav({ active: "profile" });
  document.getElementById("profile-page")!.classList.remove("hidden");

  if (!user) {
    document.getElementById("profile-loading")!.classList.add("hidden");
    document.getElementById("profile-signed-out")!.classList.remove("hidden");
    document.getElementById("profile-signin-btn")!.addEventListener("click", () => signInWithGoogle());
    return;
  }

  document.title = `GlideComp - Profile`;

  // Load profile
  let profile: PilotProfile;
  try {
    const res = await api.api.comp.pilot.$get();
    if (!res.ok) {
      showError("Failed to load profile");
      return;
    }
    profile = (await res.json()) as PilotProfile;
  } catch {
    showError("Network error loading profile");
    return;
  }

  // Populate form
  for (const field of PROFILE_FIELDS) {
    const el = document.getElementById(field.el) as HTMLInputElement;
    el.value = (profile[field.key] as string | null) ?? "";
  }

  document.getElementById("profile-loading")!.classList.add("hidden");
  document.getElementById("profile-content")!.classList.remove("hidden");

  // Wire save
  const form = document.getElementById("profile-form") as HTMLFormElement;
  const saveBtn = document.getElementById("profile-save-btn") as HTMLButtonElement;
  const statusEl = document.getElementById("profile-status")!;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";
    statusEl.classList.add("hidden");

    /**
     * Build a sparse PATCH payload: every field is sent (the server treats
     * missing fields as unchanged). Empty-string inputs are normalised to
     * null so cleared IDs are persisted as nulls rather than empty strings.
     */
    const payload: Record<string, string | null> = {};
    for (const field of PROFILE_FIELDS) {
      const el = document.getElementById(field.el) as HTMLInputElement;
      const value = el.value.trim();
      payload[field.key] = value === "" ? null : value;
    }
    // Name is required — don't send null
    if (payload.name === null) {
      showStatus("Display name is required", "error");
      saveBtn.disabled = false;
      saveBtn.textContent = "Save profile";
      return;
    }

    try {
      const res = await api.api.comp.pilot.$patch({
        json: payload as never,
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        showStatus(err.error || "Failed to save profile", "error");
        return;
      }
      showStatus(
        "Profile saved. Any matching competition registrations have been linked to this account.",
        "success"
      );
    } catch {
      showStatus("Network error. Please try again.", "error");
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save profile";
    }
  });

  function showStatus(message: string, kind: "success" | "error") {
    statusEl.textContent = message;
    statusEl.classList.remove("hidden", "bg-destructive/10", "text-destructive", "bg-green-500/10", "text-green-500");
    if (kind === "error") {
      statusEl.classList.add("bg-destructive/10", "text-destructive");
    } else {
      statusEl.classList.add("bg-green-500/10", "text-green-500");
    }
  }

  // --- API Key Management ---

  interface ApiKey {
    id: string;
    name: string | null;
    createdAt: string;
    updatedAt: string;
    lastUsedAt?: string | null;
  }

  const apiKeysList = document.getElementById("api-keys-list")!;
  const createKeyDialog = document.getElementById("create-key-dialog") as HTMLDialogElement;
  const createKeyForm = document.getElementById("create-key-form") as HTMLFormElement;
  const keyNameInput = document.getElementById("key-name-input") as HTMLInputElement;
  const createKeySubmitBtn = document.getElementById("create-key-submit-btn") as HTMLButtonElement;
  const createdDialog = document.getElementById("api-key-created-dialog") as HTMLDialogElement;

  async function loadApiKeys() {
    apiKeysList.innerHTML = '<p class="text-sm text-muted-foreground">Loading...</p>';
    try {
      const res = await fetch("/api/auth/api-key/list", { credentials: "include" });
      if (!res.ok) {
        apiKeysList.innerHTML = '<p class="text-sm text-destructive">Failed to load API keys.</p>';
        return;
      }
      const keys = (await res.json()) as ApiKey[];
      renderApiKeys(keys);
    } catch {
      apiKeysList.innerHTML = '<p class="text-sm text-destructive">Network error loading API keys.</p>';
    }
  }

  function renderApiKeys(keys: ApiKey[]) {
    if (keys.length === 0) {
      apiKeysList.innerHTML = '<p class="text-sm text-muted-foreground">No API keys yet.</p>';
      return;
    }

    const rows = keys.map((key) => {
      const created = new Date(key.createdAt).toLocaleDateString();
      const lastUsed = key.lastUsedAt
        ? new Date(key.lastUsedAt).toLocaleDateString()
        : "Never";
      const label = key.name ? escapeHtml(key.name) : '<span class="text-muted-foreground italic">Unnamed</span>';
      return `<tr class="border-b border-border last:border-0">
        <td class="py-2 pr-4 text-sm">${label}</td>
        <td class="py-2 pr-4 text-sm text-muted-foreground">${created}</td>
        <td class="py-2 pr-4 text-sm text-muted-foreground">${lastUsed}</td>
        <td class="py-2 text-right">
          <button class="btn btn-destructive btn-sm revoke-key-btn" data-key-id="${escapeAttr(key.id)}">Revoke</button>
        </td>
      </tr>`;
    }).join("");

    apiKeysList.innerHTML = `<table class="w-full mb-2">
      <thead>
        <tr class="border-b border-border">
          <th class="text-left text-xs font-medium text-muted-foreground pb-2 pr-4">Label</th>
          <th class="text-left text-xs font-medium text-muted-foreground pb-2 pr-4">Created</th>
          <th class="text-left text-xs font-medium text-muted-foreground pb-2 pr-4">Last used</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;

    apiKeysList.querySelectorAll<HTMLButtonElement>(".revoke-key-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const keyId = btn.dataset.keyId!;
        btn.disabled = true;
        btn.textContent = "Revoking...";
        await deleteApiKey(keyId);
      });
    });
  }

  async function deleteApiKey(keyId: string) {
    try {
      const res = await fetch("/api/auth/api-key/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ keyId }),
      });
      if (!res.ok) {
        alert("Failed to revoke key. Please try again.");
        return;
      }
    } catch {
      alert("Network error. Please try again.");
      return;
    }
    await loadApiKeys();
  }

  function showCreatedDialog(plainKey: string) {
    const keyEl = document.getElementById("api-key-value")!;
    keyEl.textContent = plainKey;

    const snippet = JSON.stringify(
      {
        mcpServers: {
          glidecomp: {
            url: "https://glidecomp.com/mcp",
            headers: { Authorization: `Bearer ${plainKey}` },
          },
        },
      },
      null,
      2
    );
    document.getElementById("api-key-config-snippet")!.textContent = snippet;

    createdDialog.showModal();
  }

  function copyWithFeedback(btn: HTMLButtonElement, text: string) {
    navigator.clipboard.writeText(text).then(() => {
      const original = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(() => { btn.textContent = original; }, 1500);
    });
  }

  // Wire copy buttons in created dialog
  document.getElementById("copy-key-btn")!.addEventListener("click", (e) => {
    const key = document.getElementById("api-key-value")!.textContent ?? "";
    copyWithFeedback(e.currentTarget as HTMLButtonElement, key);
  });
  document.getElementById("copy-url-btn")!.addEventListener("click", (e) => {
    copyWithFeedback(e.currentTarget as HTMLButtonElement, "https://glidecomp.com/mcp");
  });
  document.getElementById("copy-snippet-btn")!.addEventListener("click", (e) => {
    const snippet = document.getElementById("api-key-config-snippet")!.textContent ?? "";
    copyWithFeedback(e.currentTarget as HTMLButtonElement, snippet);
  });

  document.getElementById("api-key-created-close-btn")!.addEventListener("click", () => {
    createdDialog.close();
    void loadApiKeys();
  });

  // Open create-key dialog
  document.getElementById("create-api-key-btn")!.addEventListener("click", () => {
    keyNameInput.value = "";
    createKeyDialog.showModal();
  });
  document.getElementById("create-key-cancel-btn")!.addEventListener("click", () => {
    createKeyDialog.close();
  });

  createKeyForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    createKeySubmitBtn.disabled = true;
    createKeySubmitBtn.textContent = "Creating...";

    try {
      const name = keyNameInput.value.trim() || undefined;
      const res = await fetch("/api/auth/api-key/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        alert("Failed to create API key. Please try again.");
        return;
      }
      const data = (await res.json()) as { key: string };
      createKeyDialog.close();
      showCreatedDialog(data.key);
    } catch {
      alert("Network error. Please try again.");
    } finally {
      createKeySubmitBtn.disabled = false;
      createKeySubmitBtn.textContent = "Create";
    }
  });

  void loadApiKeys();
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(str: string): string {
  return str.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function showError(message: string) {
  document.getElementById("profile-loading")!.classList.add("hidden");
  const empty = document.getElementById("profile-signed-out")!;
  empty.classList.remove("hidden");
  empty.querySelector("p")!.textContent = message;
}

init();
