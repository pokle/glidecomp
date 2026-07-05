/** First-login onboarding — React port of onboarding.ts / onboarding.html. */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Field } from "@base-ui/react/field";
import { Input } from "@base-ui/react/input";
import { setUsername } from "../../auth/client";
import { api } from "../../comp/api";
import { useUser } from "../lib/user";

export function Onboarding() {
  const { user, loading } = useUser();
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [username, setUsernameValue] = useState("");
  const [civlId, setCivlId] = useState("");
  const [safaId, setSafaId] = useState("");
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    document.title = "GlideComp - Welcome";
    if (loading) return;
    if (!user) {
      navigate("/u/me", { replace: true });
      return;
    }
    // Already onboarded — go straight to the dashboard.
    if (user.username) {
      navigate(`/u/${user.username}`, { replace: true });
      return;
    }
    setName(user.name);
  }, [user, loading, navigate]);

  if (loading || !user || user.username) return <p role="status">Loading…</p>;

  const firstName = user.name.split(" ")[0] || user.name;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setUsernameError(null);
    setGeneralError(null);
    setSubmitting(true);

    // Username first — it's the gate; abort before writing the pilot profile
    // so a taken username can be retried without a half-formed pilot row.
    const usernameResult = await setUsername(username.trim());
    if (usernameResult.error) {
      setUsernameError(usernameResult.error);
      setSubmitting(false);
      return;
    }

    // Full page load, not navigate(): the UserProvider context still holds
    // username: null, so a client-side hop would bounce the dashboard's
    // "no username → onboarding" guard straight back here. Reloading
    // refetches /api/auth/me with the new username.
    const dest = `/u/${usernameResult.username}`;
    try {
      const res = await api.api.comp.pilot.$patch({
        json: {
          name: name.trim(),
          civl_id: civlId.trim() === "" ? null : civlId.trim(),
          safa_id: safaId.trim() === "" ? null : safaId.trim(),
        } as never,
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        setGeneralError(
          err.error || "Could not save profile. You can update it later on your profile page."
        );
        // Username is already saved — proceed after the user sees the message.
        setTimeout(() => window.location.assign(dest), 2000);
        return;
      }
    } catch {
      setGeneralError(
        "Could not save pilot details right now. You can add them later on your profile page."
      );
      setTimeout(() => window.location.assign(dest), 2000);
      return;
    }
    window.location.assign(dest);
  }

  return (
    <main>
      {user.image ? <img src={user.image} alt={user.name} /> : null}
      <h1>Welcome, {firstName}!</h1>
      <p>Set up your GlideComp account</p>

      <form onSubmit={handleSubmit}>
        <Field.Root className="Field">
          <Field.Label className="Field-label">Full name</Field.Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={128} />
        </Field.Root>

        <Field.Root className="Field">
          <Field.Label className="Field-label">Username</Field.Label>
          <Input
            value={username}
            onChange={(e) => setUsernameValue(e.target.value)}
            required
            autoFocus
          />
          {usernameError ? <Field.Error className="Field-error" match>{usernameError}</Field.Error> : null}
        </Field.Root>

        <Field.Root className="Field">
          <Field.Label className="Field-label">CIVL ID (optional)</Field.Label>
          <Input value={civlId} onChange={(e) => setCivlId(e.target.value)} />
        </Field.Root>

        <Field.Root className="Field">
          <Field.Label className="Field-label">SAFA ID (optional)</Field.Label>
          <Input value={safaId} onChange={(e) => setSafaId(e.target.value)} />
        </Field.Root>

        {generalError ? <p role="alert">{generalError}</p> : null}

        <button type="submit" disabled={submitting}>
          {submitting ? "Saving..." : "Continue"}
        </button>
      </form>
    </main>
  );
}
