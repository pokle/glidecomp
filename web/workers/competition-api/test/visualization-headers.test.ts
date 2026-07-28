// Regression tests for SEC-35: the 3D-replay bundle's Cache-Control must be
// `private` for a signed-in viewer. The same /3dvis URL answers differently
// for an admin (a hidden `test` comp's bundle) than for an anonymous caller
// (404), so a shared cache holding the admin's copy would serve the bundle to
// callers the route itself refuses — the same rule the score route's
// cacheControl() enforces.

import { describe, expect, test } from "vitest";
import { bundleHeaders } from "../src/routes/visualization";

const KEY = "3dvis-v3-0123456789abcdef";

describe("3dvis bundle headers (SEC-35)", () => {
  test("anonymous viewers get a shared-cacheable response", () => {
    const h = bundleHeaders(KEY, false);
    expect(h["Cache-Control"]).toBe(
      "public, max-age=300, stale-while-revalidate=86400"
    );
    expect(h.ETag).toBe(`"${KEY}"`);
  });

  test("signed-in viewers are never shared-cached, but keep the ETag", () => {
    const h = bundleHeaders(KEY, true);
    expect(h["Cache-Control"]).toBe(
      "private, max-age=300, stale-while-revalidate=86400"
    );
    // `private` (not `no-store`): the viewer's own browser may still cache and
    // revalidate, so the 304 saving on a multi-megabyte bundle is kept.
    expect(h.ETag).toBe(`"${KEY}"`);
  });
});
