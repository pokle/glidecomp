import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { getAuthTables } from "better-auth/db";
import { createAuth } from "../src/auth";

/**
 * The D1 schema really does hold what Better Auth's configuration expects.
 *
 * Better Auth 1.7 checks this itself, before every request — but it cannot on
 * D1, so `advanced.database.validateSchema` is off (see src/auth.ts for why).
 * This is the replacement, and it reads the expectation from the very same
 * place the library's own check does: `getAuthTables()` over the live
 * `auth.options`, so the plugin list, `user.additionalFields` and the
 * database-backed rate limiter are whatever src/auth.ts actually configures,
 * not a copy of it that could drift.
 *
 * The live side is `PRAGMA table_info`, which D1 does allow — unlike the
 * `sqlite_master` read Kysely's introspector needs.
 *
 * What this catches is what the library's check catches, and what actually
 * bit this repo's upgrades before: a release that adds a column or a table
 * (1.7.0's `account.issuer`, withdrawn again in 1.7.3) with no matching
 * migration in web/db/migrations.
 */

const auth = createAuth(env);

async function columnsOf(table: string): Promise<Set<string>> {
  const { results } = await env.glidecomp_auth
    .prepare(`PRAGMA table_info("${table}")`)
    .all<{ name: string }>();
  return new Set(results.map((r) => r.name));
}

const tables = getAuthTables(auth.options);

describe("Better Auth schema", () => {
  test("every model it configures has a table", async () => {
    for (const [model, def] of Object.entries(tables)) {
      const columns = await columnsOf(def.modelName);
      expect(
        columns.size,
        `no "${def.modelName}" table (model ${model})`
      ).toBeGreaterThan(0);
    }
  });

  for (const [model, def] of Object.entries(tables)) {
    test(`"${def.modelName}" has every column the ${model} model writes`, async () => {
      const columns = await columnsOf(def.modelName);
      // Every model carries an id; only the other fields are declared.
      const expected = [
        "id",
        ...Object.entries(def.fields).map(
          ([field, attr]) => attr.fieldName ?? field
        ),
      ];
      const missing = expected.filter((c) => !columns.has(c));
      expect(
        missing,
        `${def.modelName} is missing ${missing.join(", ")}`
      ).toEqual([]);
    });
  }
});
