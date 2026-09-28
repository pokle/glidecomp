/**
 * The nightly purge behind /legal's "How Long We Keep Data"
 * (src/data-retention.ts).
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { purgeExpiredAuthData, RATE_LIMIT_RETENTION_MS } from "../src/data-retention";

const NOW = new Date("2026-10-01T03:43:00.000Z");
const iso = (msFromNow: number) => new Date(NOW.getTime() + msFromNow).toISOString();
const HOUR = 60 * 60 * 1000;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM "session"`),
    env.DB.prepare(`DELETE FROM "verification"`),
    env.DB.prepare(`DELETE FROM "rateLimit"`),
    env.DB.prepare(`DELETE FROM "user" WHERE id = 'retention-user'`),
    env.DB.prepare(
      `INSERT INTO "user" (id, name, email, createdAt, updatedAt)
       VALUES ('retention-user', 'R', 'retention@test.local', ?, ?)`
    ).bind(iso(0), iso(0)),
  ]);
});

async function ids(table: string): Promise<string[]> {
  const rows = await env.DB.prepare(`SELECT id FROM "${table}" ORDER BY id`).all<{ id: string }>();
  return rows.results.map((r) => r.id);
}

describe("purgeExpiredAuthData", () => {
  test("deletes expired sessions with their IP address, keeps live ones", async () => {
    const insert = (id: string, expiresAt: string) =>
      env.DB.prepare(
        `INSERT INTO "session" (id, expiresAt, token, ipAddress, userId, createdAt, updatedAt)
         VALUES (?, ?, ?, '203.0.113.9', 'retention-user', ?, ?)`
      ).bind(id, expiresAt, `tok-${id}`, iso(0), iso(0));
    await env.DB.batch([insert("expired", iso(-HOUR)), insert("live", iso(HOUR))]);

    const counts = await purgeExpiredAuthData(env.DB, NOW);

    expect(counts.sessions).toBe(1);
    expect(await ids("session")).toEqual(["live"]);
  });

  test("deletes expired sign-in codes, keeps live ones", async () => {
    const insert = (id: string, expiresAt: string) =>
      env.DB.prepare(
        `INSERT INTO "verification" (id, identifier, value, expiresAt) VALUES (?, 'x@test.local', 'h', ?)`
      ).bind(id, expiresAt);
    await env.DB.batch([insert("expired", iso(-1000)), insert("live", iso(10 * 60 * 1000))]);

    const counts = await purgeExpiredAuthData(env.DB, NOW);

    expect(counts.verifications).toBe(1);
    expect(await ids("verification")).toEqual(["live"]);
  });

  test("deletes rate-limit rows (IP-keyed) untouched for two days, and only those", async () => {
    const insert = (id: string, lastRequest: number) =>
      env.DB.prepare(
        `INSERT INTO "rateLimit" (id, key, count, lastRequest) VALUES (?, ?, 1, ?)`
      ).bind(id, `203.0.113.9|/sign-in/${id}`, lastRequest);
    await env.DB.batch([
      insert("stale", NOW.getTime() - RATE_LIMIT_RETENTION_MS - 1),
      // Inside the longest (one-day) budget window: must survive.
      insert("recent", NOW.getTime() - 23 * HOUR),
    ]);

    const counts = await purgeExpiredAuthData(env.DB, NOW);

    expect(counts.rateLimits).toBe(1);
    expect(await ids("rateLimit")).toEqual(["recent"]);
  });
});
