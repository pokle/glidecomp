/**
 * An organiser's own assistant, end to end (docs/2026-10-24-mcp-oauth-plan.md,
 * docs/mcp.md): an MCP client registers itself, the organiser consents in the
 * browser, the client trades the code for a token and reads GlideComp through
 * /mcp, creates a task and sets its route — then Disconnect in Settings stops
 * it on its next request.
 *
 * The client here is Playwright's request API speaking OAuth and JSON-RPC by
 * hand, which is what keeps the spec honest about the wire: discovery from the
 * 401's challenge, PKCE, the `resource` parameter, and both protocol revisions
 * the endpoint serves (2025-11-25 and 2026-07-28).
 */
import crypto from "node:crypto";
import { test, expect } from "./fixtures/test";
import { E2E_ORGANISER, e2eCompName } from "./fixtures/stack";

const CLIENT_NAME = "E2E MCP client";
const REDIRECT = "http://127.0.0.1:8977/callback";
const SCOPE = "openid profile offline_access comp:read task:write";
const COMP_NAME = e2eCompName(`MCP ${Date.now()}`);

let compId: string | null = null;

const b64url = (buf: Buffer) => buf.toString("base64url");

test.afterEach(async ({ page }) => {
  if (!compId) return;
  const res = await page.request.delete(`/api/comp/${compId}`);
  expect(res.status(), `cleanup: DELETE /api/comp/${compId}`).toBe(200);
  compId = null;
});

test("an organiser connects an assistant, it reads their comp and sets a route, and Disconnect stops it", async ({
  page,
  playwright,
  baseURL,
}) => {
  // The assistant: its own request context, so it never carries the
  // organiser's browser session — everything it gets, it gets from the token.
  const client = await playwright.request.newContext({ baseURL });

  // Signed in as the organiser, with a hidden comp only they can see.
  const login = await page.request.post("/api/auth/dev-login", { data: E2E_ORGANISER });
  expect(login.ok(), await login.text()).toBe(true);
  const session = login.headers()["set-cookie"]?.match(/better-auth\.session_token=([^;]+)/);
  if (session) {
    await page.context().addCookies([
      { name: "better-auth.session_token", value: session[1]!, domain: "localhost", path: "/" },
    ]);
  }
  const created = await page.request.post("/api/comp", { data: { name: COMP_NAME, category: "hg", test: true } });
  expect(created.ok(), await created.text()).toBe(true);
  compId = ((await created.json()) as { comp_id: string }).comp_id;

  // Discovery, as a client starts it: from /mcp's challenge.
  const challenge = await client.post("/mcp", { data: {} });
  expect(challenge.status()).toBe(401);
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge.headers()["www-authenticate"] ?? "")?.[1];
  expect(metadataUrl, "resource_metadata in the challenge").toBeTruthy();
  const resource = (await (await client.get(metadataUrl!)).json()) as {
    resource: string;
    authorization_servers: string[];
  };
  const issuer = new URL(resource.authorization_servers[0]!);
  const as = (await (
    await client.get(`/.well-known/oauth-authorization-server${issuer.pathname}`)
  ).json()) as {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint: string;
    authorization_response_iss_parameter_supported?: boolean;
  };
  // RFC 9207: the server says it names itself in the redirect (OAuth 2.1
  // draft 16 makes sending `iss` a MUST; MCP 2026-07-28 has clients check it).
  expect(as.authorization_response_iss_parameter_supported).toBe(true);

  // Dynamic registration — a native client's loopback callback, no application_type.
  const reg = await client.post(as.registration_endpoint, {
    data: {
      client_name: CLIENT_NAME,
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: SCOPE,
    },
  });
  expect(reg.status(), await reg.text()).toBe(201);
  const clientId = ((await reg.json()) as { client_id: string }).client_id;

  // Authorise with PKCE; signed in already, so straight to consent.
  const verifier = b64url(crypto.randomBytes(32));
  const challengeHash = b64url(crypto.createHash("sha256").update(verifier).digest());
  const authorize = new URL(as.authorization_endpoint);
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: SCOPE,
    state: "e2e-state",
    code_challenge: challengeHash,
    code_challenge_method: "S256",
    resource: resource.resource,
  })) {
    authorize.searchParams.set(k, v);
  }

  let callback: URL | null = null;
  await page.route("http://127.0.0.1:8977/**", (route) => {
    callback = new URL(route.request().url());
    return route.fulfill({ body: "ok" });
  });
  await page.goto(authorize.toString());
  await expect(page).toHaveURL(/\/oauth\/consent/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Let ${CLIENT_NAME} use GlideComp as you?`);
  await expect(page.getByRole("listitem").filter({ hasText: "Create tasks and change their routes" })).toBeVisible();
  await page.getByRole("button", { name: "Allow", exact: true }).click();
  await expect.poll(() => callback?.searchParams.get("code") ?? null).not.toBeNull();
  expect(callback!.searchParams.get("state")).toBe("e2e-state");
  // The code comes back with the issuer that minted it, compared as an exact
  // string, as a client must before redeeming it (mix-up defence).
  expect(callback!.searchParams.get("iss")).toBe(as.issuer);

  const tokenRes = await client.post(as.token_endpoint, {
    form: {
      grant_type: "authorization_code",
      code: callback!.searchParams.get("code")!,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
      resource: resource.resource,
    },
  });
  expect(tokenRes.status(), await tokenRes.text()).toBe(200);
  const accessToken = ((await tokenRes.json()) as { access_token: string }).access_token;

  // MCP, on the 2025 protocol revision that hosted clients still speak.
  async function rpc(method: string, params: unknown) {
    const res = await client.post("/mcp", {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25",
      },
      data: { jsonrpc: "2.0", id: 1, method, params },
    });
    const text = await res.text();
    const body = text.trimStart().startsWith("{")
      ? JSON.parse(text)
      : JSON.parse(text.split("\n").find((l) => l.startsWith("data:"))?.slice(5) ?? "null");
    return { status: res.status(), headers: res.headers(), body };
  }

  const init = await rpc("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "e2e", version: "1" },
  });
  expect(init.status).toBe(200);
  expect(init.body.result.serverInfo.name).toBe("glidecomp");

  const mine = await rpc("tools/call", { name: "list_competitions", arguments: { mine: true } });
  const comps = mine.body.result.structuredContent.comps as Array<{ comp_id: string; hidden: boolean }>;
  expect(comps.find((c) => c.comp_id === compId)).toMatchObject({ hidden: true });

  const got = await rpc("tools/call", { name: "get_competition", arguments: { comp_id: compId } });
  expect(got.body.result.structuredContent).toMatchObject({ name: COMP_NAME });
  expect(got.body.result.structuredContent.url).toContain(`/comp/`);

  // The same token on the 2026-07-28 revision: no initialize; the revision and
  // the client's capabilities ride in every request's _meta, the method and
  // tool name in headers the transport checks against the body.
  async function rpc2026(method: string, params: Record<string, unknown>, bearer: string | null = accessToken) {
    const res = await client.post("/mcp", {
      headers: {
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": method,
        ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
      },
      data: {
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": { name: "e2e", version: "1" },
          },
        },
      },
    });
    const text = await res.text();
    const body = res.status() === 200
      ? text.trimStart().startsWith("{")
        ? JSON.parse(text)
        : JSON.parse(text.split("\n").find((l) => l.startsWith("data:"))?.slice(5) ?? "null")
      : null;
    return { status: res.status(), headers: res.headers(), body, text };
  }
  const discovered = await rpc2026("server/discover", {});
  expect(discovered.status, discovered.text).toBe(200);
  expect(discovered.body.result.supportedVersions).toContain("2026-07-28");
  // Straight to a tool call: no handshake, and no session handed back.
  const got2026 = await rpc2026("tools/call", { name: "get_competition", arguments: { comp_id: compId } });
  expect(got2026.status, got2026.text).toBe(200);
  expect(got2026.headers["mcp-session-id"]).toBeUndefined();
  expect(got2026.body.result.structuredContent).toMatchObject({ name: COMP_NAME });
  // Stateless: the call just served proves nothing for the next one, which
  // must carry its own token.
  expect((await rpc2026("tools/call", { name: "get_competition", arguments: { comp_id: compId } }, null)).status).toBe(401);

  // Writing (task:write): the comp needs waypoints for a route to name.
  const wps = await page.request.put(`/api/comp/${compId}/waypoints`, {
    data: {
      waypoints: [
        { code: "ELLIOT", name: "Mt Elliot", latitude: -36.1856, longitude: 147.9745, altitude: 1290, radius: 0 },
        { code: "TOWONG", name: "Towong", latitude: -36.1236, longitude: 147.9893, altitude: 290, radius: 0 },
        { code: "CORRY", name: "Corryong goal", latitude: -36.1958, longitude: 147.8975, radius: 0 },
      ],
    },
  });
  expect(wps.ok(), await wps.text()).toBe(true);

  const call = async (name: string, args: Record<string, unknown>) =>
    (await rpc("tools/call", { name, arguments: args })).body.result as {
      isError?: boolean;
      content: Array<{ text: string }>;
      structuredContent: Record<string, any>;
    };

  const task = await call("create_task", { comp_id: compId, name: "Task 1", task_date: "2026-01-05" });
  expect(task.isError, task.content[0]?.text).toBeFalsy();
  const taskId = task.structuredContent.task_id as string;

  // A loose line is read, and shown — but it can't be saved.
  const loose = await call("preview_route", { comp_id: compId, task_id: taskId, line: "ell to, ELLIOT 5k sss, towong, corry goal" });
  expect(loose.structuredContent.ready).toBe(false);
  expect(loose.structuredContent.turnpoints[0]).toMatchObject({ typed: "ell", read_as: "ELLIOT", exact: false });
  const refused = await call("set_task_route", { comp_id: compId, task_id: taskId, line: "ell to, ELLIOT 5k sss, towong, corry goal", route_rev: null });
  expect(refused.isError).toBe(true);

  // The tidied line, every name exact, is.
  const exact = await call("preview_route", {
    comp_id: compId,
    task_id: taskId,
    line: "ELLIOT 400m to, ELLIOT 5k sss exit 02:30, TOWONG 400m, CORRY 400m goal",
  });
  expect(exact.structuredContent.ready, exact.content[0]?.text).toBe(true);
  const saved = await call("set_task_route", { comp_id: compId, task_id: taskId, line: exact.structuredContent.line, route_rev: null });
  expect(saved.isError, saved.content[0]?.text).toBeFalsy();
  expect(saved.structuredContent.route.turnpoints.map((t: { name: string }) => t.name)).toEqual(["ELLIOT", "ELLIOT", "TOWONG", "CORRY"]);

  // The organiser sees it on the task page, and the log says how it was made.
  await page.goto(saved.structuredContent.url);
  await expect(page.getByText("TOWONG").first()).toBeVisible();
  const audit = (await (await page.request.get(`/api/comp/${compId}/audit?subject_type=task`)).json()) as {
    entries: Array<{ actor_name: string; description: string }>;
  };
  expect(audit.entries.length).toBeGreaterThanOrEqual(2);
  for (const e of audit.entries) {
    expect(e.actor_name).toBe(E2E_ORGANISER.name);
    expect(e.description).toMatch(new RegExp(`\\(via ${CLIENT_NAME}\\)$`));
  }

  // Disconnect, the way the organiser would: Settings → Connected AI Assistants.
  // Arriving the way /assistant's "Disconnect" link sends you: straight to
  // the section, which sits well below the fold on a phone.
  await page.goto("/settings#connected-ai-assistants");
  await expect(page.locator("#connected-ai-assistants")).toBeInViewport();
  const row = page.getByRole("list", { name: "Connected AI Assistants" }).getByRole("listitem").filter({ hasText: CLIENT_NAME });
  await expect(row).toContainText("can change tasks");
  await row.getByRole("button", { name: "Disconnect" }).click();
  await expect(row).toHaveCount(0);

  // The next request is refused with a challenge, so the client signs in again.
  const after = await rpc("tools/list", {});
  expect(after.status).toBe(401);
  expect(after.headers["www-authenticate"]).toContain("invalid_token");
  // On either revision: no session outlives the grant.
  const after2026 = await rpc2026("tools/list", {});
  expect(after2026.status).toBe(401);
  expect(after2026.headers["www-authenticate"]).toContain("invalid_token");
  await client.dispose();
});
