// SEC-06 regression tests: the worker-wide bodyLimit middleware must reject
// oversize request bodies with 413 before any handler can buffer them, while
// leaving legitimate uploads (up to the IGC compressed cap) untouched.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { request, uploadRequest, createComp, createTask, clearCompData } from "./helpers";
import { MAX_BODY_BYTES, MAX_COMPRESSED_BYTES } from "../src/igc-validation";

const IGC_PREFIX = "AXCT001Test\r\nHFDTE010126\r\n";

/** Gzip a text payload that passes the SEC-04 IGC-shape check. */
async function gzipIgc(text: string): Promise<Uint8Array> {
  const stream = new Blob([IGC_PREFIX + text])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Low-compressibility IGC filler: L-records (comments) of random hex, so the
 * gzipped body stays large enough to prove the route cap sits above it.
 */
function randomHexLines(lineCount: number): string {
  const lines: string[] = [];
  const bytes = new Uint8Array(38);
  for (let i = 0; i < lineCount; i++) {
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    lines.push(`L${hex}`);
  }
  return lines.join("\r\n");
}

beforeEach(async () => {
  await clearCompData();
  const listed = await env.R2.list();
  if (listed.objects.length > 0) {
    await Promise.all(listed.objects.map((o) => env.R2.delete(o.key)));
  }
});

describe("body limit (SEC-06)", () => {
  test("cap sits just above the IGC compressed cap", () => {
    expect(MAX_BODY_BYTES).toBeGreaterThan(MAX_COMPRESSED_BYTES);
    expect(MAX_BODY_BYTES).toBeLessThanOrEqual(MAX_COMPRESSED_BYTES + 64 * 1024);
  });

  test("oversize JSON body is rejected with 413 (even unauthenticated)", async () => {
    const res = await request("POST", "/api/comp", {
      body: { name: "x".repeat(MAX_BODY_BYTES) },
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Request body too large");
  });

  test("oversize IGC upload is rejected with 413", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);
    const res = await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      new Uint8Array(MAX_BODY_BYTES + 1),
      { user: "user-1" }
    );
    expect(res.status).toBe(413);
  });

  test("a large-but-legitimate IGC upload still succeeds", async () => {
    // ~1.2 MB of low-compressibility IGC text gzips to roughly 600 KB —
    // well above the 256 KB cap once proposed for JSON routes, proving the
    // single worker-wide cap doesn't break real track uploads.
    const payload = await gzipIgc(randomHexLines(15000));
    expect(payload.byteLength).toBeGreaterThan(256 * 1024);
    expect(payload.byteLength).toBeLessThan(MAX_COMPRESSED_BYTES);

    const compId = await createComp();
    const taskId = await createTask(compId);
    const res = await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      payload,
      { user: "user-1" }
    );
    expect(res.status).toBe(201);
  });
});
