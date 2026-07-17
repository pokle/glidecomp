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
  // Email is on the hardcoded super-admin allowlist (see src/super-admin.ts).
  "user-super": {
    id: "user-super",
    name: "Super Admin",
    email: "tushar.pokle@gmail.com",
    image: null,
    username: "superadmin",
  },
};

// Read sample files in Node.js context (full filesystem access, no miniflare sandbox)
const SAMPLES_DIR = path.resolve(__dirname, "../../samples/comps/corryong-cup-2026-open-t1");
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
  const migrations = await readD1Migrations(path.join(__dirname, "../../db/migrations"));

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations, SAMPLE_TASK_XCTSK, SAMPLE_IGC_FILES },
          r2Buckets: ["R2"],
          kvNamespaces: ["glidecomp_scores_cache"],
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
            // Mock AIRSCORE_API: fixed stats, matching the real worker's
            // /internal/cache/stats and /internal/cache/clear contract
            // (see web/workers/airscore-api/src/cache.ts). Deliberately
            // stateless — cache.test.ts asserts on these fixed numbers
            // rather than simulating real KV storage.
            AIRSCORE_API(request: Request): Response {
              const url = new URL(request.url);
              if (url.pathname === "/internal/cache/stats") {
                return Response.json({
                  item_count: 3,
                  by_prefix: { "Task results": 2, "Track files": 1 },
                });
              }
              if (url.pathname === "/internal/cache/clear") {
                return Response.json({ cleared: 3 });
              }
              return new Response("Not found", { status: 404 });
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
