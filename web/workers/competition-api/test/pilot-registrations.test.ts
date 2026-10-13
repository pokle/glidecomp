// GET /api/comp/pilot/registrations — the comps an account is on, for the
// native app's "Yours", "You" and "Your track" (mobile plan, stage 4).

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { clearCompData, createComp, request } from "./helpers";
import { decodeId } from "../src/sqids";

const ALPHABET = env.SQIDS_ALPHABET;

interface Registration {
  comp_id: string;
  comp_pilot_id: string;
  registered_pilot_name: string;
  pilot_class: string;
}

async function getRegistrations(user: string): Promise<Registration[]> {
  const res = await request("GET", "/api/comp/pilot/registrations", { user });
  expect(res.status).toBe(200);
  return ((await res.json()) as { registrations: Registration[] }).registrations;
}

/** Link `user` to a new roster row in the comp, the way a claim would. */
async function register(compId: string, user: string, name: string, pilotClass = "open"): Promise<void> {
  await env.DB.prepare("INSERT OR IGNORE INTO pilot (user_id, name) VALUES (?, ?)").bind(user, name).run();
  const pilot = await env.DB.prepare("SELECT pilot_id FROM pilot WHERE user_id = ?")
    .bind(user)
    .first<{ pilot_id: number }>();
  await env.DB.prepare(
    "INSERT INTO comp_pilot (comp_id, pilot_id, registered_pilot_name, pilot_class) VALUES (?, ?, ?, ?)"
  )
    .bind(decodeId(ALPHABET, compId), pilot!.pilot_id, name, pilotClass)
    .run();
}

beforeEach(async () => {
  await clearCompData();
});

describe("GET /api/comp/pilot/registrations", () => {
  test("requires auth", async () => {
    const res = await request("GET", "/api/comp/pilot/registrations");
    expect(res.status).toBe(401);
  });

  test("empty for an account with no pilot record", async () => {
    expect(await getRegistrations("user-3")).toEqual([]);
  });

  test("lists the caller's roster rows, before they have flown anything", async () => {
    const compId = await createComp({ name: "Corryong Cup" });
    await register(compId, "user-2", "Jo Smith", "floater");

    const [registration] = await getRegistrations("user-2");
    expect(registration.comp_id).toBe(compId);
    expect(registration.registered_pilot_name).toBe("Jo Smith");
    expect(registration.pilot_class).toBe("floater");
    expect(registration.comp_pilot_id).toMatch(/^[A-Za-z0-9]+$/);
  });

  test("only the caller's own rows", async () => {
    const compId = await createComp();
    await register(compId, "user-2", "Jo Smith");
    expect(await getRegistrations("user-3")).toEqual([]);
  });

  test("a hidden test comp is never named to someone who cannot see it", async () => {
    // user-1 creates (and so administers) the comp; user-2 is merely on it.
    const compId = await createComp({ name: "Hidden Comp", test: true });
    await register(compId, "user-2", "Jo Smith");
    expect(await getRegistrations("user-2")).toEqual([]);

    await register(compId, "user-1", "The Organiser");
    expect((await getRegistrations("user-1")).map((r) => r.comp_id)).toEqual([compId]);
  });
});
