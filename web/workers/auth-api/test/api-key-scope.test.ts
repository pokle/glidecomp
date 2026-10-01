// SEC-57: an API key is a session for using GlideComp, not for managing the
// account it belongs to. Each refused request below was an exploit path
// before the guard in src/index.ts: a leaked key could mint a second key that
// outlived revoking the first, revoke its owner's keys, rename the account,
// and delete it with every file in it.

import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { requiresBrowserSession } from "../src/endpoints";
import { loginAs, request } from "./helpers";

// Better Auth's CSRF guard requires a trusted Origin on its POST endpoints.
const ORIGIN = { Origin: "http://localhost:8788" };

async function createApiKey(cookie: string): Promise<{ id: string; key: string }> {
  const res = await request("POST", "/api/auth/api-key/create", {
    cookie,
    body: { name: "agent" },
    headers: ORIGIN,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string; key: string };
}

async function keyCount(email: string): Promise<number> {
  const row = await env.glidecomp_auth
    .prepare(
      'SELECT COUNT(*) AS n FROM apikey WHERE "referenceId" = (SELECT id FROM "user" WHERE email = ?)'
    )
    .bind(email)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function expectRefused(res: Response): Promise<void> {
  expect(res.status).toBe(403);
  const body = (await res.json()) as { code?: string };
  expect(body.code).toBe("BROWSER_SESSION_REQUIRED");
}

describe("requiresBrowserSession", () => {
  test.each([
    "/api/auth/api-key/create",
    "/api/auth/api-key/list",
    "/api/auth/api-key/delete",
    "/api/auth/api-key/update",
    "/api/auth/delete-account",
    "/api/auth/set-username",
    "/api/auth/set-name",
  ])("%s", (path) => {
    expect(requiresBrowserSession(path)).toBe(true);
  });

  test.each([
    "/api/auth/me",
    "/api/auth/preferences",
    "/api/auth/get-session",
    "/api/auth/sign-out",
    "/api/auth/set-name-extra",
    "/api/comp/api-key/create",
  ])("not %s", (path) => {
    expect(requiresBrowserSession(path)).toBe(false);
  });
});

describe("an API key cannot manage the account (SEC-57)", () => {
  test("cannot create another key", async () => {
    const email = "sec57-create@test.com";
    const { key } = await createApiKey(await loginAs(email));

    const res = await request("POST", "/api/auth/api-key/create", {
      body: { name: "persistence" },
      headers: { ...ORIGIN, "x-api-key": key },
    });
    await expectRefused(res);
    expect(await keyCount(email)).toBe(1);
  });

  test("cannot list or revoke its owner's keys", async () => {
    const email = "sec57-revoke@test.com";
    const cookie = await loginAs(email);
    const { key } = await createApiKey(cookie);
    const other = await createApiKey(cookie);

    await expectRefused(
      await request("GET", "/api/auth/api-key/list", { headers: { "x-api-key": key } })
    );
    await expectRefused(
      await request("POST", "/api/auth/api-key/delete", {
        body: { keyId: other.id },
        headers: { ...ORIGIN, "x-api-key": key },
      })
    );
    expect(await keyCount(email)).toBe(2);
  });

  test("cannot delete the account", async () => {
    const email = "sec57-delete@test.com";
    const { key } = await createApiKey(await loginAs(email));

    await expectRefused(
      await request("POST", "/api/auth/delete-account", { headers: { "x-api-key": key } })
    );
    const me = await request("GET", "/api/auth/me", { headers: { "x-api-key": key } });
    const body = (await me.json()) as { user: { email: string } | null };
    expect(body.user?.email).toBe(email);
  });

  test("cannot rename the account or its handle", async () => {
    const email = "sec57-rename@test.com";
    const { key } = await createApiKey(await loginAs(email, "Original Name"));

    await expectRefused(
      await request("POST", "/api/auth/set-name", {
        body: { name: "Someone Else" },
        headers: { "x-api-key": key },
      })
    );
    await expectRefused(
      await request("POST", "/api/auth/set-username", {
        body: { username: "sec57-taken" },
        headers: { "x-api-key": key },
      })
    );
    const row = await env.glidecomp_auth
      .prepare('SELECT name, username FROM "user" WHERE email = ?')
      .bind(email)
      .first<{ name: string; username: string }>();
    expect(row?.name).toBe("Original Name");
    expect(row?.username).not.toBe("sec57-taken");
  });

  test("is refused even beside a valid session cookie, because the key wins", async () => {
    // The plugin resolves the KEY's session when both are sent, so a cookie
    // riding along must not be what lets the request through.
    const email = "sec57-both@test.com";
    const cookie = await loginAs(email);
    const { key } = await createApiKey(cookie);

    const res = await request("POST", "/api/auth/api-key/create", {
      cookie,
      body: { name: "persistence" },
      headers: { ...ORIGIN, "x-api-key": key },
    });
    await expectRefused(res);
    expect(await keyCount(email)).toBe(1);
  });

  test("still answers /me and preferences, which are what a key is for", async () => {
    const email = "sec57-use@test.com";
    const { key } = await createApiKey(await loginAs(email));

    const me = await request("GET", "/api/auth/me", { headers: { "x-api-key": key } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { email: string } }).user.email).toBe(email);

    const prefs = await request("GET", "/api/auth/preferences", {
      headers: { "x-api-key": key },
    });
    expect(prefs.status).toBe(200);
  });

  test("a browser session still manages keys, and sees when each was last used", async () => {
    const email = "sec57-browser@test.com";
    const cookie = await loginAs(email);
    const { id, key } = await createApiKey(cookie);
    await request("GET", "/api/auth/me", { headers: { "x-api-key": key } });

    const list = await request("GET", "/api/auth/api-key/list", { cookie });
    expect(list.status).toBe(200);
    // Settings' "Last used" column reads this field by this name; it once
    // read `lastUsedAt`, which the plugin never sends, and said "Never".
    const { apiKeys } = (await list.json()) as {
      apiKeys: Array<{ id: string; lastRequest: string | null }>;
    };
    expect(apiKeys.find((k) => k.id === id)?.lastRequest).toEqual(expect.any(String));
    const del = await request("POST", "/api/auth/api-key/delete", {
      cookie,
      body: { keyId: id },
      headers: ORIGIN,
    });
    expect(del.status).toBe(200);
    expect(await keyCount(email)).toBe(0);
  });
});
