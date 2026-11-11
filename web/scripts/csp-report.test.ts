/**
 * functions/api/csp-report.ts is public and unauthenticated, so its body cap
 * must hold whether or not the sender declares a length.
 */
import { describe, expect, test } from "bun:test";
import { readCapped } from "../../functions/api/csp-report";

function chunked(chunks: string[]): Request {
  const enc = new TextEncoder();
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled < chunks.length) controller.enqueue(enc.encode(chunks[pulled++]));
      else controller.close();
    },
  });
  // No Content-Length: the shape a chunked upload arrives in.
  return new Request("https://glidecomp.test/api/csp-report", { method: "POST", body, duplex: "half" } as RequestInit);
}

describe("readCapped", () => {
  test("reads a small body", async () => {
    expect(await readCapped(chunked(['{"a":', "1}"]), 64)).toBe('{"a":1}');
  });

  test("stops at the cap when no length is declared", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const req = new Request("https://glidecomp.test/api/csp-report", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit);
    expect(await readCapped(req, 4096)).toBeNull();
    // An endless body is abandoned just past the cap, not read to the end.
    expect(pulls).toBeLessThan(10);
  });

  test("refuses a declared length over the cap without reading", async () => {
    const req = new Request("https://glidecomp.test/api/csp-report", {
      method: "POST",
      body: "x".repeat(100),
      headers: { "content-length": "100" },
    });
    expect(await readCapped(req, 64)).toBeNull();
    expect(req.bodyUsed).toBe(false);
  });

  test("counts bytes, not characters", async () => {
    // 40 three-byte characters: 40 chars, 120 bytes.
    expect(await readCapped(chunked(["€".repeat(40)]), 64)).toBeNull();
  });
});
