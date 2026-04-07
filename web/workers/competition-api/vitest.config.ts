import path from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Test users — the AUTH_API mock returns these based on the cookie value.
const TEST_USERS: Record<string, object> = {
  "user-1": {
    id: "user-1",
    name: "Test Pilot",
    email: "pilot@test.com",
    image: null,
    username: "testpilot",
  },
  "user-2": {
    id: "user-2",
    name: "Admin Two",
    email: "admin2@test.com",
    image: null,
    username: "admin2",
  },
  "user-3": {
    id: "user-3",
    name: "Pilot Three",
    email: "pilot3@test.com",
    image: null,
    username: "pilot3",
  },
};

// Read sample files in Node.js context (full filesystem access, no miniflare sandbox)
const SAMPLES_DIR = path.resolve(__dirname, "../../samples/comps/corryong-cup-2026-t1");
const SAMPLE_TASK_XCTSK = readFileSync(path.resolve(SAMPLES_DIR, "task.xctsk"), "utf-8");
const SAMPLE_IGC_FILES = JSON.stringify(
  Object.fromEntries(
    readdirSync(SAMPLES_DIR)
      .filter((f) => f.toLowerCase().endsWith(".igc"))
      .sort()
      .map((f) => [f, readFileSync(path.resolve(SAMPLES_DIR, f), "utf-8")])
  )
);

export default defineConfig(async () => {
  const authMigrations = await readD1Migrations(path.join(__dirname, "../auth-api/migrations"));
  const compMigrations = await readD1Migrations(path.join(__dirname, "migrations"));
  const migrations = [...authMigrations, ...compMigrations];

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations, SAMPLE_TASK_XCTSK, SAMPLE_IGC_FILES },
          r2Buckets: ["R2"],
          kvNamespaces: ["SCORES_CACHE"],
          // Allow access to the root directory for samples
          unsafeNodeModules: ["node:fs", "node:path"],
          serviceBindings: {
            // Mock AUTH_API: reads a "test-user" cookie to determine which user
            // is authenticated. No cookie or "test-user=none" → unauthenticated.
            AUTH_API(request: Request): Response {
              const cookie = request.headers.get("cookie") ?? "";
              const match = cookie.match(/test-user=([^;]+)/);
              const userId = match?.[1];
              const user =
                userId && userId !== "none"
                  ? TEST_USERS[userId] ?? null
                  : null;
              return Response.json({ user });
            },
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      include: ["test/**/*.test.ts"],
    },
  };
});
