/**
 * The app's notifications (mobile plan stage 9, migration 0038): devices
 * register, accounts follow competitions, and a message goes only to the
 * followers it concerns, never to the account that caused it.
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { followers, pushToUsers } from "../src/push";
import { authRequest, clearCompData, createComp, request } from "./helpers";

const TOKEN = "ExponentPushToken[abc123DEF]";
const OTHER = "ExponentPushToken[zzz999]";

describe("notifications", () => {
  let compId: string;

  beforeEach(async () => {
    await clearCompData();
    compId = await createComp();
  });

  const numericId = async () =>
    (await env.DB.prepare("SELECT MAX(comp_id) AS id FROM comp").first<{ id: number }>())!.id;

  test("a device registers, and moves with the account that signs in on it", async () => {
    expect((await authRequest("PUT", "/api/user/push-token", { token: TOKEN, platform: "ios" })).status).toBe(200);
    await request("PUT", "/api/user/push-token", { body: { token: TOKEN, platform: "ios" }, user: "user-2" });
    const row = await env.DB.prepare("SELECT user_id FROM push_token WHERE token = ?").bind(TOKEN).first<{ user_id: string }>();
    expect(row?.user_id).toBe("user-2");
  });

  test("refuses anything that is not an Expo push token, and anyone signed out", async () => {
    expect((await authRequest("PUT", "/api/user/push-token", { token: "hello", platform: "ios" })).status).toBe(400);
    expect((await request("PUT", "/api/user/push-token", { body: { token: TOKEN, platform: "ios" } })).status).toBe(401);
  });

  test("an account follows a comp and stops again", async () => {
    expect(await (await authRequest("GET", `/api/comp/${compId}/notify`)).json()).toEqual({ enabled: false });
    await authRequest("PUT", `/api/comp/${compId}/notify`, { enabled: true });
    expect(await (await authRequest("GET", `/api/comp/${compId}/notify`)).json()).toEqual({ enabled: true });
    await authRequest("PUT", `/api/comp/${compId}/notify`, { enabled: false });
    expect(await (await authRequest("GET", `/api/comp/${compId}/notify`)).json()).toEqual({ enabled: false });
  });

  test("a hidden comp is not there to follow for anyone but its organisers", async () => {
    const hidden = await createComp({ test: true });
    const res = await request("PUT", `/api/comp/${hidden}/notify`, { body: { enabled: true }, user: "user-3" });
    expect(res.status).toBe(404);
  });

  test("followers are the comp's, narrowed to one, and never the actor", async () => {
    await authRequest("PUT", `/api/comp/${compId}/notify`, { enabled: true });
    await request("PUT", `/api/comp/${compId}/notify`, { body: { enabled: true }, user: "user-2" });
    const id = await numericId();
    expect((await followers(env.DB, id)).sort()).toEqual(["user-1", "user-2"]);
    expect(await followers(env.DB, id, { except: "user-1" })).toEqual(["user-2"]);
    expect(await followers(env.DB, id, { only: "user-2" })).toEqual(["user-2"]);
    expect(await followers(env.DB, id, { only: null })).toEqual([]);
    expect(await followers(env.DB, id, { only: "user-9" })).toEqual([]);
  });

  test("sends one batch to every device, and forgets a device that is gone", async () => {
    await authRequest("PUT", "/api/user/push-token", { token: TOKEN, platform: "ios" });
    await authRequest("PUT", "/api/user/push-token", { token: OTHER, platform: "android" });
    const sent: unknown[] = [];
    const fakeSend = (async (_url: string, init?: RequestInit) => {
      const batch = JSON.parse(String(init?.body)) as { to: string }[];
      sent.push(...batch);
      return new Response(
        JSON.stringify({
          data: batch.map((m) => (m.to === OTHER ? { status: "error", details: { error: "DeviceNotRegistered" } } : { status: "ok" })),
        })
      );
    }) as typeof fetch;
    await pushToUsers(
      { DB: env.DB, PUSH_ENDPOINT: "https://push.test/send" },
      ["user-1"],
      { title: "T", body: "B", url: "/comp/x" },
      fakeSend
    );
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ title: "T", body: "B", data: { url: "/comp/x" } });
    const left = await env.DB.prepare("SELECT token FROM push_token").all<{ token: string }>();
    expect(left.results.map((r) => r.token)).toEqual([TOKEN]);
  });

  test("sends nothing without an endpoint", async () => {
    await authRequest("PUT", "/api/user/push-token", { token: TOKEN, platform: "ios" });
    let called = false;
    await pushToUsers({ DB: env.DB }, ["user-1"], { title: "T", body: "B", url: "/" }, (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch);
    expect(called).toBe(false);
  });
});
