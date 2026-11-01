/**
 * A hidden competition's share link: the comp's id with its secret key after
 * it (`vzuq_7hq2m9xk4rwd`, src/share-key.ts).
 *
 * The id alone is no secret — ids are sequential in a public encoding — so a
 * hidden comp must stay a 404 to anyone without the key, and a wrong key must
 * be no better than none. With the key, every READ opens and every WRITE stays
 * admin-only. The key itself is told only to someone who can already see the
 * comp, and never written into the audit log a key holder can read.
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import {
  authRequest,
  clearCompData,
  createComp,
  createTask,
  request,
} from "./helpers";
import { SHARE_KEY_RE, newShareKey, splitCompRef, shareKeyMatches } from "../src/share-key";
import { encodeId } from "../src/sqids";

beforeEach(async () => {
  await clearCompData();
});

/** A hidden comp, owned by user-1, plus its key as the API tells its admin. */
async function hiddenComp(name = "Draft Cup"): Promise<{ compId: string; key: string }> {
  const compId = await createComp({ name, test: true });
  const res = await authRequest("GET", `/api/comp/${compId}`);
  const body = (await res.json()) as { share_key: string | null };
  expect(body.share_key).toMatch(SHARE_KEY_RE);
  return { compId, key: body.share_key! };
}

describe("share-key helpers", () => {
  test("newShareKey makes 12 characters of [a-z0-9], different each time", () => {
    const keys = new Set(Array.from({ length: 50 }, () => newShareKey()));
    expect(keys.size).toBe(50);
    for (const k of keys) expect(k).toMatch(SHARE_KEY_RE);
  });

  test("splitCompRef separates the sqid from the key and refuses a mangled key", () => {
    expect(splitCompRef("vzuq")).toEqual({ sqid: "vzuq" });
    expect(splitCompRef("vzuq_7hq2m9xk4rwd")).toEqual({ sqid: "vzuq", key: "7hq2m9xk4rwd" });
    expect(splitCompRef("vzuq_")).toBeNull();
    expect(splitCompRef("vzuq_short")).toBeNull();
    expect(splitCompRef("vzuq_7HQ2M9XK4RWD")).toBeNull();
    expect(splitCompRef("_7hq2m9xk4rwd")).toBeNull();
  });

  test("shareKeyMatches needs both sides and an exact match", () => {
    expect(shareKeyMatches("7hq2m9xk4rwd", "7hq2m9xk4rwd")).toBe(true);
    expect(shareKeyMatches("7hq2m9xk4rwe", "7hq2m9xk4rwd")).toBe(false);
    expect(shareKeyMatches(undefined, "7hq2m9xk4rwd")).toBe(false);
    expect(shareKeyMatches("7hq2m9xk4rwd", null)).toBe(false);
    expect(shareKeyMatches("", "")).toBe(false);
  });
});

describe("every key is minted by the Worker", () => {
  /** A hidden comp written straight to the database, as the seeder and the
   * importer do (and as every comp predating migration 0041 was), with
   * user-1 as its admin. */
  async function keylessHiddenComp(): Promise<{ id: number; sqid: string }> {
    const res = await env.DB.prepare(
      `INSERT INTO comp (name, creation_date, close_date, category, test, pilot_classes, default_pilot_class)
       VALUES ('Seeded', '2026-01-01T00:00:00Z', NULL, 'hg', 1, '["open"]', 'open')`
    ).run();
    const id = res.meta.last_row_id as number;
    await env.DB.prepare("INSERT INTO comp_admin (comp_id, user_id) VALUES (?, 'user-1')")
      .bind(id)
      .run();
    return { id, sqid: encodeId(env.SQIDS_ALPHABET, id) };
  }

  async function storedKey(id: number): Promise<string | null> {
    const row = await env.DB.prepare("SELECT share_key FROM comp WHERE comp_id = ?")
      .bind(id)
      .first<{ share_key: string | null }>();
    return row?.share_key ?? null;
  }

  test("the database mints nothing: a comp written straight to it has no key", async () => {
    // No backfill and no trigger in migration 0041. SQLite's random() is not
    // documented as cryptographically secure, so a key never comes from SQL.
    const { id } = await keylessHiddenComp();
    expect(await storedKey(id)).toBeNull();
  });

  test("its admin opening it mints one, and the same key every time after", async () => {
    const { id, sqid } = await keylessHiddenComp();
    const first = (await (await authRequest("GET", `/api/comp/${sqid}`)).json()) as any;
    expect(first.share_key).toMatch(SHARE_KEY_RE);
    expect(await storedKey(id)).toBe(first.share_key);
    const again = (await (await authRequest("GET", `/api/comp/${sqid}`)).json()) as any;
    expect(again.share_key).toBe(first.share_key);
  });

  test("nobody else's visit mints one, and a keyless hidden comp opens for no key", async () => {
    const { id, sqid } = await keylessHiddenComp();
    expect((await request("GET", `/api/comp/${sqid}`)).status).toBe(404);
    expect((await request("GET", `/api/comp/${sqid}_${"a".repeat(12)}`)).status).toBe(404);
    expect(await storedKey(id)).toBeNull();
  });

  test("hiding a public comp that has no key mints one for its admin", async () => {
    const compId = await createComp({ name: "Was public" });
    const { id } = await env.DB.prepare("SELECT comp_id AS id FROM comp WHERE name = 'Was public'")
      .first<{ id: number }>() as { id: number };
    await env.DB.prepare("UPDATE comp SET share_key = NULL WHERE comp_id = ?").bind(id).run();

    const res = await authRequest("PATCH", `/api/comp/${compId}`, { test: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { share_key: string | null };
    expect(body.share_key).toMatch(SHARE_KEY_RE);
    expect(await storedKey(id)).toBe(body.share_key);
  });

  test("creating a hidden comp answers with its key; a public one with none", async () => {
    const hidden = await authRequest("POST", "/api/comp", {
      name: "Hidden",
      category: "hg",
    });
    expect(((await hidden.json()) as any).share_key).toMatch(SHARE_KEY_RE);

    const open = await authRequest("POST", "/api/comp", {
      name: "Open",
      category: "hg",
      test: false,
    });
    expect(((await open.json()) as any).share_key).toBeNull();
  });
});

describe("reading a hidden comp with its link", () => {
  test("the id alone is a 404 to someone signed out, and to another account", async () => {
    const { compId } = await hiddenComp();
    expect((await request("GET", `/api/comp/${compId}`)).status).toBe(404);
    expect(
      (await request("GET", `/api/comp/${compId}`, { user: "user-2" })).status
    ).toBe(404);
  });

  test("the id with its key opens the comp, signed out", async () => {
    const { compId, key } = await hiddenComp("Draft Cup");
    const res = await request("GET", `/api/comp/${compId}_${key}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.name).toBe("Draft Cup");
    expect(body.is_admin).toBe(false);
    // The visitor already holds the key; echoing it lets the page keep it in
    // every link it builds.
    expect(body.share_key).toBe(key);
  });

  test("a wrong key is no better than none", async () => {
    const { compId } = await hiddenComp();
    const res = await request("GET", `/api/comp/${compId}_${"a".repeat(12)}`);
    expect(res.status).toBe(404);
  });

  test("a malformed key is a 400, not a quietly dropped key", async () => {
    const { compId } = await hiddenComp();
    expect((await request("GET", `/api/comp/${compId}_nope`)).status).toBe(400);
  });

  test("a keyed response is never stored by a shared cache or indexed", async () => {
    const { compId, key } = await hiddenComp();
    const taskId = await createTask(compId);
    for (const path of [
      `/api/comp/${compId}_${key}`,
      `/api/comp/${compId}_${key}/scores`,
      `/api/comp/${compId}_${key}/task/${taskId}/score`,
    ]) {
      const res = await request("GET", path);
      // A task with no route answers its score with 422 — past the gate,
      // which is all this test needs.
      expect(res.status, path).not.toBe(404);
      expect(res.headers.get("Cache-Control"), path).toBe("private, no-store");
      expect(res.headers.get("X-Robots-Tag"), path).toBe("noindex");
    }
  });

  test("the key opens every read route under the comp", async () => {
    const { compId, key } = await hiddenComp();
    const taskId = await createTask(compId);
    await authRequest("POST", `/api/comp/${compId}/pilot`, {
      registered_pilot_name: "Jane Smith",
      pilot_class: "open",
      registered_pilot_email: "jane@elsewhere.example",
    });

    const ref = `${compId}_${key}`;
    for (const path of [
      `/api/comp/${ref}/pilot`,
      `/api/comp/${ref}/scores`,
      `/api/comp/${ref}/audit`,
      `/api/comp/${ref}/analysis`,
      `/api/comp/${ref}/waypoints`,
      `/api/comp/${ref}/task/${taskId}`,
      `/api/comp/${ref}/task/${taskId}/igc`,
      `/api/comp/${ref}/task/${taskId}/pilot-status`,
      `/api/comp/${ref}/task/${taskId}/manual-flight`,
    ]) {
      const keyed = await request("GET", path);
      expect(keyed.status, path).not.toBe(404);
      expect(keyed.status, path).toBeLessThan(500);
      // ...and each of them is still a 404 without the key.
      const bare = await request("GET", path.replace(ref, compId));
      expect(bare.status, path).toBe(404);
    }
  });

  test("the roster a link visitor reads is the public one, PII redacted", async () => {
    const { compId, key } = await hiddenComp();
    await authRequest("POST", `/api/comp/${compId}/pilot`, {
      registered_pilot_name: "Jane Smith",
      pilot_class: "open",
      registered_pilot_email: "jane@elsewhere.example",
    });
    const res = await request("GET", `/api/comp/${compId}_${key}/pilot`);
    const text = await res.text();
    expect(text).toContain("Jane Smith");
    expect(text).not.toContain("jane@elsewhere.example");
  });

  test("a public comp ignores a key, and never tells anyone its own", async () => {
    const compId = await createComp({ name: "Open Cup" });
    const anon = await request("GET", `/api/comp/${compId}`);
    expect(((await anon.json()) as any).share_key).toBeNull();
    const admin = await authRequest("GET", `/api/comp/${compId}`);
    expect(((await admin.json()) as any).share_key).toBeNull();
    // A stale key on a public comp still opens it — it is public.
    const keyed = await request("GET", `/api/comp/${compId}_${"b".repeat(12)}`);
    expect(keyed.status).toBe(200);
  });
});

describe("the link opens a hidden comp for reading only", () => {
  test("registration/resolve still answers a key holder as a missing comp", async () => {
    // It reads out the unclaimed roster's masked emails (SEC-37): a write
    // route's gate, which a shared link does not open.
    const { compId, key } = await hiddenComp();
    const res = await request("POST", `/api/comp/${compId}_${key}/registration/resolve`, {
      body: {},
      user: "user-2",
    });
    expect(res.status).toBe(404);
  });

  test("the comp's admin can still write through a keyed URL", async () => {
    const { compId, key } = await hiddenComp();
    const res = await authRequest("POST", `/api/comp/${compId}_${key}/pilot`, {
      registered_pilot_name: "Joe Bloggs",
      pilot_class: "open",
    });
    expect(res.status).toBeLessThan(300);
  });
});

describe("who is told the key", () => {
  test("the comp list gives an admin the key to their own hidden comps only", async () => {
    const { compId, key } = await hiddenComp("Mine");
    const publicId = await createComp({ name: "Everyone's" });

    const mine = (await (await authRequest("GET", "/api/comp")).json()) as any;
    const byId = new Map(mine.comps.map((c: any) => [c.comp_id, c]));
    expect((byId.get(compId) as any).share_key).toBe(key);
    expect((byId.get(publicId) as any).share_key).toBeNull();

    const theirs = (await (
      await request("GET", "/api/comp", { user: "user-2" })
    ).json()) as any;
    expect(JSON.stringify(theirs)).not.toContain(key);
  });

  test("no non-admin response names the key unless the request already carried it", async () => {
    const { compId, key } = await hiddenComp();
    await env.DB.prepare("UPDATE comp SET test = 0 WHERE comp_id IS NOT NULL").run();
    // Now public: the key must not leak out of any public read.
    for (const path of [`/api/comp/${compId}`, "/api/comp", `/api/comp/${compId}/audit`]) {
      const text = await (await request("GET", path)).text();
      expect(text, path).not.toContain(key);
    }
  });
});

describe("resetting the link", () => {
  test("a new key retires the old one, and the audit log never names either", async () => {
    const { compId, key: oldKey } = await hiddenComp("Draft Cup");
    const res = await authRequest("POST", `/api/comp/${compId}/share-key`);
    expect(res.status).toBe(200);
    const { share_key: newKey } = (await res.json()) as { share_key: string };
    expect(newKey).toMatch(SHARE_KEY_RE);
    expect(newKey).not.toBe(oldKey);

    expect((await request("GET", `/api/comp/${compId}_${oldKey}`)).status).toBe(404);
    expect((await request("GET", `/api/comp/${compId}_${newKey}`)).status).toBe(200);

    const audit = await request("GET", `/api/comp/${compId}_${newKey}/audit`);
    const text = await audit.text();
    expect(text).toContain("Reset the link");
    expect(text).not.toContain(oldKey);
    expect(text).not.toContain(newKey);
  });

  test("only an admin may reset it, and a key holder is not one", async () => {
    const { compId, key } = await hiddenComp();
    const res = await request("POST", `/api/comp/${compId}_${key}/share-key`, {
      user: "user-2",
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await request("GET", `/api/comp/${compId}_${key}`)).status).toBe(200);
  });
});
