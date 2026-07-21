import { env } from "cloudflare:test";
import { describe, expect, test, beforeEach } from "vitest";
import { loginAs } from "./helpers";

/**
 * Sign-in pilot bootstrap (pilot-bootstrap.ts, wired via the Better Auth
 * session-create hook): every sign-in ensures a `pilot` row and claims
 * unlinked comp_pilot pre-registrations matching the account email.
 * dev-login constructs auth without an ExecutionContext, so in these tests
 * the bootstrap completes before the sign-in response returns.
 */

async function pilotRowFor(email: string) {
  return env.glidecomp_auth
    .prepare(
      `SELECT p.pilot_id, p.name FROM pilot p
       JOIN "user" u ON u.id = p.user_id WHERE u.email = ?`
    )
    .bind(email)
    .first<{ pilot_id: number; name: string }>();
}

beforeEach(async () => {
  await env.glidecomp_auth.batch([
    env.glidecomp_auth.prepare("DELETE FROM audit_log"),
    env.glidecomp_auth.prepare("DELETE FROM comp_pilot"),
    env.glidecomp_auth.prepare("DELETE FROM comp"),
    env.glidecomp_auth.prepare("DELETE FROM pilot"),
  ]);
});

describe("sign-in pilot bootstrap", () => {
  test("creates a pilot row on first sign-in", async () => {
    await loginAs("fresh@example.com", "Fresh Pilot");
    const pilot = await pilotRowFor("fresh@example.com");
    expect(pilot).not.toBeNull();
    expect(pilot!.name).toBe("Fresh Pilot");
  });

  test("is idempotent across repeat sign-ins", async () => {
    await loginAs("repeat@example.com", "Repeat Pilot");
    await loginAs("repeat@example.com", "Repeat Pilot");
    const rows = await env.glidecomp_auth
      .prepare(
        `SELECT COUNT(*) AS cnt FROM pilot p
         JOIN "user" u ON u.id = p.user_id WHERE u.email = ?`
      )
      .bind("repeat@example.com")
      .first<{ cnt: number }>();
    expect(rows!.cnt).toBe(1);
  });

  test("claims an email-matching pre-registration, closed comp included, and audits it", async () => {
    // Pre-register the pilot by email in a CLOSED comp before the account exists.
    await env.glidecomp_auth
      .prepare(
        `INSERT INTO comp (name, creation_date, close_date, category, pilot_classes, default_pilot_class)
         VALUES ('Historic Cup', '2024-01-01', '2024-01-20', 'hg', '["open"]', 'open')`
      )
      .run();
    const comp = await env.glidecomp_auth
      .prepare("SELECT comp_id FROM comp WHERE name = 'Historic Cup'")
      .first<{ comp_id: number }>();
    await env.glidecomp_auth
      .prepare(
        `INSERT INTO comp_pilot (comp_id, registered_pilot_name, registered_pilot_email, pilot_class)
         VALUES (?, 'Prereg Pilot', 'prereg@example.com', 'open')`
      )
      .bind(comp!.comp_id)
      .run();

    await loginAs("prereg@example.com", "Prereg Pilot");

    const pilot = await pilotRowFor("prereg@example.com");
    const linked = await env.glidecomp_auth
      .prepare("SELECT pilot_id FROM comp_pilot WHERE comp_id = ?")
      .bind(comp!.comp_id)
      .first<{ pilot_id: number | null }>();
    expect(linked!.pilot_id).toBe(pilot!.pilot_id);

    const audit = await env.glidecomp_auth
      .prepare("SELECT description, actor_name FROM audit_log WHERE comp_id = ?")
      .bind(comp!.comp_id)
      .first<{ description: string; actor_name: string }>();
    expect(audit!.description).toContain('Linked pre-registered pilot "Prereg Pilot"');
    expect(audit!.description).toContain("matched by email at sign-in");
  });

  test("does not claim rows with a different email", async () => {
    await env.glidecomp_auth
      .prepare(
        `INSERT INTO comp (name, creation_date, category, pilot_classes, default_pilot_class)
         VALUES ('Other Cup', '2026-01-01', 'hg', '["open"]', 'open')`
      )
      .run();
    const comp = await env.glidecomp_auth
      .prepare("SELECT comp_id FROM comp WHERE name = 'Other Cup'")
      .first<{ comp_id: number }>();
    await env.glidecomp_auth
      .prepare(
        `INSERT INTO comp_pilot (comp_id, registered_pilot_name, registered_pilot_email, pilot_class)
         VALUES (?, 'Someone Else', 'someone-else@example.com', 'open')`
      )
      .bind(comp!.comp_id)
      .run();

    await loginAs("not-that-person@example.com", "Not That Person");

    const row = await env.glidecomp_auth
      .prepare("SELECT pilot_id FROM comp_pilot WHERE comp_id = ?")
      .bind(comp!.comp_id)
      .first<{ pilot_id: number | null }>();
    expect(row!.pilot_id).toBeNull();
  });
});
