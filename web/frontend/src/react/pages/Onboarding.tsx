/** First-login onboarding — React port of onboarding.ts / onboarding.html. */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/react/rac/button";
import { TextField } from "@/react/rac/field";
import { needsOnboarding, setUsername } from "../../auth/client";
import { api } from "../../comp/api";
import { useUser } from "../lib/user";

export function Onboarding() {
  const { user, loading } = useUser();
  const navigate = useNavigate();
  // Which half is missing decides where the cursor lands. An email-OTP
  // sign-up arrives with a derived username and no name; a pre-#349 account
  // is the other way round.
  const nameMissing = !!user && user.name.trim() === "";

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
    if (!needsOnboarding(user)) {
      navigate(`/u/${user.username}`, { replace: true });
      return;
    }
    setName(user.name);
    // The auto-derived handle is a suggestion, not a decision: show it so it
    // can be kept with one keystroke or replaced. Re-submitting the account's
    // own current username is a no-op, not a "taken" rejection.
    setUsernameValue(user.username ?? "");
  }, [user, loading, navigate]);

  if (loading || !user || !needsOnboarding(user)) return <p role="status">Loading…</p>;

  const firstName = user.name.split(" ")[0] || user.name;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setUsernameError(null);
    setGeneralError(null);
    setSubmitting(true);

    // Account fields first — they're the gate; abort before writing the pilot
    // profile so a taken username can be retried without a half-formed pilot
    // row. Name goes with them rather than being left to the pilot PATCH
    // below: the gate reads the ACCOUNT's name, so a pilot-only write would
    // save the profile and still send the user back here.
    const usernameResult = await setUsername(username.trim(), name.trim());
    if (usernameResult.error) {
      setUsernameError(usernameResult.error);
      setSubmitting(false);
      return;
    }

    // Full page load, not navigate(): the UserProvider context still holds
    // the pre-submit user, so a client-side hop would bounce the dashboard's
    // needsOnboarding() guard straight back here. Reloading refetches
    // /api/auth/me with the saved username and name.
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
          err.error || "Could not save profile. You can update it later in Settings."
        );
        // Username is already saved — proceed after the user sees the message.
        setTimeout(() => window.location.assign(dest), 2000);
        return;
      }
    } catch {
      setGeneralError(
        "Could not save pilot details right now. You can add them later in Settings."
      );
      setTimeout(() => window.location.assign(dest), 2000);
      return;
    }
    window.location.assign(dest);
  }

  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 px-4 py-10">
      {user.image ? (
        // Decorative: the heading beside it already names the account, and an
        // email sign-up has no name to put here anyway (WCAG 1.1.1).
        <img src={user.image} alt="" className="size-16 rounded-full border" />
      ) : null}
      <h1 className="text-2xl font-bold">
        {firstName ? `Welcome, ${firstName}!` : "Welcome to GlideComp!"}
      </h1>
      <p className="text-muted-foreground">Set up your GlideComp account</p>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {/* RAC fields are self-labelling — the Label/Input/FieldError ids and
            aria-describedby are wired by TextField, so no useId plumbing. */}
        <TextField
          label="Full name"
          value={name}
          onChange={setName}
          isRequired
          autoFocus={nameMissing}
          maxLength={128}
        />

        {/* The taken-username rejection comes back from the server. RAC's
            default native validation turns `isInvalid` into a real custom
            validity on the input, which blocks form submission — so the error
            MUST be cleared as soon as the value changes, or fixing the
            username still can't be submitted. */}
        <TextField
          label="Username"
          value={username}
          onChange={(value) => {
            setUsernameValue(value);
            setUsernameError(null);
          }}
          isRequired
          autoFocus={!nameMissing}
          isInvalid={usernameError !== null}
          errorMessage={usernameError ?? undefined}
        />

        <TextField label="CIVL ID (optional)" value={civlId} onChange={setCivlId} />

        <TextField label="SAFA ID (optional)" value={safaId} onChange={setSafaId} />

        {generalError ? <p role="alert">{generalError}</p> : null}

        <div>
          <Button type="submit" isPending={submitting} pendingLabel="Saving your profile">
            Continue
          </Button>
        </div>
      </form>
    </main>
  );
}
