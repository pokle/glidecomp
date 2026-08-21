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
  // Used ONLY by account-name-sync.test.ts, which renames the account it
  // stands for. Every other test asserts its user's name is the one seeded
  // here, so the renaming test needs a subject of its own.
  "user-rename": {
    id: "user-rename",
    name: "Original Name",
    email: "rename@test.com",
    image: null,
    username: "originalname",
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

/** Remaining forced auth-hop failures, per "test-auth-fail" key. */
const authFailures = new Map<string, number>();

/**
 * Account names rewritten by POST /api/auth/set-name, keyed by user id.
 *
 * Opt-in via a `test-account-sync=1` cookie, and deliberately so: this Map
 * lives on the Node host for the whole run, and most of the suite asserts
 * that user-1 is "Test Pilot". A test that wants to watch a rename travel
 * (issue #539 — the audit log's actor_name is the symptom that matters) says
 * so; every other pilot-profile PATCH gets a 200 that changes nothing.
 */
const accountNames = new Map<string, string>();

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
            //
            // A "test-auth-fail=<key>:<n>" cookie makes the first n calls
            // bearing that key answer 500 instead, so a test can prove the
            // caller rides out a transient auth hop rather than silently
            // downgrading the request to anonymous (issue #481). The key
            // scopes the countdown to one test; this callback runs on the
            // Node host, so the Map survives across calls within a run.
            async AUTH_API(request: Request): Promise<Response> {
              const cookie = request.headers.get("cookie") ?? "";
              const fail = cookie.match(/test-auth-fail=([^;:]+):(\d+)/);
              if (fail) {
                const [, key, count] = fail;
                const remaining = authFailures.get(key) ?? Number(count);
                if (remaining > 0) {
                  authFailures.set(key, remaining - 1);
                  return new Response("auth-api blew up", { status: 500 });
                }
              }
              const match = cookie.match(/test-user=([^;]+)/);
              const userId = match?.[1];
              const base =
                userId && userId !== "none"
                  ? TEST_USERS[userId] ?? null
                  : null;
              const renamed = userId ? accountNames.get(userId) : undefined;
              const user =
                base && renamed !== undefined ? { ...base, name: renamed } : base;

              // POST /api/auth/set-name — the account-name write that keeps
              // "user".name in step with a renamed pilot profile. Mirrors the
              // real route's gate and its 1-128 character rule; a
              // `test-setname-fail=1` cookie makes it 500 instead, so a test
              // can prove the caller reports a failed hop rather than saving
              // half of the rename.
              if (new URL(request.url).pathname === "/api/auth/set-name") {
                if (!base) {
                  return Response.json(
                    { error: "Not authenticated" },
                    { status: 401 }
                  );
                }
                if (/test-setname-fail=1/.test(cookie)) {
                  return new Response("set-name blew up", { status: 500 });
                }
                const body = (await request.json().catch(() => ({}))) as {
                  name?: unknown;
                };
                const name =
                  typeof body.name === "string" ? body.name.trim() : "";
                if (name.length === 0 || name.length > 128) {
                  return Response.json(
                    { error: "Name must be 1-128 characters" },
                    { status: 400 }
                  );
                }
                if (/test-account-sync=1/.test(cookie) && userId) {
                  accountNames.set(userId, name);
                }
                return Response.json({ name });
              }

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
      // Every test here boots workerd and most of them score REAL tracks (the
      // bundled Corryong task 1, 32 IGCs), so vitest's 5s default left no
      // headroom: the slowest test already sits at ~3.9s on an idle dev machine
      // and CI runs the suite 2-3x slower (190s of test time on the runner vs
      // 94s locally). The result was a ~50% flake rate on master and every
      // branch, landing on whichever heavy test the runner happened to starve —
      // scoring.test.ts one run, track-quality.test.ts the next. Not a mask: a
      // genuine hang still fails the job inside its ~90s wall clock. auth-api's
      // config hit the same wall and raised it to 15s; this suite is heavier.
      testTimeout: 30000,
      hookTimeout: 30000,
    },
  };
});
