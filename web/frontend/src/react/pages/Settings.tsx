/**
 * Account settings — pilot profile, API keys, superadmin links and the
 * delete-account danger zone. Merges the former standalone "My Profile" page
 * (React port of profile.ts) with the account settings (React port of
 * settings.ts); each concern is its own separated card.
 */
import { useCallback, useEffect, useState } from "react";
import { Form } from "react-aria-components";
import { Button, LinkButton } from "@/react/rac/button";
import { Card, CardGrid, CardHeader } from "@/react/rac/card";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Modal,
} from "@/react/rac/dialog";
import { FieldGroup, TextField } from "@/react/rac/field";
import { Loading } from "@/react/rac/progress";
import { Radio, RadioGroup } from "@/react/rac/radio-group";
import { Cell, Column, Row, Table, TableBody, TableHeader } from "@/react/rac/table";
import { api } from "../../comp/api";
import { deleteAccount } from "../../auth/client";
import { storage } from "../../analysis/storage";
import { toast } from "../lib/toast";
import { useConfirm } from "../lib/confirm";
import { useUnsavedChangesGuard } from "../lib/use-unsaved-changes-guard";
import { useGoToSignIn, useUser } from "../lib/user";
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
  const goToSignIn = useGoToSignIn();

  useEffect(() => {
    document.title = "GlideComp - Settings";
  }, []);

  if (loading) return <p role="status">Loading…</p>;

  if (!user) {
    return (
      <section className="mx-auto flex max-w-3xl flex-col gap-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
          <p className="text-muted-foreground">Sign in to manage your account</p>
          <Button className="mt-4" onPress={() => goToSignIn("/settings")}>
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
      <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
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
      <CardHeader
        title="Account"
        description="Sign in with Google or an emailed code — both use this address."
      />
      <dl className="grid gap-x-8 gap-y-2 sm:grid-cols-[auto_1fr]">
        {rows.map((row) => (
          <div key={row.label} className="contents">
            <dt className="text-sm text-muted-foreground">{row.label}</dt>
            <dd className="font-mono text-sm break-all">{row.value}</dd>
          </div>
        ))}
      </dl>
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

  return (
    <Card>
      <CardHeader
        title="Appearance"
        description="How GlideComp looks on this device."
        action={<SavedFlash nonce={savedNonce} />}
      />
      {/* RAC's Radio IS the label, so the card styling goes on the Radio
          itself rather than a wrapping <label> with htmlFor. */}
      <RadioGroup
        value={theme}
        onChange={(value) => {
          setTheme(value as ThemePreference);
          setSavedNonce((n) => n + 1);
        }}
        aria-label="Theme"
        // Three short options side by side rather than stacked full-width —
        // they drop to one column on their own when the card gets narrow.
        className="grid grid-cols-[repeat(auto-fit,minmax(min(12rem,100%),1fr))] gap-3"
      >
        {THEME_OPTIONS.map((option) => (
          <Radio
            key={option.value}
            value={option.value}
            className="w-full cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors data-hovered:bg-muted/60 data-selected:border-primary data-selected:bg-primary/5 data-selected:data-hovered:bg-primary/5"
          >
            <span className="grid gap-1">
              <span className="text-sm leading-none font-medium">{option.label}</span>
              <span className="text-sm text-muted-foreground">{option.description}</span>
            </span>
          </Radio>
        ))}
      </RadioGroup>
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

  return (
    <Card>
      <CardHeader
        title="Units"
        description="How speeds, altitudes, climb rates and distances are displayed. Synced to your account when you're signed in."
        action={<SavedFlash nonce={savedNonce} />}
      />
      <div className="grid gap-1">
        {UNIT_GROUPS.map((group) => (
          // The group's own label + description ARE the RadioGroup's label
          // and description slots now, so there is no aria-labelledby to wire.
          <RadioGroup
            key={group.key}
            value={units[group.key]}
            onChange={(value) => {
              setUnit(group.key, value as UnitPreferences[typeof group.key]);
              setSavedNonce((n) => n + 1);
            }}
            aria-label={group.label}
            // An iOS-style grouped row: label left, control right, hairline
            // between rows rather than a gap. The four rows then read as one
            // list instead of four floating clusters.
            //
            // `flex-row` is load-bearing: RadioGroup's own base is `flex-col`,
            // and `flex-wrap` does NOT override it (different CSS property, so
            // tailwind-merge keeps both) — which is why these rows were
            // stacking and centring rather than sitting label-left/control-right.
            className="flex flex-row flex-wrap items-center justify-between gap-x-8 gap-y-2 border-b border-border py-3 first:pt-0 last:border-b-0 last:pb-0"
          >
            <span className="grid gap-1">
              <span className="text-sm leading-none font-medium">{group.label}</span>
              <span className="text-sm text-muted-foreground">{group.description}</span>
            </span>
            {/* Segmented control: one bordered track, the selected pill filled.
                Short mutually-exclusive options read better joined than as
                separate outlined chips — and it halves the width they take. */}
            <span className="flex shrink-0 flex-row overflow-hidden rounded-lg bg-muted p-0.5">
              {group.options.map((option) => (
                <Radio
                  key={option.value}
                  value={option.value}
                  // The radio dot is hidden INSIDE the track: the raised pill
                  // is already the selected indicator, and drawing both says
                  // the same thing twice in a 40px-wide chip. It stays a real
                  // radio — RAC keeps the roving focus and aria-checked.
                  //
                  // Selection is carried by fill, elevation, a ring AND text
                  // colour, never by hue alone. `bg-card` on a `bg-muted`
                  // track is what separates them in BOTH themes; the earlier
                  // `bg-muted/40` track put the pill within a hair of its own
                  // background in dark mode and the selection vanished.
                  className="cursor-pointer rounded-md px-3 py-1 font-mono text-[0.8rem] font-medium text-muted-foreground tabular-nums transition-colors [&>span[aria-hidden]]:hidden data-hovered:text-foreground data-selected:bg-card data-selected:text-foreground data-selected:shadow-card data-selected:ring-1 data-selected:ring-border"
                >
                  {option.label}
                </Radio>
              ))}
            </span>
          </RadioGroup>
        ))}
      </div>
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

  // Guard against silently losing edits — see lib/use-unsaved-changes-guard.
  useUnsavedChangesGuard(dirty, {
    title: "Discard profile changes?",
    message:
      "Your profile has unsaved changes. Leaving this page will discard them.",
  });

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
    <TextField
      key={field.key}
      label={field.label}
      // The display name reads better full-width above the paired contact rows.
      // `1 / -1` rather than `col-span-2`: an auto-fit grid may resolve to a
      // SINGLE column, and spanning 2 there would conjure an implicit second
      // one and push the field off the card.
      className={field.key === "name" ? "[grid-column:1/-1]" : undefined}
      value={values[field.key]}
      onChange={(value) => {
        setValues((v) => ({ ...v, [field.key]: value }));
        // A stale "Profile saved" next to re-edited fields reads as a lie.
        setStatus(null);
      }}
      isRequired={field.key === "name"}
    />
  );

  return (
    <Card>
      <CardHeader
        title="Profile"
        description="Your pilot details, used when you register for competitions."
      />
      {state === "loading" ? (
        <Loading>Loading your profile…</Loading>
      ) : state === "error" ? (
        <p role="alert">Failed to load profile</p>
      ) : (
        <Form onSubmit={handleSubmit} className="flex flex-col gap-6">
          <FieldGroup label="Name &amp; contact">
            <CardGrid min="15rem">{NAME_CONTACT_FIELDS.map(renderField)}</CardGrid>
          </FieldGroup>

          {/* Seven short codes — they pack tighter than the contact fields, so
              a narrower floor lets more sit on a row when there is room. */}
          <FieldGroup label="Pilot IDs">
            <CardGrid min="10rem">{ID_FIELDS.map(renderField)}</CardGrid>
          </FieldGroup>

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
            {/* isDisabled for "nothing to save" (a standing state), isPending
                for the save in flight — two different things, so both. */}
            <Button
              type="submit"
              isDisabled={!dirty}
              isPending={saving}
              pendingLabel="Saving your profile"
            >
              Save profile
            </Button>
            {/* The dirty hint doubles as the explanation for why Save is
                enabled; role=status so the state change is announced. */}
            <span role="status" className="text-sm text-muted-foreground">
              {dirty && !saving ? "Unsaved changes" : ""}
            </span>
          </div>
        </Form>
      )}
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
      {/* The create action is section-scoped, so it belongs right-aligned on
          the header row (design language) rather than stacked above the table. */}
      <CardHeader
        title="API keys"
        description={
          <>
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
          </>
        }
        action={
          <Button
            variant="outline"
            size="sm"
            onPress={() => {
              setKeyName("");
              setCreateOpen(true);
            }}
          >
            Create API key
          </Button>
        }
      />
      <div>
        {loadError ? (
          <p role="alert">{loadError}</p>
        ) : keys === null ? (
          <Loading>Loading API keys…</Loading>
        ) : keys.length === 0 ? (
          // An empty state is an invitation to act, not a dead end.
          <p className="rounded-lg border border-dashed px-4 py-6 text-center text-muted-foreground">
            No API keys yet. Create one to let a scoring agent reach your account.
          </p>
        ) : (
          <div className="rounded-lg border">
            <Table aria-label="API keys">
              <TableHeader>
                <Column isRowHeader>Label</Column>
                <Column>Created</Column>
                <Column>Last used</Column>
                <Column>
                  <span className="sr-only">Actions</span>
                </Column>
              </TableHeader>
              <TableBody>
                {keys.map((key) => (
                  <Row key={key.id} id={key.id}>
                    <Cell>{key.name ?? <em>Unnamed</em>}</Cell>
                    {/* Dates read down the column, so they get the figure face. */}
                    <Cell className="font-mono tabular-nums">
                      {new Date(key.createdAt).toLocaleDateString()}
                    </Cell>
                    <Cell className="font-mono tabular-nums">
                      {key.lastUsedAt
                        ? new Date(key.lastUsedAt).toLocaleDateString()
                        : "Never"}
                    </Cell>
                    <Cell>
                      <Button
                        variant="outline"
                        size="sm"
                        isPending={revokingId === key.id}
                        pendingLabel="Revoking this key"
                        onPress={() => void handleRevoke(key.id)}
                      >
                        Revoke
                      </Button>
                    </Cell>
                  </Row>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <Modal isOpen={createOpen} onOpenChange={setCreateOpen}>
        <Dialog>
          <DialogHeader>
            <DialogTitle>Create API key</DialogTitle>
          </DialogHeader>
          <Form onSubmit={handleCreate} className="flex flex-col gap-4">
            <TextField
              label="Label (optional)"
              value={keyName}
              onChange={setKeyName}
              placeholder="e.g. My scoring agent"
              autoFocus
            />
            <DialogFooter>
              <Button slot="close" variant="outline">
                Cancel
              </Button>
              <Button type="submit" isPending={creating} pendingLabel="Creating the key">
                Create
              </Button>
            </DialogFooter>
          </Form>
        </Dialog>
      </Modal>

      <Modal
        isOpen={createdKey !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreatedKey(null);
            void loadKeys();
          }
        }}
      >
        <Dialog>
          <DialogHeader>
            <DialogTitle>API key created</DialogTitle>
            <p className="text-sm text-muted-foreground">
              Copy this key now — it won't be shown again.
            </p>
          </DialogHeader>
          <code className="block rounded-md border bg-muted px-3 py-2 font-mono text-sm break-all">
            {createdKey}
          </code>
          <DialogFooter>
            <Button
              onPress={() => {
                void navigator.clipboard.writeText(createdKey ?? "").then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? "Copied!" : "Copy"}
            </Button>
            <Button slot="close" variant="outline">
              Done
            </Button>
          </DialogFooter>
        </Dialog>
      </Modal>
    </Card>
  );
}

function SuperadminSection() {
  return (
    <Card>
      <CardHeader title="Superadmin" />
      {/* Two destinations, side by side at their natural width — a full-bleed
          button implies a weightier action than "open the users list". */}
      <div className="flex flex-wrap gap-3">
        <LinkButton variant="outline" href="/admin/users">
          Users
        </LinkButton>
        <LinkButton variant="outline" href="/admin/cache">
          Cache
        </LinkButton>
        {/* A Pages Function, not a react-router route. `download` (no value)
            forces a save under the server's Content-Disposition filename, and
            keeps RAC from client-navigating a URL the SPA has no route for. */}
        <LinkButton variant="outline" href="/civl-rankings.csv" download="">
          CIVL rankings (CSV)
        </LinkButton>
      </div>
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
    <Card className="border-destructive/30">
      <CardHeader
        title="Danger zone"
        description="Permanently delete your account and all associated data. This cannot be undone."
        action={
          <Button
            variant="destructive"
            isPending={deleting}
            pendingLabel="Deleting your account"
            onPress={() => void handleDeleteAccount()}
          >
            Delete account
          </Button>
        }
      />
    </Card>
  );
}
