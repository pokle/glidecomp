/**
 * Account settings — pilot profile, API keys, superadmin links and the
 * delete-account danger zone. Merges the former standalone "My Profile" page
 * (React port of profile.ts) with the account settings (React port of
 * settings.ts); each concern is its own separated card.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/react/ui/button";
import {
  Card,
  CardAction,
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
import { RadioGroup, RadioGroupItem } from "@/react/ui/radio-group";
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
import { goToSignIn, useUser } from "../lib/user";
import { type ThemePreference, useTheme } from "../lib/theme";
import { setUnit, useUnits, type UnitPreferences } from "../lib/units";

interface ApiKey {
  id: string;
  name: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string | null;
}

/**
 * Transient "Saved ✓" confirmation for the instant-apply sections (Appearance,
 * Units), sitting in the card's action slot. Those sections persist on every
 * click, but a moved radio pill is quiet feedback — this makes the model
 * legible without a toast per click. `nonce` bumps on each save; the label
 * shows for a moment and fades. The live region stays mounted so screen
 * readers announce the change ("Saved") politely.
 */
function SavedFlash({ nonce }: { nonce: number }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (nonce === 0) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 2000);
    return () => clearTimeout(t);
  }, [nonce]);
  return (
    // Content (not just opacity) tracks visibility so each save re-announces
    // in the live region — identical text would only be read out once.
    <span
      role="status"
      className={`text-sm text-muted-foreground transition-opacity duration-300 ${
        visible ? "opacity-100" : "opacity-0"
      }`}
    >
      {visible ? "Saved ✓" : ""}
    </span>
  );
}

export function Settings() {
  const { user, loading, isSuperAdmin, previewRole } = useUser();

  useEffect(() => {
    document.title = "GlideComp - Settings";
  }, []);

  if (loading) return <p role="status">Loading…</p>;

  if (!user) {
    return (
      <section className="mx-auto flex max-w-3xl flex-col gap-6">
        <div>
          <h1 className="text-2xl font-bold">Settings</h1>
          <p className="text-muted-foreground">Sign in to manage your account</p>
          <Button type="button" className="mt-4" onClick={() => goToSignIn("/settings")}>
            Sign in
          </Button>
        </div>
        <AppearanceSection />
        <UnitsSection />
      </section>
    );
  }

  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-6">
      <h1 className="text-2xl font-bold">Settings</h1>
      <AccountSection />
      <ProfileSection />
      <AppearanceSection />
      <UnitsSection />
      <ApiKeysSection />
      {isSuperAdmin && previewRole === "actual" ? <SuperadminSection /> : null}
      <DangerZoneSection />
    </section>
  );
}

// Read-only identity summary. The email is the account's anchor: both Google
// OAuth and email-code sign-in resolve to the account holding this address.
function AccountSection() {
  const { user } = useUser();
  if (!user) return null;

  const rows = [
    { label: "Email", value: user.email },
    { label: "Username", value: user.username ?? "—" },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Account</CardTitle>
        <CardDescription>
          You can sign in with Google or an emailed code — both use this address.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-x-8 gap-y-2 sm:grid-cols-[auto_1fr]">
          {rows.map((row) => (
            <div key={row.label} className="contents">
              <dt className="text-sm text-muted-foreground">{row.label}</dt>
              <dd className="text-sm font-medium break-all">{row.value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

// Device-local colour-scheme preference (persisted in localStorage, not the
// account) — applied immediately via ../lib/theme.
const THEME_OPTIONS: { value: ThemePreference; label: string; description: string }[] = [
  { value: "light", label: "Light", description: "Always use the light theme" },
  { value: "dark", label: "Dark", description: "Always use the dark theme" },
  { value: "auto", label: "Auto", description: "Follow your device settings" },
];

function AppearanceSection() {
  const [theme, setTheme] = useTheme();
  const [savedNonce, setSavedNonce] = useState(0);
  const idBase = useId();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
        <CardDescription>
          Choose how GlideComp looks on this device. Changes apply immediately.
        </CardDescription>
        <CardAction>
          <SavedFlash nonce={savedNonce} />
        </CardAction>
      </CardHeader>
      <CardContent>
        <RadioGroup
          value={theme}
          onValueChange={(value) => {
            setTheme(value as ThemePreference);
            setSavedNonce((n) => n + 1);
          }}
          aria-label="Theme"
          className="gap-3"
        >
          {THEME_OPTIONS.map((option) => {
            const id = `${idBase}-${option.value}`;
            return (
              <label
                key={option.value}
                htmlFor={id}
                className="flex cursor-pointer items-center gap-3 rounded-lg border p-3 has-[[data-checked]]:border-primary has-[[data-checked]]:bg-accent/50"
              >
                <RadioGroupItem id={id} value={option.value} />
                <div className="grid gap-0.5">
                  <span className="text-sm font-medium leading-none">{option.label}</span>
                  <span className="text-sm text-muted-foreground">{option.description}</span>
                </div>
              </label>
            );
          })}
        </RadioGroup>
      </CardContent>
    </Card>
  );
}

// Preferred display units, shared with the analysis page and 3D replay via
// the glidecomp:preferences store (device-local, cloud-synced to the account
// when signed in). Changing a unit here updates every open surface live.
const UNIT_GROUPS: {
  key: keyof UnitPreferences;
  label: string;
  description: string;
  options: { value: string; label: string }[];
}[] = [
  {
    key: "speed",
    label: "Speed",
    description: "Ground speed and wind",
    options: [
      { value: "km/h", label: "km/h" },
      { value: "mph", label: "mph" },
      { value: "knots", label: "kts" },
    ],
  },
  {
    key: "altitude",
    label: "Altitude",
    description: "Heights and altitude gains",
    options: [
      { value: "m", label: "m" },
      { value: "ft", label: "ft" },
    ],
  },
  {
    key: "climbRate",
    label: "Climb",
    description: "Climb and sink rates",
    options: [
      { value: "m/s", label: "m/s" },
      { value: "ft/min", label: "fpm" },
      { value: "knots", label: "kts" },
    ],
  },
  {
    key: "distance",
    label: "Distance",
    description: "Task and flown distances",
    options: [
      { value: "km", label: "km" },
      { value: "mi", label: "mi" },
      { value: "nmi", label: "NM" },
    ],
  },
];

function UnitsSection() {
  const units = useUnits();
  const [savedNonce, setSavedNonce] = useState(0);
  const idBase = useId();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Units</CardTitle>
        <CardDescription>
          How speeds, altitudes, climb rates and distances are displayed.
          Changes apply immediately, and sync to your account when you're
          signed in.
        </CardDescription>
        <CardAction>
          <SavedFlash nonce={savedNonce} />
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4">
          {UNIT_GROUPS.map((group) => {
            const labelId = `${idBase}-${group.key}-label`;
            return (
              <div
                key={group.key}
                className="flex flex-wrap items-center justify-between gap-x-8 gap-y-2"
              >
                <div className="grid gap-0.5">
                  <span id={labelId} className="text-sm font-medium leading-none">
                    {group.label}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {group.description}
                  </span>
                </div>
                <RadioGroup
                  value={units[group.key]}
                  onValueChange={(value) => {
                    setUnit(group.key, value as UnitPreferences[typeof group.key]);
                    setSavedNonce((n) => n + 1);
                  }}
                  aria-labelledby={labelId}
                  className="flex flex-row gap-2"
                >
                  {group.options.map((option) => {
                    const id = `${idBase}-${group.key}-${option.value}`;
                    return (
                      <label
                        key={option.value}
                        htmlFor={id}
                        className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 has-[[data-checked]]:border-primary has-[[data-checked]]:bg-accent/50"
                      >
                        <RadioGroupItem id={id} value={option.value} />
                        <span className="text-sm font-medium leading-none">
                          {option.label}
                        </span>
                      </label>
                    );
                  })}
                </RadioGroup>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
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
  // The last-saved values, for dirty tracking: Save only enables (and the
  // navigation guards only arm) while the form differs from these.
  const [savedValues, setSavedValues] = useState<ProfileValues>(EMPTY_VALUES);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const idBase = useId();
  const confirm = useConfirm();
  const navigate = useNavigate();

  useEffect(() => {
    (async () => {
      try {
        const res = await api.api.comp.pilot.$get();
        if (!res.ok) {
          setState("error");
          return;
        }
        const profile = (await res.json()) as Record<string, string | null>;
        const loaded = Object.fromEntries(
          PROFILE_FIELDS.map((f) => [f.key, profile[f.key] ?? ""])
        ) as ProfileValues;
        setValues(loaded);
        setSavedValues(loaded);
        setState("ready");
      } catch {
        setState("error");
      }
    })();
  }, []);

  const dirty =
    state === "ready" &&
    PROFILE_FIELDS.some((f) => values[f.key] !== savedValues[f.key]);

  // Guard against silently losing edits. Two layers while dirty:
  // beforeunload covers reloads / tab closes / external links; the
  // capture-phase click listener covers in-app navigation (BrowserRouter has
  // no useBlocker, so same-origin link clicks are intercepted before React's
  // own handlers, confirmed with the app dialog, then re-navigated).
  //
  // confirm/navigate go through refs so the effect keys on `dirty` alone —
  // the confirm context value changes identity on every provider render, and
  // having it in the deps re-armed the listener mid-dispatch (double dialogs).
  const guardRef = useRef({ confirm, navigate, prompting: false });
  guardRef.current.confirm = confirm;
  guardRef.current.navigate = navigate;
  useEffect(() => {
    if (!dirty) return;

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);

    const onClickCapture = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as Element | null)?.closest?.("a[href]");
      if (!anchor || anchor.getAttribute("target") === "_blank") return;
      const href = anchor.getAttribute("href") ?? "";
      const url = new URL(href, window.location.href);
      // External links fall through to beforeunload; same-page hashes are fine.
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.hash) return;

      // Stop the navigation at document level — stopImmediatePropagation so
      // React's root listeners (and any sibling duplicate) never see the
      // click — then re-run it iff the user confirms.
      e.preventDefault();
      e.stopImmediatePropagation();
      const guard = guardRef.current;
      if (guard.prompting) return;
      guard.prompting = true;
      void guard
        .confirm({
          title: "Discard profile changes?",
          message:
            "Your profile has unsaved changes. Leaving this page will discard them.",
          confirmLabel: "Discard changes",
          cancelLabel: "Keep editing",
          destructive: true,
        })
        .then((ok) => {
          guard.prompting = false;
          if (ok) guard.navigate(url.pathname + url.search + url.hash);
        });
    };
    document.addEventListener("click", onClickCapture, true);

    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClickCapture, true);
    };
  }, [dirty]);

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
      // What the server stored (trimmed) becomes the new baseline, so the
      // form is clean again and the Save button disables.
      const normalized = Object.fromEntries(
        PROFILE_FIELDS.map((f) => [f.key, values[f.key].trim()])
      ) as ProfileValues;
      setValues(normalized);
      setSavedValues(normalized);
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
        onChange={(e) => {
          setValues((v) => ({ ...v, [field.key]: e.target.value }));
          // A stale "Profile saved" next to re-edited fields reads as a lie.
          setStatus(null);
        }}
        required={field.key === "name"}
      />
    </Field>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
        <CardDescription>
          Your pilot details, used when you register for competitions. Changes
          take effect when you save.
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

            <div className="flex items-center gap-3">
              <Button type="submit" disabled={saving || !dirty}>
                {saving ? "Saving..." : "Save profile"}
              </Button>
              {/* The dirty hint doubles as the explanation for why Save is
                  enabled; role=status so the state change is announced. */}
              <span role="status" className="text-sm text-muted-foreground">
                {dirty && !saving ? "Unsaved changes" : ""}
              </span>
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
          Grant scoring agents programmatic access to your account. See the{" "}
          <a
            href="https://github.com/pokle/glidecomp/blob/master/docs/api.md"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4 hover:text-foreground"
          >
            API documentation
          </a>{" "}
          for endpoints, examples, and rate limits.
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
