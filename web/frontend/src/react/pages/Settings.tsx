/**
 * Account settings — pilot profile, API keys, superadmin links and the
 * delete-account danger zone. Merges the former standalone "My Profile" page
 * (React port of profile.ts) with the account settings (React port of
 * settings.ts); each concern is its own separated card.
 */
import { useCallback, useEffect, useId, useState } from "react";
import { Button } from "@/react/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/react/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/react/ui/dialog";
import { Field, FieldLabel, FieldLegend, FieldSet } from "@/react/ui/field";
import { Input } from "@/react/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/react/ui/table";
import { api } from "../../comp/api";
import { deleteAccount } from "../../auth/client";
import { storage } from "../../analysis/storage";
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
  const { user, loading, isSuperAdmin, previewRole } = useUser();

  useEffect(() => {
    document.title = "GlideComp - Settings";
  }, []);

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
    <section className="mx-auto flex max-w-3xl flex-col gap-6">
      <h1 className="text-2xl font-bold">Settings</h1>
      <ProfileSection />
      <ApiKeysSection />
      {isSuperAdmin && previewRole === "actual" ? <SuperadminSection /> : null}
      <DangerZoneSection />
    </section>
  );
}

// Names and contact details on one side, pilot registration IDs on the other —
// two groups that lay out multi-column on wider screens.
const NAME_CONTACT_FIELDS = [
  { key: "name", label: "Display name" },
  { key: "phone", label: "Phone" },
  { key: "glider", label: "Glider" },
  { key: "emergency_contact_name", label: "Emergency contact name" },
  { key: "emergency_contact_phone", label: "Emergency contact phone" },
] as const;

const ID_FIELDS = [
  { key: "civl_id", label: "CIVL ID" },
  { key: "safa_id", label: "SAFA ID" },
  { key: "ushpa_id", label: "USHPA ID" },
  { key: "bhpa_id", label: "BHPA ID" },
  { key: "dhv_id", label: "DHV ID" },
  { key: "ffvl_id", label: "FFVL ID" },
  { key: "fai_id", label: "FAI ID" },
] as const;

const PROFILE_FIELDS = [...NAME_CONTACT_FIELDS, ...ID_FIELDS] as const;

type ProfileValues = Record<(typeof PROFILE_FIELDS)[number]["key"], string>;

const EMPTY_VALUES = Object.fromEntries(
  PROFILE_FIELDS.map((f) => [f.key, ""])
) as ProfileValues;

function ProfileSection() {
  const [values, setValues] = useState<ProfileValues>(EMPTY_VALUES);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const idBase = useId();

  useEffect(() => {
    (async () => {
      try {
        const res = await api.api.comp.pilot.$get();
        if (!res.ok) {
          setState("error");
          return;
        }
        const profile = (await res.json()) as Record<string, string | null>;
        setValues(
          Object.fromEntries(
            PROFILE_FIELDS.map((f) => [f.key, profile[f.key] ?? ""])
          ) as ProfileValues
        );
        setState("ready");
      } catch {
        setState("error");
      }
    })();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);

    // Sparse PATCH payload: cleared inputs are persisted as nulls, not "".
    const payload: Record<string, string | null> = {};
    for (const field of PROFILE_FIELDS) {
      const value = values[field.key].trim();
      payload[field.key] = value === "" ? null : value;
    }
    if (payload.name === null) {
      setStatus({ kind: "error", message: "Display name is required" });
      return;
    }

    setSaving(true);
    try {
      const res = await api.api.comp.pilot.$patch({ json: payload as never });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        setStatus({ kind: "error", message: err.error || "Failed to save profile" });
        return;
      }
      setStatus({
        kind: "success",
        message:
          "Profile saved. Any matching competition registrations have been linked to this account.",
      });
    } catch {
      setStatus({ kind: "error", message: "Network error. Please try again." });
    } finally {
      setSaving(false);
    }
  }

  const renderField = (field: (typeof PROFILE_FIELDS)[number]) => (
    <Field
      key={field.key}
      // The display name reads better full-width above the paired contact rows.
      className={field.key === "name" ? "sm:col-span-2" : undefined}
    >
      <FieldLabel htmlFor={`${idBase}-${field.key}`}>{field.label}</FieldLabel>
      <Input
        id={`${idBase}-${field.key}`}
        value={values[field.key]}
        onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
        required={field.key === "name"}
      />
    </Field>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
        <CardDescription>
          Your pilot details, used when you register for competitions
        </CardDescription>
      </CardHeader>
      <CardContent>
        {state === "loading" ? (
          <p role="status" className="text-muted-foreground">
            Loading…
          </p>
        ) : state === "error" ? (
          <p role="alert">Failed to load profile</p>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-6">
            <FieldSet>
              <FieldLegend variant="label">Name &amp; contact</FieldLegend>
              <div className="grid gap-4 sm:grid-cols-2">
                {NAME_CONTACT_FIELDS.map(renderField)}
              </div>
            </FieldSet>

            <FieldSet>
              <FieldLegend variant="label">Pilot IDs</FieldLegend>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {ID_FIELDS.map(renderField)}
              </div>
            </FieldSet>

            {status ? (
              <p
                role={status.kind === "error" ? "alert" : "status"}
                className={
                  status.kind === "error"
                    ? "text-sm text-destructive"
                    : "text-sm text-muted-foreground"
                }
              >
                {status.message}
              </p>
            ) : null}

            <div>
              <Button type="submit" disabled={saving}>
                {saving ? "Saving..." : "Save profile"}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
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
    <Card>
      <CardHeader>
        <CardTitle>API keys</CardTitle>
        <CardDescription>
          Grant scoring agents programmatic access to your account.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          type="button"
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
      </CardContent>

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
    </Card>
  );
}

function SuperadminSection() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Superadmin</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="list-inside list-disc">
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
      </CardContent>
    </Card>
  );
}

function DangerZoneSection() {
  const confirm = useConfirm();
  const [deleting, setDeleting] = useState(false);

  async function handleDeleteAccount() {
    const confirmed = await confirm({
      title: "Delete Account",
      message:
        "This will permanently delete your account and all associated data. This action cannot be undone.",
      confirmLabel: "Delete my account",
      destructive: true,
    });
    if (!confirmed) return;
    setDeleting(true);
    const result = await deleteAccount();
    if (result.success) {
      localStorage.clear();
      storage.close();
      indexedDB.deleteDatabase("glidecomp");
      window.location.href = "/";
    } else {
      setDeleting(false);
      toast.error(result.error || "Failed to delete account. Please try again.");
    }
  }

  return (
    <Card className="border-destructive/40 ring-destructive/20">
      <CardHeader>
        <CardTitle>Danger zone</CardTitle>
        <CardDescription>
          Permanently delete your account and all associated data. This cannot be undone.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          type="button"
          variant="destructive"
          disabled={deleting}
          onClick={handleDeleteAccount}
        >
          {deleting ? "Deleting..." : "Delete account"}
        </Button>
      </CardContent>
    </Card>
  );
}
