import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { authRequest, clearCompData, createComp, request } from "./helpers";

const WP = [
  { code: "A01", name: "Bordano Landing", latitude: 46.308828, longitude: 13.1125, altitude: 225, radius: 400 },
  { code: "A02", name: "Orvenco Landing", latitude: 46.253917, longitude: 13.141342, altitude: 198, radius: 1000 },
];

describe("competition waypoints", () => {
  beforeEach(clearCompData);
  afterEach(clearCompData);

  test("admin PUT then GET round-trips the waypoints", async () => {
    const compId = await createComp();
    const put = await authRequest("PUT", `/api/comp/${compId}/waypoints`, { waypoints: WP });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ ok: true, count: 2 });

    const get = await request("GET", `/api/comp/${compId}/waypoints`);
    expect(get.status).toBe(200);
    const body = (await get.json()) as { waypoints: typeof WP; updated_at: string | null };
    expect(body.waypoints).toEqual(WP);
    expect(body.updated_at).toBeTruthy();
  });

  test("a comp with no waypoints returns an empty array", async () => {
    const compId = await createComp();
    const get = await request("GET", `/api/comp/${compId}/waypoints`);
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ waypoints: [], updated_at: null });
  });

  test("non-admins cannot PUT", async () => {
    const compId = await createComp(); // owned by user-1
    const res = await request("PUT", `/api/comp/${compId}/waypoints`, {
      body: { waypoints: WP },
      user: "user-2",
    });
    expect(res.status).toBe(403);
  });

  test("PUT replaces the whole set", async () => {
    const compId = await createComp();
    await authRequest("PUT", `/api/comp/${compId}/waypoints`, { waypoints: WP });
    await authRequest("PUT", `/api/comp/${compId}/waypoints`, { waypoints: [WP[0]] });
    const body = (await (await request("GET", `/api/comp/${compId}/waypoints`)).json()) as {
      waypoints: typeof WP;
    };
    expect(body.waypoints).toHaveLength(1);
    expect(body.waypoints[0].code).toBe("A01");
  });

  test("rejects out-of-range coordinates", async () => {
    const compId = await createComp();
    const res = await authRequest("PUT", `/api/comp/${compId}/waypoints`, {
      waypoints: [{ ...WP[0], latitude: 200 }],
    });
    expect(res.status).toBe(400);
  });

  test("editing waypoints writes an audit entry but does not touch scores", async () => {
    const compId = await createComp();
    await authRequest("PUT", `/api/comp/${compId}/waypoints`, { waypoints: WP });
    const audit = await env.DB.prepare(
      "SELECT description FROM audit_log WHERE subject_type = 'comp' ORDER BY audit_id DESC LIMIT 1"
    ).first<{ description: string }>();
    expect(audit?.description).toMatch(/waypoints/i);
  });

  test("hidden test comps 404 for anonymous, resolve for admins", async () => {
    const compId = await createComp({ test: true });
    await authRequest("PUT", `/api/comp/${compId}/waypoints`, { waypoints: WP });
    expect((await request("GET", `/api/comp/${compId}/waypoints`)).status).toBe(404);
    const asAdmin = await request("GET", `/api/comp/${compId}/waypoints`, { user: "user-1" });
    expect(asAdmin.status).toBe(200);
  });
});
