// The OAuth 2.1 provider behind /mcp (docs/2026-10-24-mcp-oauth-plan.md):
// an MCP client registers, an organiser signs in and consents, and the access
// token it gets is honoured by /me only while that consent stands. Each test
// drives the provider's real endpoints, the way a client would.

import { env, SELF } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { MCP_SCOPES } from "../src/auth";
import { loginAs, request } from "./helpers";

const ORIGIN = { Origin: "http://localhost:8788" };
const RESOURCE = "http://localhost:8788/mcp";
const ISSUER = "http://localhost:8788/api/auth";
const REDIRECT = "http://127.0.0.1:43123/callback";
const ALL_SCOPES = `openid profile offline_access ${MCP_SCOPES.join(" ")}`;

let ipCounter = 0;
/** A fresh client address per registration, so the per-IP budget only bites where a test means it to. */
function freshIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter % 250}`;
}

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

async function register(scope = ALL_SCOPES, ip = freshIp()): Promise<Response> {
  return request("POST", "/api/auth/oauth2/register", {
    headers: { "cf-connecting-ip": ip },
    body: {
      client_name: "Test assistant",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope,
    },
  });
}

function authorizeUrl(clientId: string, challenge: string, scope = ALL_SCOPES): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope,
    state: "s1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
  });
  return `/api/auth/oauth2/authorize?${q}`;
}

/** GET the authorise endpoint without following its redirect, as a browser hands it back to the page. */
function authorize(path: string, cookie?: string): Promise<Response> {
  return SELF.fetch(`https://test${path}`, {
    redirect: "manual",
    headers: cookie ? { Cookie: cookie } : {},
  });
}

/** The token endpoint takes a form, not JSON (RFC 6749 §4.1.3). */
function tokenRequest(form: Record<string, string>): Promise<Response> {
  return SELF.fetch("https://test/api/auth/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
}

interface Connection {
  clientId: string;
  access: string;
  refresh: string;
}

/** Register a client, consent as the signed-in user, and exchange the code. */
async function connect(cookie: string, scope = ALL_SCOPES): Promise<Connection> {
  const reg = await register(scope);
  expect(reg.status).toBe(201);
  const { client_id: clientId } = (await reg.json()) as { client_id: string };
  const { verifier, challenge } = await pkce();

  // Signed in already, so the provider goes straight to the consent page.
  const auth = await authorize(authorizeUrl(clientId, challenge, scope), cookie);
  expect(auth.status).toBe(302);
  const consentUrl = new URL(auth.headers.get("location")!, "http://localhost:8788");
  expect(consentUrl.pathname).toBe("/oauth/consent");

  const consent = await request("POST", "/api/auth/oauth2/consent", {
    cookie,
    headers: ORIGIN,
    body: { accept: true, oauth_query: consentUrl.search.slice(1) },
  });
  expect(consent.status).toBe(200);
  const { url } = (await consent.json()) as { url: string };
  const callback = new URL(url);
  expect(callback.origin + callback.pathname).toBe(REDIRECT);
  expect(callback.searchParams.get("state")).toBe("s1");

  const tok = await tokenRequest({
    grant_type: "authorization_code",
    code: callback.searchParams.get("code")!,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: verifier,
    resource: RESOURCE,
  });
  expect(tok.status).toBe(200);
  const body = (await tok.json()) as { access_token: string; refresh_token: string };
  return { clientId, access: body.access_token, refresh: body.refresh_token };
}

async function meWithBearer(token: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await request("GET", "/api/auth/me", { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function jwtPart(token: string, index: 0 | 1): Record<string, unknown> {
  const part = token.split(".")[index]!.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(part)) as Record<string, unknown>;
}

describe("discovery", () => {
  test("protected-resource metadata names the MCP resource and its issuer", async () => {
    const res = await request("GET", "/.well-known/oauth-protected-resource/mcp");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resource: string; authorization_servers: string[]; scopes_supported: string[] };
    expect(body.resource).toBe(RESOURCE);
    expect(body.authorization_servers).toEqual([ISSUER]);
    expect(body.scopes_supported).toEqual([...MCP_SCOPES]);
  });

  test("authorisation-server metadata is served at the issuer path and the bare root, without client_credentials", async () => {
    for (const path of [
      "/.well-known/oauth-authorization-server/api/auth",
      "/.well-known/oauth-authorization-server",
    ]) {
      const res = await request("GET", path);
      expect(res.status, path).toBe(200);
      const body = (await res.json()) as { issuer: string; grant_types_supported: string[] };
      expect(body.issuer).toBe(ISSUER);
      expect(body.grant_types_supported).not.toContain("client_credentials");
    }
  });

  test("other well-known paths are not Better Auth's to answer", async () => {
    expect((await request("GET", "/.well-known/oauth-protected-resource/elsewhere")).status).toBe(404);
  });
});

describe("registration", () => {
  test("a native client may register a loopback callback without naming its application type", async () => {
    expect((await register()).status).toBe(201);
  });

  test("a scope GlideComp doesn't offer is refused", async () => {
    expect((await register(`${ALL_SCOPES} admin:everything`)).status).toBe(400);
  });

  test("one client address may register only so many clients an hour", async () => {
    const ip = "198.51.100.77";
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await register(ALL_SCOPES, ip)).status);
    expect(statuses.slice(0, 10).every((s) => s === 201)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe("the flow", () => {
  test("PKCE is required", async () => {
    const cookie = await loginAs("pkce@example.com");
    const { client_id } = (await (await register()).json()) as { client_id: string };
    const q = new URLSearchParams({
      response_type: "code",
      client_id,
      redirect_uri: REDIRECT,
      scope: ALL_SCOPES,
      state: "s1",
      resource: RESOURCE,
    });
    const res = await authorize(`/api/auth/oauth2/authorize?${q}`, cookie);
    const location = res.headers.get("location") ?? "";
    // Refused either outright or by redirecting the error back to the client;
    // never on to consent.
    expect(location).not.toContain("/oauth/consent");
    expect(res.status === 400 || location.includes("error=")).toBe(true);
  });

  test("PKCE must be S256: a plain challenge is refused", async () => {
    const cookie = await loginAs("pkce-plain@example.com");
    const { client_id } = (await (await register()).json()) as { client_id: string };
    const q = new URLSearchParams(authorizeUrl(client_id, "a".repeat(43)).split("?")[1]);
    q.set("code_challenge_method", "plain");
    const res = await authorize(`/api/auth/oauth2/authorize?${q}`, cookie);
    const location = res.headers.get("location") ?? "";
    expect(location).not.toContain("/oauth/consent");
    expect(res.status === 400 || location.includes("error=")).toBe(true);
  });

  test("a redirect URI the client didn't register is never redirected to", async () => {
    const cookie = await loginAs("redirect@example.com");
    const { client_id } = (await (await register()).json()) as { client_id: string };
    const { challenge } = await pkce();
    for (const evil of ["https://evil.example/callback", `${REDIRECT}/../steal`, `${REDIRECT}?x=1`]) {
      const q = new URLSearchParams(authorizeUrl(client_id, challenge).split("?")[1]);
      q.set("redirect_uri", evil);
      const res = await authorize(`/api/auth/oauth2/authorize?${q}`, cookie);
      const location = res.headers.get("location") ?? "";
      expect(location, evil).not.toContain("/oauth/consent");
      expect(location.startsWith(evil.split("?")[0]!) && location !== "", evil).toBe(false);
    }
  });

  test("the code is good only with the redirect URI it was issued for", async () => {
    const cookie = await loginAs("redirect-code@example.com");
    const { client_id } = (await (await register()).json()) as { client_id: string };
    const { verifier, challenge } = await pkce();
    const auth = await authorize(authorizeUrl(client_id, challenge), cookie);
    const consentUrl = new URL(auth.headers.get("location")!, "http://localhost:8788");
    const consent = await request("POST", "/api/auth/oauth2/consent", {
      cookie,
      headers: ORIGIN,
      body: { accept: true, oauth_query: consentUrl.search.slice(1) },
    });
    const code = new URL(((await consent.json()) as { url: string }).url).searchParams.get("code")!;
    const tok = await tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://evil.example/callback",
      client_id,
      code_verifier: verifier,
      resource: RESOURCE,
    });
    expect(tok.status).toBe(400);
  });

  test("an access token is a short-lived at+jwt bound to the MCP resource, and /me answers with the grant", async () => {
    const cookie = await loginAs("organiser@example.com", "Org Aniser");
    const conn = await connect(cookie);

    expect(jwtPart(conn.access, 0).typ).toBe("at+jwt");
    const claims = jwtPart(conn.access, 1);
    expect(claims.iss).toBe(ISSUER);
    expect([claims.aud].flat()).toContain(RESOURCE);
    expect((claims.exp as number) - (claims.iat as number)).toBe(15 * 60);

    const me = await meWithBearer(conn.access);
    expect(me.status).toBe(200);
    expect((me.body.user as { email: string }).email).toBe("organiser@example.com");
    expect(me.body.grant).toEqual({
      kind: "oauth",
      client_id: conn.clientId,
      client_name: "Test assistant",
      scopes: ALL_SCOPES.split(" "),
    });
  });

  test("the client_credentials grant is refused", async () => {
    const { client_id } = (await (await register()).json()) as { client_id: string };
    const res = await tokenRequest({ grant_type: "client_credentials", client_id, scope: "comp:read" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("a refresh token mints a new access token while the grant stands", async () => {
    const cookie = await loginAs("refresh@example.com");
    const conn = await connect(cookie);
    const res = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: conn.refresh,
      client_id: conn.clientId,
      resource: RESOURCE,
    });
    expect(res.status).toBe(200);
    const { access_token } = (await res.json()) as { access_token: string };
    expect((await meWithBearer(access_token)).body.user).not.toBeNull();
  });
});

describe("tokens are not sessions, and sessions are not tokens", () => {
  test("an access token presented as the session-cache cookie is refused", async () => {
    const cookie = await loginAs("confusion-a@example.com");
    const conn = await connect(cookie);
    const res = await request("GET", "/api/auth/me", {
      cookie: `better-auth.session_data=${conn.access}`,
    });
    expect(((await res.json()) as { user: unknown }).user).toBeNull();
  });

  test("a session-cache JWT presented as a bearer token is refused", async () => {
    const cookie = await loginAs("confusion-b@example.com");
    // Read /me once so the session-cache cookie exists, then lift its JWT.
    const res = await request("GET", "/api/auth/me", { cookie });
    const jar = [cookie, ...res.headers.getSetCookie().map((c) => c.split(";")[0])].join("; ");
    const sessionJwt = /better-auth\.session_data=([^;]+)/.exec(jar)?.[1];
    expect(sessionJwt, "session-cache cookie").toBeTruthy();
    // The cookie value may carry a signature suffix; only a JWT-shaped bearer
    // takes the token path, and it must not verify as one.
    const jwt = sessionJwt!.split(".").slice(0, 3).join(".");
    expect((await meWithBearer(jwt)).body.user).toBeNull();
  });

  test("a garbage bearer token is nobody", async () => {
    expect((await meWithBearer("aaa.bbb.ccc")).body.user).toBeNull();
  });
});

describe("Settings → Connected AI Assistants", () => {
  test("lists the grant, and Disconnect stops the token and its refresh token at once", async () => {
    const cookie = await loginAs("disconnect@example.com");
    const conn = await connect(cookie);

    const list = await request("GET", "/api/auth/connected-assistants", { cookie });
    expect(list.status).toBe(200);
    const { assistants } = (await list.json()) as {
      assistants: Array<{ client_id: string; name: string; scopes: string[] }>;
    };
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({ client_id: conn.clientId, name: "Test assistant" });
    expect(assistants[0]!.scopes).toContain("task:write");

    const del = await request("DELETE", `/api/auth/connected-assistants/${conn.clientId}`, { cookie });
    expect(del.status).toBe(200);

    expect((await meWithBearer(conn.access)).body.user).toBeNull();
    const refreshed = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: conn.refresh,
      client_id: conn.clientId,
      resource: RESOURCE,
    });
    expect(refreshed.status).toBeGreaterThanOrEqual(400);

    const again = await request("DELETE", `/api/auth/connected-assistants/${conn.clientId}`, { cookie });
    expect(again.status).toBe(404);
  });

  test("one account cannot disconnect another's assistant", async () => {
    const owner = await loginAs("owner-a@example.com");
    const other = await loginAs("owner-b@example.com");
    const conn = await connect(owner);
    expect((await request("DELETE", `/api/auth/connected-assistants/${conn.clientId}`, { cookie: other })).status).toBe(404);
    expect((await meWithBearer(conn.access)).body.user).not.toBeNull();
  });

  test("signed out, there is nothing to list", async () => {
    expect((await request("GET", "/api/auth/connected-assistants")).status).toBe(401);
  });
});

describe("granting access takes a browser (SEC-57)", () => {
  async function apiKeyFor(cookie: string): Promise<string> {
    const res = await request("POST", "/api/auth/api-key/create", { cookie, body: { name: "agent" }, headers: ORIGIN });
    return ((await res.json()) as { key: string }).key;
  }

  test("an API key cannot authorise, consent, or see or revoke connected assistants", async () => {
    const cookie = await loginAs("key-holder@example.com");
    const key = await apiKeyFor(cookie);
    const { client_id } = (await (await register()).json()) as { client_id: string };
    const { challenge } = await pkce();
    for (const [method, path] of [
      ["GET", authorizeUrl(client_id, challenge)],
      ["POST", "/api/auth/oauth2/consent"],
      ["POST", "/api/auth/oauth2/continue"],
      ["GET", "/api/auth/connected-assistants"],
      ["DELETE", `/api/auth/connected-assistants/${client_id}`],
    ] as const) {
      const res = await request(method, path, { headers: { "x-api-key": key } });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("BROWSER_SESSION_REQUIRED");
    }
  });

  test("neither can an access token", async () => {
    const cookie = await loginAs("token-holder@example.com");
    const conn = await connect(cookie);
    const res = await request("GET", "/api/auth/connected-assistants", {
      headers: { Authorization: `Bearer ${conn.access}` },
    });
    expect(res.status).toBe(403);
  });
});

describe("budget", () => {
  test("one grant may make only so many calls a minute", async () => {
    const cookie = await loginAs("busy@example.com");
    const conn = await connect(cookie);
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await meWithBearer(conn.access)).status;
    expect(last).toBe(429);
  });
});

describe("account deletion", () => {
  test("takes the account's grants with it", async () => {
    const cookie = await loginAs("leaving@example.com");
    await connect(cookie);
    const res = await request("POST", "/api/auth/delete-account", { cookie, headers: ORIGIN });
    expect(res.status).toBe(200);
    const left = await env.glidecomp_auth
      .prepare(
        `SELECT (SELECT COUNT(*) FROM "oauthConsent" c LEFT JOIN "user" u ON u.id = c."userId" WHERE u.id IS NULL) AS consents,
                (SELECT COUNT(*) FROM "oauthRefreshToken" t LEFT JOIN "user" u ON u.id = t."userId" WHERE u.id IS NULL) AS tokens`
      )
      .first<{ consents: number; tokens: number }>();
    expect(left).toEqual({ consents: 0, tokens: 0 });
  });
});
