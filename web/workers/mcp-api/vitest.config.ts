import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Test users — the AUTH_API mock returns these based on the x-api-key header.
// glc_user1 → user-1; glc_admin → user-2; anything else (or missing) → null.
const TEST_USERS: Record<string, object> = {
  glc_user1: {
    id: "user-1",
    name: "Test Pilot",
    email: "pilot@test.com",
    image: null,
    username: "testpilot",
  },
  glc_admin: {
    id: "user-2",
    name: "Admin Two",
    email: "admin2@test.com",
    image: null,
    username: "admin2",
  },
};

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        // Mock service bindings — both AUTH_API and COMPETITION_API are
        // replaced with synchronous functions that the tests can assert
        // against. The mocks intentionally have NO understanding of the
        // X-Glidecomp-Internal-User header — its presence in any
        // observation should be treated as a bug.
        serviceBindings: {
          AUTH_API(request: Request): Response {
            const url = new URL(request.url);
            if (url.pathname !== "/api/auth/me") {
              return new Response("not mocked", { status: 501 });
            }
            const apiKey = request.headers.get("x-api-key");
            const user = apiKey && TEST_USERS[apiKey] ? TEST_USERS[apiKey] : null;
            return Response.json({ user });
          },

          // COMPETITION_API echoes the inbound request as JSON so tests can
          // assert exactly which headers/body the MCP worker forwarded.
          // Special path `/api/comp/__force-error` returns 403 for the
          // upstream-error test (so we don't have to monkey-patch the
          // binding mid-test).
          async COMPETITION_API(request: Request): Promise<Response> {
            const url = new URL(request.url);
            if (url.pathname === "/api/comp/__force-error") {
              return Response.json({ error: "Forbidden" }, { status: 403 });
            }
            const headers: Record<string, string> = {};
            request.headers.forEach((value, key) => {
              headers[key] = value;
            });
            const body =
              request.method === "GET" || request.method === "HEAD"
                ? null
                : await request.text();
            return Response.json({
              echo: {
                method: request.method,
                pathname: url.pathname,
                headers,
                body,
              },
            });
          },
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
