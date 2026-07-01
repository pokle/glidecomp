import { describe, expect, test, beforeEach } from "vitest";
import { request, createComp, clearCompData } from "./helpers";

// user-super's email is on the hardcoded super-admin allowlist. It owns no
// comps and holds no comp_admin rows, yet must be able to administer every
// competition. user-3 is a plain authenticated user (the negative control).

beforeEach(async () => {
  await clearCompData();
});

describe("super admin", () => {
  test("can PATCH a comp it does not own, where a plain user is forbidden", async () => {
    // user-1 owns the comp.
    const compId = await createComp({ name: "Owned By One" });

    // Plain authenticated user cannot mutate it.
    const forbidden = await request("PATCH", `/api/comp/${compId}`, {
      body: { name: "Hijacked" },
      user: "user-3",
    });
    expect(forbidden.status).toBe(403);

    // Super admin can.
    const ok = await request("PATCH", `/api/comp/${compId}`, {
      body: { name: "Renamed By Super" },
      user: "user-super",
    });
    expect(ok.status).toBe(200);

    const row = await import("cloudflare:test").then(({ env }) =>
      env.DB.prepare("SELECT name FROM comp").first<{ name: string }>()
    );
    expect(row!.name).toBe("Renamed By Super");
  });

  test("holds no comp_admin row — access is purely the allowlist bypass", async () => {
    await createComp({ name: "Owned By One" });
    const { env } = await import("cloudflare:test");
    const row = await env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM comp_admin WHERE user_id = ?"
    )
      .bind("user-super")
      .first<{ cnt: number }>();
    expect(row!.cnt).toBe(0);
  });

  test("GET comp detail reports is_admin and lists the super admin", async () => {
    const compId = await createComp({ name: "Detail Comp" });

    const res = await request("GET", `/api/comp/${compId}`, {
      user: "user-super",
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      is_admin: boolean;
      admins: { email: string }[];
    };
    expect(data.is_admin).toBe(true);
    expect(data.admins.some((a) => a.email === "tushar.pokle@gmail.com")).toBe(
      true
    );
  });

  test("can view a test comp it does not own", async () => {
    const compId = await createComp({ name: "Hidden Test Comp", test: true });

    // Plain user: test comps are invisible (404).
    const hidden = await request("GET", `/api/comp/${compId}`, {
      user: "user-3",
    });
    expect(hidden.status).toBe(404);

    // Super admin: visible.
    const seen = await request("GET", `/api/comp/${compId}`, {
      user: "user-super",
    });
    expect(seen.status).toBe(200);
  });

  test("does not leak the super admin into other users' admin list", async () => {
    const compId = await createComp({ name: "Public Comp" });

    const res = await request("GET", `/api/comp/${compId}`, { user: "user-3" });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      is_admin: boolean;
      admins: { email: string }[];
    };
    expect(data.is_admin).toBe(false);
    expect(data.admins.some((a) => a.email === "tushar.pokle@gmail.com")).toBe(
      false
    );
  });
});
