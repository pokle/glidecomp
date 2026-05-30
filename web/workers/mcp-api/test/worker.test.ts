// Tests for the MCP worker's HTTP boundary: routing, CORS, and the
// API-key auth gate. The auth gate is the only authentication check the
// MCP worker performs itself — everything else is delegated to comp-api
// via the forwarded x-api-key header (see util.test.ts).

import { SELF } from "cloudflare:test";
import { describe, expect, test } from "vitest";

describe("Routing", () => {
  test("GET /mcp/health returns ok", async () => {
    const res = await SELF.fetch("https://test/mcp/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("non-/mcp paths return 404", async () => {
    const res = await SELF.fetch("https://test/api/comp");
    expect(res.status).toBe(404);
  });
});

describe("CORS preflight", () => {
  test("OPTIONS /mcp returns the documented CORS headers", async () => {
    const res = await SELF.fetch("https://test/mcp", { method: "OPTIONS" });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toContain("Authorization");
  });
});

describe("API-key auth gate", () => {
  test("invalid Bearer token → 401", async () => {
    const res = await SELF.fetch("https://test/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer glc_invalid",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid API key" });
  });

  test("valid Bearer token → passes the auth gate (not 401)", async () => {
    // The MCP layer below may return its own status for an un-initialised
    // session, but it must NOT be 401 — that would mean the gate rejected
    // a known-good key.
    const res = await SELF.fetch("https://test/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer glc_user1",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        },
      }),
    });
    expect(res.status).not.toBe(401);
  });

  test("no Authorization header → passes the auth gate (anonymous)", async () => {
    // Anonymous requests are allowed; they only see public comp endpoints.
    const res = await SELF.fetch("https://test/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        },
      }),
    });
    expect(res.status).not.toBe(401);
  });

  test("non-Bearer Authorization → treated as anonymous (not 401)", async () => {
    // extractBearerToken only matches "Bearer …" — other schemes are
    // simply ignored, the request continues as anonymous, and the MCP
    // layer handles it from there.
    const res = await SELF.fetch("https://test/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Basic Zm9vOmJhcg==",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        },
      }),
    });
    expect(res.status).not.toBe(401);
  });
});
