import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { authRequest, clearCompData, createComp, createTask, request } from "./helpers";

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

  test("rejects control characters in code/name (would corrupt line formats)", async () => {
    const compId = await createComp();
    const res = await authRequest("PUT", `/api/comp/${compId}/waypoints`, {
      waypoints: [{ ...WP[0], code: "A01\nB02" }],
    });
    expect(res.status).toBe(400);
  });
});

describe("waypoint file downloads", () => {
  beforeEach(clearCompData);
  afterEach(clearCompData);

  test("serves the comp waypoints as an openable file with the right headers", async () => {
    const compId = await createComp();
    await authRequest("PUT", `/api/comp/${compId}/waypoints`, { waypoints: WP });

    const gpx = await request("GET", `/api/comp/${compId}/waypoints/gpx`);
    expect(gpx.status).toBe(200);
    expect(gpx.headers.get("content-type")).toBe("application/gpx+xml");
    expect(gpx.headers.get("content-disposition")).toContain('filename="test-comp-waypoints.gpx"');
    const body = await gpx.text();
    expect(body).toContain("<gpx");
    expect(body).toContain("A01");
  });

  test("?swap=1 flips the code/name columns", async () => {
    const compId = await createComp();
    await authRequest("PUT", `/api/comp/${compId}/waypoints`, { waypoints: WP });

    const normal = await (await request("GET", `/api/comp/${compId}/waypoints/seeyou-cup`)).text();
    const swapped = await (
      await request("GET", `/api/comp/${compId}/waypoints/seeyou-cup?swap=1`)
    ).text();
    expect(normal).toContain('"Bordano Landing",A01');
    expect(swapped).toContain('"A01",Bordano Landing');
  });

  test("unknown format is a 404", async () => {
    const compId = await createComp();
    await authRequest("PUT", `/api/comp/${compId}/waypoints`, { waypoints: WP });
    expect((await request("GET", `/api/comp/${compId}/waypoints/nope`)).status).toBe(404);
  });

  test("hidden test comps gate the waypoints file (404 anon, 200 admin)", async () => {
    const compId = await createComp({ test: true });
    await authRequest("PUT", `/api/comp/${compId}/waypoints`, { waypoints: WP });
    expect((await request("GET", `/api/comp/${compId}/waypoints/gpx`)).status).toBe(404);
    expect(
      (await request("GET", `/api/comp/${compId}/waypoints/gpx`, { user: "user-1" })).status
    ).toBe(200);
  });

  test("serves a task's turnpoints as a file", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);
    await authRequest("PATCH", `/api/comp/${compId}/task/${taskId}`, {
      xctsk: {
        taskType: "CLASSIC",
        version: 1,
        turnpoints: [{ type: "SSS", radius: 1000, waypoint: { name: "START", lat: -37, lon: 144 } }],
      },
    });
    const res = await request("GET", `/api/comp/${compId}/task/${taskId}/waypoints/gpx`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gpx+xml");
    expect(res.headers.get("content-disposition")).toContain("turnpoints.gpx");
    expect(await res.text()).toContain("START");
  });

  test("hidden test comps gate the task file (404 anon, 200 admin)", async () => {
    const compId = await createComp({ test: true });
    const taskId = await createTask(compId);
    await authRequest("PATCH", `/api/comp/${compId}/task/${taskId}`, {
      xctsk: {
        taskType: "CLASSIC",
        version: 1,
        turnpoints: [{ type: "SSS", radius: 1000, waypoint: { name: "START", lat: -37, lon: 144 } }],
      },
    });
    expect((await request("GET", `/api/comp/${compId}/task/${taskId}/waypoints/gpx`)).status).toBe(404);
    expect(
      (await request("GET", `/api/comp/${compId}/task/${taskId}/waypoints/gpx`, { user: "user-1" }))
        .status
    ).toBe(200);
  });
});
