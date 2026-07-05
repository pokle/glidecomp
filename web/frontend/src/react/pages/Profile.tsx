/** Pilot profile editor — React port of profile.ts / profile.html. */
import { useEffect, useId, useState } from "react";
import { Button } from "@/react/ui/button";
import { Field, FieldLabel } from "@/react/ui/field";
import { Input } from "@/react/ui/input";
import { api } from "../../comp/api";
import { signInWithGoogle, useUser } from "../lib/user";

const PROFILE_FIELDS = [
  { key: "name", label: "Display name" },
  { key: "civl_id", label: "CIVL ID" },
  { key: "safa_id", label: "SAFA ID" },
  { key: "ushpa_id", label: "USHPA ID" },
  { key: "bhpa_id", label: "BHPA ID" },
  { key: "dhv_id", label: "DHV ID" },
  { key: "ffvl_id", label: "FFVL ID" },
  { key: "fai_id", label: "FAI ID" },
  { key: "phone", label: "Phone" },
  { key: "glider", label: "Glider" },
  { key: "emergency_contact_name", label: "Emergency contact name" },
  { key: "emergency_contact_phone", label: "Emergency contact phone" },
] as const;

type ProfileValues = Record<(typeof PROFILE_FIELDS)[number]["key"], string>;

const EMPTY_VALUES = Object.fromEntries(
  PROFILE_FIELDS.map((f) => [f.key, ""])
) as ProfileValues;

export function Profile() {
  const { user, loading } = useUser();
  const [values, setValues] = useState<ProfileValues>(EMPTY_VALUES);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const idBase = useId();

  useEffect(() => {
    document.title = "GlideComp - Profile";
    if (loading) return;
    if (!user) {
      setState("error");
      return;
    }
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
  }, [user, loading]);

  if (loading || (user && state === "loading")) return <p role="status">Loading…</p>;

  if (!user) {
    return (
      <section>
        <h1 className="text-2xl font-bold">My Profile</h1>
        <p className="text-muted-foreground">Sign in to edit your pilot profile</p>
        <Button type="button" className="mt-4" onClick={() => signInWithGoogle()}>
          Sign in with Google
        </Button>
      </section>
    );
  }

  if (state === "error") {
    return (
      <section>
        <h1 className="text-2xl font-bold">My Profile</h1>
        <p role="alert">Failed to load profile</p>
      </section>
    );
  }

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

  return (
    <section>
      <h1 className="text-2xl font-bold">My Profile</h1>
      <p className="text-muted-foreground">
        Your pilot details, used when you register for competitions
      </p>

      <form onSubmit={handleSubmit} className="mt-6 flex max-w-md flex-col gap-4">
        {PROFILE_FIELDS.map((field) => (
          <Field key={field.key}>
            <FieldLabel htmlFor={`${idBase}-${field.key}`}>{field.label}</FieldLabel>
            <Input
              id={`${idBase}-${field.key}`}
              value={values[field.key]}
              onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
              required={field.key === "name"}
            />
          </Field>
        ))}

        {status ? <p role={status.kind === "error" ? "alert" : "status"}>{status.message}</p> : null}

        <div>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving..." : "Save profile"}
          </Button>
        </div>
      </form>
    </section>
  );
}
