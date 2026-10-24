/**
 * /oauth/consent — an organiser deciding whether an MCP client (Claude,
 * ChatGPT, …) may act as them (docs/2026-10-24-mcp-oauth-plan.md §8).
 *
 * SPIKE: phase 0. The copy is the plan's PROPOSED wording, not yet agreed,
 * and the page has had no accessibility pass.
 *
 * auth-api's mcp() provider sends the browser here with the authorisation
 * request in the query, signed. The page names the client and the scopes,
 * and posts the answer back with that same signed query; the provider
 * replies with where to go next (the client's redirect URI, carrying a code
 * or an error).
 */
import { useEffect, useState } from "react";
import { Button } from "@/react/rac/button";
import { Card } from "@/react/rac/card";
import { useUser } from "../lib/user";

interface PublicClient {
  client_id: string;
  client_name?: string;
  client_uri?: string;
  redirect_uris?: string[];
}

/** What each scope lets the client do, as the consent page says it. */
const SCOPE_LINES: Record<string, string> = {
  "comp:read": "See competitions and tasks, including hidden ones you organise",
  "task:write": "Create tasks and change their routes in competitions you organise",
};

function redirectHost(client: PublicClient | null, query: URLSearchParams): string | null {
  const uri = query.get("redirect_uri") ?? client?.redirect_uris?.[0];
  if (!uri) return null;
  try {
    return new URL(uri).host;
  } catch {
    return null;
  }
}

export function OAuthConsent() {
  const { user, loading } = useUser();
  const [query] = useState(() =>
    typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search)
  );
  const [client, setClient] = useState<PublicClient | null>(null);
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const clientId = query.get("client_id");
  const scopes = (query.get("scope") ?? "").split(" ").filter((s) => s in SCOPE_LINES);

  useEffect(() => {
    document.title = "GlideComp - Connect an assistant";
  }, []);

  useEffect(() => {
    if (!clientId) return;
    void fetch(`/api/auth/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`, {
      credentials: "include",
    })
      .then((r) => (r.ok ? (r.json() as Promise<PublicClient>) : null))
      .then(setClient)
      .catch(() => setClient(null));
  }, [clientId]);

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
      const body = (await res.json().catch(() => null)) as { url?: string; error_description?: string } | null;
      if (!res.ok || !body?.url) {
        setBusy(null);
        setError(body?.error_description ?? "That didn't work. Go back to the assistant and connect again.");
        return;
      }
      window.location.assign(body.url);
    } catch {
      setBusy(null);
      setError("GlideComp couldn't be reached. Check your connection and try again.");
    }
  }

  if (loading) return null;
  if (!user || !clientId) {
    return (
      <div className="mx-auto mt-8 max-w-md">
        <Card className="gap-3">
          <h1 className="text-xl font-bold">Nothing to approve</h1>
          <p>This page opens when an assistant asks to connect to GlideComp. Start from the assistant.</p>
        </Card>
      </div>
    );
  }

  const name = client?.client_name || "An assistant";
  const host = redirectHost(client, query);

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
          It acts as you. Every change it makes shows in that competition's public activity log under your
          name, marked "via {name}".
        </p>
        <p className="text-sm text-muted-foreground">
          You can disconnect it at any time in Settings → Connected assistants.
        </p>
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex gap-3">
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
