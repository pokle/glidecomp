import path from "node:path";
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
};

export default defineConfig(async () => {
  const migrationsPath = path.join(__dirname, "test", "migrations");
  const migrations = await readD1Migrations(migrationsPath);

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
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
