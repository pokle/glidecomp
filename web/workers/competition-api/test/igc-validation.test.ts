// SEC-11 regression: the IGC upload helper must reject empty, oversized,
// non-gzip, and gzip-bomb payloads before ever materialising the
// decompressed buffer in memory.

import { describe, expect, test } from "vitest";
import {
  validateAndDecompressIgc,
  IgcValidationException,
  MAX_COMPRESSED_BYTES,
  MAX_DECOMPRESSED_BYTES,
} from "../src/igc-validation";

/** Compress `text` with gzip and return the resulting bytes. */
async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Response(text).body!.pipeThrough(
    new CompressionStream("gzip")
  );
  return new Response(stream).arrayBuffer();
}

/** Compress `bytes` (raw, not text) with gzip. */
async function gzipBytes(bytes: Uint8Array): Promise<ArrayBuffer> {
  const stream = new Response(bytes).body!.pipeThrough(
    new CompressionStream("gzip")
  );
  return new Response(stream).arrayBuffer();
}

const SAMPLE_IGC =
  "AXCT001Sample\r\nHFDTE010126\r\nHFPLTPilot Name:Test Pilot\r\n";

describe("validateAndDecompressIgc — happy path", () => {
  test("round-trips a gzipped IGC", async () => {
    const body = await gzip(SAMPLE_IGC);
    const text = await validateAndDecompressIgc(body);
    expect(text).toBe(SAMPLE_IGC);
  });
});

describe("validateAndDecompressIgc — input validation", () => {
  test("rejects an empty body", async () => {
    await expect(
      validateAndDecompressIgc(new ArrayBuffer(0))
    ).rejects.toMatchObject({
      detail: { kind: "empty" },
    });
  });

  test("rejects a body larger than MAX_COMPRESSED_BYTES", async () => {
    // Allocate a buffer 1 byte over the cap, with the gzip magic at the
    // front so the magic check would pass if the size check didn't.
    const body = new Uint8Array(MAX_COMPRESSED_BYTES + 1);
    body[0] = 0x1f;
    body[1] = 0x8b;
    await expect(validateAndDecompressIgc(body.buffer)).rejects.toMatchObject({
      detail: { kind: "compressed_too_large" },
    });
  });

  test("rejects a body that is not gzip-magic-prefixed", async () => {
    const body = new TextEncoder().encode("AXCT001Plain text, not gzip");
    await expect(validateAndDecompressIgc(body.buffer)).rejects.toMatchObject({
      detail: { kind: "not_gzip" },
    });
  });

  test("rejects a body with gzip magic but corrupt content", async () => {
    // Magic bytes followed by garbage. DecompressionStream will throw
    // mid-stream and we surface that as `decompression_failed`.
    const body = new Uint8Array([0x1f, 0x8b, 0x08, 0xff, 0xff, 0xff]);
    await expect(validateAndDecompressIgc(body.buffer)).rejects.toMatchObject({
      detail: { kind: "decompression_failed" },
    });
  });
});

describe("validateAndDecompressIgc — gzip-bomb defence (the SEC-11 case)", () => {
  test("rejects a payload whose decompressed size exceeds the cap", async () => {
    // Build a bomb: a payload of all-zeros large enough that, once
    // decompressed, it exceeds MAX_DECOMPRESSED_BYTES. Highly compressible
    // input gzips ~1000:1, so a few KB of zeros expands to many MB.
    const expanded = new Uint8Array(MAX_DECOMPRESSED_BYTES + 1024);
    // (zero-filled by default — maximally compressible)
    const body = await gzipBytes(expanded);

    // Sanity: the compressed body is small (bomb confirmed).
    expect(body.byteLength).toBeLessThan(MAX_COMPRESSED_BYTES);

    await expect(validateAndDecompressIgc(body)).rejects.toMatchObject({
      detail: { kind: "decompressed_too_large" },
    });
  });

  test("a payload exactly at the decompressed cap is accepted", async () => {
    // Boundary check — `> cap` should fail, `<= cap` should pass.
    const at = new Uint8Array(MAX_DECOMPRESSED_BYTES);
    const body = await gzipBytes(at);
    const text = await validateAndDecompressIgc(body);
    expect(text.length).toBe(MAX_DECOMPRESSED_BYTES);
  });
});

describe("IgcValidationException", () => {
  test("carries a typed detail and a human message", async () => {
    try {
      await validateAndDecompressIgc(new ArrayBuffer(0));
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IgcValidationException);
      expect((err as IgcValidationException).detail.kind).toBe("empty");
      expect((err as IgcValidationException).message).toBe("Empty file");
    }
  });
});
