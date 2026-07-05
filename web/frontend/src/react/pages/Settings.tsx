/** Account settings (API keys, superadmin links) — React port of settings.ts. */
import { useCallback, useEffect, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Field } from "@base-ui/react/field";
import { Input } from "@base-ui/react/input";
import { toast } from "../lib/toast";
import { useConfirm } from "../lib/confirm";
import { signInWithGoogle, useUser } from "../lib/user";

interface ApiKey {
  id: string;
  name: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string | null;
}

export function Settings() {
  const { user, loading } = useUser();
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);

  useEffect(() => {
    document.title = "GlideComp - Settings";
    if (!user) return;
    // Cheap check (no DB query); the actual admin pages fetch on navigation.
    (async () => {
      try {
        const res = await fetch("/api/admin/whoami", { credentials: "include" });
        if (!res.ok) return;
        const data = (await res.json()) as { is_super_admin: boolean };
        setIsSuperAdmin(data.is_super_admin);
      } catch {
        /* not signed in / network error — leave the section hidden */
      }
    })();
  }, [user]);

  if (loading) return <p role="status">Loading…</p>;

  if (!user) {
    return (
      <section>
        <h1>Settings</h1>
        <p>Sign in to manage your account</p>
        <button type="button" onClick={() => signInWithGoogle()}>
          Sign in with Google
        </button>
      </section>
    );
  }

  return (
    <section>
      <h1>Settings</h1>
      <ApiKeysSection />
      {isSuperAdmin ? (
        <section>
          <h2>Superadmin</h2>
          <ul>
            <li>
              <a href="/admin/users">Users</a>
            </li>
            <li>
              <a href="/admin/cache">Cache</a>
            </li>
          </ul>
        </section>
      ) : null}
    </section>
  );
}

function ApiKeysSection() {
  const confirm = useConfirm();
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [keyName, setKeyName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const loadKeys = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch("/api/auth/api-key/list", { credentials: "include" });
      if (!res.ok) {
        setLoadError("Failed to load API keys.");
        return;
      }
      const data = (await res.json()) as { apiKeys: ApiKey[] };
      setKeys(data.apiKeys);
    } catch {
      setLoadError("Network error loading API keys.");
    }
  }, []);

  useEffect(() => {
    void loadKeys();
  }, [loadKeys]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const res = await fetch("/api/auth/api-key/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: keyName.trim() || undefined }),
      });
      if (!res.ok) {
        toast.error("Failed to create API key. Please try again.");
        return;
      }
      const data = (await res.json()) as { key: string };
      setCreateOpen(false);
      setCopied(false);
      setCreatedKey(data.key);
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(keyId: string) {
    const confirmed = await confirm({
      title: "Revoke this API key?",
      message: "Agents using this key will lose access immediately.",
      confirmLabel: "Revoke",
      destructive: true,
    });
    if (!confirmed) return;
    setRevokingId(keyId);
    try {
      const res = await fetch("/api/auth/api-key/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ keyId }),
      });
      if (!res.ok) {
        toast.error("Failed to revoke key. Please try again.");
        return;
      }
      await loadKeys();
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <section>
      <h2>API Keys</h2>
      <button
        type="button"
        onClick={() => {
          setKeyName("");
          setCreateOpen(true);
        }}
      >
        Create API key
      </button>

      {loadError ? (
        <p role="alert">{loadError}</p>
      ) : keys === null ? (
        <p role="status">Loading API keys…</p>
      ) : keys.length === 0 ? (
        <p>No API keys yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Label</th>
              <th>Created</th>
              <th>Last used</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key.id}>
                <td>{key.name ?? <em>Unnamed</em>}</td>
                <td>{new Date(key.createdAt).toLocaleDateString()}</td>
                <td>{key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleDateString() : "Never"}</td>
                <td>
                  <button
                    type="button"
                    disabled={revokingId === key.id}
                    onClick={() => handleRevoke(key.id)}
                  >
                    {revokingId === key.id ? "Revoking..." : "Revoke"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Dialog.Root open={createOpen} onOpenChange={setCreateOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="Dialog-backdrop" />
          <Dialog.Popup className="Dialog-popup">
            <Dialog.Title className="Dialog-title">Create API key</Dialog.Title>
            <form onSubmit={handleCreate}>
              <Field.Root className="Field">
                <Field.Label className="Field-label">Label (optional)</Field.Label>
                <Input
                  value={keyName}
                  onChange={(e) => setKeyName(e.target.value)}
                  placeholder="e.g. My scoring agent"
                  autoFocus
                />
              </Field.Root>
              <div className="Dialog-actions">                <Dialog.Close>Cancel</Dialog.Close>
                <button type="submit" disabled={creating}>
                  {creating ? "Creating..." : "Create"}
                </button>
              </div>
            </form>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={createdKey !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreatedKey(null);
            void loadKeys();
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="Dialog-backdrop" />
          <Dialog.Popup className="Dialog-popup">
            <Dialog.Title className="Dialog-title">API key created</Dialog.Title>
            <Dialog.Description className="Dialog-description">
              Copy this key now — it won't be shown again.
            </Dialog.Description>
            <code>{createdKey}</code>
            <div>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(createdKey ?? "").then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
              >
                {copied ? "Copied!" : "Copy"}
              </button>
              <Dialog.Close>Done</Dialog.Close>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
