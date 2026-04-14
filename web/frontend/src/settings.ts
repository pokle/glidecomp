import './theme';
import { signInWithGoogle } from "./auth/client";
import { initNav } from "./nav";

interface ApiKey {
  id: string;
  name: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string | null;
}

async function init() {
  const user = await initNav({ active: "settings" });
  document.getElementById("settings-page")!.classList.remove("hidden");

  if (!user) {
    document.getElementById("settings-loading")!.classList.add("hidden");
    document.getElementById("settings-signed-out")!.classList.remove("hidden");
    document.getElementById("settings-signin-btn")!.addEventListener("click", () => signInWithGoogle());
    return;
  }

  document.getElementById("settings-loading")!.classList.add("hidden");
  document.getElementById("settings-content")!.classList.remove("hidden");

  // --- API Key Management ---

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

init();
