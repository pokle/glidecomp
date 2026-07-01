import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { request, createComp, clearCompData } from "./helpers";

interface AdminUser {
  id: string;
  email: string;
  is_super_admin: boolean;
  track_count: number;
  task_count: number;
  admin_comp_count: number;
  pilot_comp_count: number;
}

beforeEach(async () => {
  await clearCompData();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user_track"),
    env.DB.prepare("DELETE FROM user_task"),
  ]);
});

describe("GET /api/admin/whoami", () => {
  test("requires authentication", async () => {
    const res = await request("GET", "/api/admin/whoami");
    expect(res.status).toBe(401);
  });

  test("reports false for a plain authenticated user", async () => {
    const res = await request("GET", "/api/admin/whoami", { user: "user-1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ is_super_admin: false });
  });

  test("reports true for the super admin", async () => {
    const res = await request("GET", "/api/admin/whoami", {
      user: "user-super",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ is_super_admin: true });
  });
});

describe("GET /api/admin/users", () => {
  test("requires authentication", async () => {
    const res = await request("GET", "/api/admin/users");
    expect(res.status).toBe(401);
  });

  test("is forbidden for a plain authenticated user", async () => {
    const res = await request("GET", "/api/admin/users", { user: "user-1" });
    expect(res.status).toBe(403);
  });

  test("lists every registered user for the super admin, with stats", async () => {
    // user-1 administers a comp.
    await createComp({ name: "Owned By One" });

    // user-1 has a stored track.
    await env.DB.prepare(
      `INSERT INTO user_track
        (user_id, track_id, r2_key, filename, display_name, pilot, glider,
         flight_date, file_size, stored_at, last_accessed_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`
    )
      .bind(
        "user-1",
        "a".repeat(64),
        "u/user-1/track/seed.igc.gz",
        "seed.igc",
        "seed",
        1234,
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z"
      )
      .run();

    const res = await request("GET", "/api/admin/users", { user: "user-super" });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { users: AdminUser[] };

    expect(data.users.map((u) => u.email).sort()).toEqual(
      [
        "admin2@test.com",
        "pilot3@test.com",
        "pilot@test.com",
        "tushar.pokle@gmail.com",
      ].sort()
    );

    const one = data.users.find((u) => u.email === "pilot@test.com")!;
    expect(one.track_count).toBe(1);
    expect(one.admin_comp_count).toBe(1);
    expect(one.is_super_admin).toBe(false);

    const superAdmin = data.users.find(
      (u) => u.email === "tushar.pokle@gmail.com"
    )!;
    expect(superAdmin.is_super_admin).toBe(true);
    expect(superAdmin.track_count).toBe(0);
  });
});
