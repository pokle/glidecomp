/**
 * /oauth/consent — an organiser deciding whether an MCP client (Claude,
 * ChatGPT, …) may act as them (docs/2026-10-24-mcp-oauth-plan.md §8; the copy
 * is the plan's, as agreed).
 *
 * auth-api's mcp() provider sends the browser here, signed in, with the
 * authorisation request in the query, signed. The page names the client and
 * what it asked for, then posts the answer back with that same signed query;
 * the provider replies with where to go next — the client's redirect URI,
 * carrying a code or an error.
 *
 * The client's name comes from a fetch, and the page waits for it rather than
 * render a stand-in first: "Let An assistant use GlideComp as you?" flashing
 * to "Let Claude…" is exactly the uncertainty a consent screen must not show.
 */
import { useEffect, useState } from "react";
import { Button } from "@/react/rac/button";
import { Card } from "@/react/rac/card";
import { Loading } from "@/react/rac/progress";
import { NotFound } from "../components/NotFound";
import { useGoToSignIn, useUser } from "../lib/user";

interface PublicClient {
  client_id: string;
  client_name?: string;
}

/** What each GlideComp scope lets the client do, as the consent page says it. */
export const SCOPE_LINES: Record<string, string> = {
  "comp:read": "See competitions and tasks, including hidden ones you organise",
  "task:write": "Create tasks and change their routes in competitions you organise",
};

/** The host the client's redirect URI returns to — validated by the provider before it sent us here. */
export function redirectHost(query: URLSearchParams): string | null {
  const uri = query.get("redirect_uri");
  if (!uri) return null;
  try {
    return new URL(uri).host || null;
  } catch {
    return null;
  }
}

export function OAuthConsent() {
  const { user, loading } = useUser();
  const goToSignIn = useGoToSignIn();
  const [query] = useState(() =>
    typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search)
  );
  /** undefined while loading; null when the client couldn't be named. */
  const [client, setClient] = useState<PublicClient | null | undefined>(undefined);
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const clientId = query.get("client_id");
  const scopes = (query.get("scope") ?? "").split(" ").filter((s) => s in SCOPE_LINES);

  useEffect(() => {
    document.title = "GlideComp - Connect an assistant";
  }, []);

  // Signed out here means the session ended between the provider's redirect
  // and this page; signing in again resumes the same request.
  useEffect(() => {
    if (!loading && !user && clientId) goToSignIn(window.location.pathname + window.location.search);
  }, [loading, user, clientId, goToSignIn]);

  useEffect(() => {
    if (!clientId || !user) return;
    let cancelled = false;
    fetch(`/api/auth/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`, {
      credentials: "include",
    })
      .then((r) => (r.ok ? (r.json() as Promise<PublicClient>) : null))
      .catch(() => null)
      .then((c) => {
        if (!cancelled) setClient(c);
      });
    return () => {
      cancelled = true;
    };
  }, [clientId, user]);

  async function answer(accept: boolean) {
    setBusy(accept ? "allow" : "deny");
    setError(null);
    try {
      const res = await fetch("/api/auth/oauth2/consent", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accept, oauth_query: window.location.search.replace(/^\?/, "") }),
      });
      const body = (await res.json().catch(() => null)) as { url?: string } | null;
      if (!res.ok || !body?.url) {
        setBusy(null);
        setError("That didn't work. Go back to the assistant and connect again.");
        return;
      }
      window.location.assign(body.url);
    } catch {
      setBusy(null);
      setError("GlideComp couldn't be reached. Check your connection and try again.");
    }
  }

  if (!clientId) return <NotFound />;
  if (loading || !user || client === undefined) {
    return (
      <div className="mx-auto mt-8 max-w-md">
        <Loading>Loading…</Loading>
      </div>
    );
  }

  const name = client?.client_name || "An assistant";
  const host = redirectHost(query);

  return (
    <div className="mx-auto mt-8 max-w-md">
      <Card className="gap-4">
        <h1 className="text-xl font-bold">Let {name} use GlideComp as you?</h1>
        <p>
          {name}
          {host ? ` (returns to ${host})` : ""} is asking to:
        </p>
        <ul className="list-disc space-y-1 pl-5">
          {scopes.map((s) => (
            <li key={s}>{SCOPE_LINES[s]}</li>
          ))}
        </ul>
        <p>
          It acts as you. Every change it makes shows in that competition's public activity log under your name,
          marked "via {name}".
        </p>
        <p className="text-sm text-muted-foreground">
          You can disconnect it at any time in Settings → Connected assistants.
        </p>
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-3">
          <Button
            onPress={() => void answer(true)}
            isPending={busy === "allow"}
            pendingLabel="Allowing"
            isDisabled={busy === "deny"}
          >
            Allow
          </Button>
          <Button
            variant="outline"
            onPress={() => void answer(false)}
            isPending={busy === "deny"}
            pendingLabel="Declining"
            isDisabled={busy === "allow"}
          >
            Don't allow
          </Button>
        </div>
      </Card>
    </div>
  );
}
