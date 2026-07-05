/** Account settings (API keys, superadmin links) — React port of settings.ts. */
import { useCallback, useEffect, useId, useState } from "react";
import { Button } from "@/react/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/react/ui/dialog";
import { Field, FieldLabel } from "@/react/ui/field";
import { Input } from "@/react/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/react/ui/table";
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
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-muted-foreground">Sign in to manage your account</p>
        <Button type="button" className="mt-4" onClick={() => signInWithGoogle()}>
          Sign in with Google
        </Button>
      </section>
    );
  }

  return (
    <section>
      <h1 className="text-2xl font-bold">Settings</h1>
      <ApiKeysSection />
      {isSuperAdmin ? (
        <section>
          <h2 className="mt-8 text-lg font-bold">Superadmin</h2>
          <ul className="mt-2 list-inside list-disc">
            <li>
              <a href="/admin/users" className="underline underline-offset-4">
                Users
              </a>
            </li>
            <li>
              <a href="/admin/cache" className="underline underline-offset-4">
                Cache
              </a>
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
  const keyNameId = useId();

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
      <h2 className="mt-8 text-lg font-bold">API Keys</h2>
      <Button
        type="button"
        className="mt-2"
        onClick={() => {
          setKeyName("");
          setCreateOpen(true);
        }}
      >
        Create API key
      </Button>

      {loadError ? (
        <p role="alert" className="mt-4">
          {loadError}
        </p>
      ) : keys === null ? (
        <p role="status" className="mt-4 text-muted-foreground">
          Loading API keys…
        </p>
      ) : keys.length === 0 ? (
        <p className="mt-4 text-muted-foreground">No API keys yet.</p>
      ) : (
        <div className="mt-4 rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Label</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((key) => (
                <TableRow key={key.id}>
                  <TableCell>{key.name ?? <em>Unnamed</em>}</TableCell>
                  <TableCell>{new Date(key.createdAt).toLocaleDateString()}</TableCell>
                  <TableCell>
                    {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleDateString() : "Never"}
                  </TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={revokingId === key.id}
                      onClick={() => handleRevoke(key.id)}
                    >
                      {revokingId === key.id ? "Revoking..." : "Revoke"}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create API key</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreate} className="flex flex-col gap-4">
            <Field>
              <FieldLabel htmlFor={keyNameId}>Label (optional)</FieldLabel>
              <Input
                id={keyNameId}
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
                placeholder="e.g. My scoring agent"
                autoFocus
              />
            </Field>
            <DialogFooter>
              <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
              <Button type="submit" disabled={creating}>
                {creating ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={createdKey !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreatedKey(null);
            void loadKeys();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>API key created</DialogTitle>
            <DialogDescription>
              Copy this key now — it won't be shown again.
            </DialogDescription>
          </DialogHeader>
          <code className="block rounded-md border bg-muted px-3 py-2 font-mono text-sm break-all">
            {createdKey}
          </code>
          <DialogFooter>
            <Button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(createdKey ?? "").then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? "Copied!" : "Copy"}
            </Button>
            <DialogClose render={<Button variant="outline" />}>Done</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
