/**
 * Validate and decompress an uploaded IGC body.
 *
 * SEC-11 mitigation. The IGC upload routes accept gzip-compressed
 * bodies; the previous code applied a single 5 MB cap to the
 * *compressed* size, then materialised the entire decompressed buffer
 * with `arrayBuffer()`. A small gzip-bomb (~5 KB compressed → many GB
 * decompressed) could trip the worker's memory limit.
 *
 * This helper enforces four independent checks in the order they're
 * cheapest to run:
 *   1. Compressed-size cap (rejects giant blobs before allocating).
 *   2. Gzip magic (rejects non-gzip bodies before decompressing).
 *   3. Decompressed-size cap, enforced by `gunzipSync`'s `maxOutputLength`
 *      — zlib aborts with a RangeError the moment the output would exceed
 *      the cap, so a bomb never materialises more than the cap in memory.
 *   4. SEC-04: IGC content shape — manufacturer record (`A…`) plus the
 *      `HFDTE` date header. Same pattern as
 *      `airscore-api/src/handlers/track.ts:isValidIgcContent`. Blocks
 *      authenticated callers from stashing up to 2 MiB of arbitrary
 *      gzipped text per registered pilot per task / per user in R2.
 *
 * We decompress with the synchronous `node:zlib` `gunzipSync` (workerd has
 * `nodejs_compat`) rather than a `DecompressionStream` pipeline: corrupt
 * input and the bomb cap both surface as ordinary synchronous throws we
 * catch here. The streaming APIs, by contrast, report decompression
 * failures on internal promises that `pipeTo`/`pipeThrough` don't hand
 * back, which leak as unhandled rejections (harmless in production, but
 * noisy false positives in the test runner).
 *
 * Errors are typed so the route can return a clean 400 with a
 * specific message instead of a generic 500.
 */

import { gunzipSync } from "node:zlib";

export const MAX_COMPRESSED_BYTES = 1 * 1024 * 1024; // 1 MiB compressed
export const MAX_DECOMPRESSED_BYTES = 2 * 1024 * 1024; // 2 MiB decompressed

// Worker-wide request-body cap (SEC-06), registered as bodyLimit middleware
// in index.ts. Defined here, just above the compressed cap, so the two can't
// drift apart and the typed errors below stay the user-facing boundary
// errors. (Not exported from index.ts: workerd requires every named export
// of the entry module to be a handler.)
export const MAX_BODY_BYTES = MAX_COMPRESSED_BYTES + 1024;

export type IgcValidationError =
  | { kind: "empty"; message: string }
  | { kind: "compressed_too_large"; message: string }
  | { kind: "not_gzip"; message: string }
  | { kind: "decompressed_too_large"; message: string }
  | { kind: "decompression_failed"; message: string }
  | { kind: "not_igc_content"; message: string };

export class IgcValidationException extends Error {
  constructor(public readonly detail: IgcValidationError) {
    super(detail.message);
    this.name = "IgcValidationException";
  }
}

/**
 * Validate the gzip-compressed IGC `body` and return its decoded text.
 * Throws `IgcValidationException` (with a typed `detail`) on any failure.
 */
export async function validateAndDecompressIgc(
  body: ArrayBuffer
): Promise<string> {
  if (body.byteLength === 0) {
    throw new IgcValidationException({ kind: "empty", message: "Empty file" });
  }
  if (body.byteLength > MAX_COMPRESSED_BYTES) {
    throw new IgcValidationException({
      kind: "compressed_too_large",
      message: `Compressed file too large (max ${MAX_COMPRESSED_BYTES} bytes)`,
    });
  }

  // Gzip magic: 1f 8b. Reject anything that isn't gzip before decompressing
  // — kills "store arbitrary bytes in R2" abuse too.
  const bytes = new Uint8Array(body);
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    throw new IgcValidationException({
      kind: "not_gzip",
      message: "File is not gzip-compressed",
    });
  }

  // Decompress with a hard output cap. `maxOutputLength` makes zlib abort
  // with a RangeError as soon as the output would exceed the cap, so a gzip
  // bomb never buffers more than the cap. Corrupt/invalid deflate data
  // throws an ordinary Error. Both are caught synchronously here — no stream
  // pipeline, so no internal promise can leak as an unhandled rejection.
  let decompressed: Uint8Array;
  try {
    decompressed = gunzipSync(bytes, {
      maxOutputLength: MAX_DECOMPRESSED_BYTES,
    });
  } catch (err) {
    if (err instanceof RangeError) {
      throw new IgcValidationException({
        kind: "decompressed_too_large",
        message: `Decompressed file too large (max ${MAX_DECOMPRESSED_BYTES} bytes)`,
      });
    }
    throw new IgcValidationException({
      kind: "decompression_failed",
      message: "Could not decompress file (not valid gzip)",
    });
  }

  const text = new TextDecoder().decode(decompressed);
  // SEC-04: every real IGC starts with `A` (manufacturer record) and
  // carries the `HFDTE` date header. Reject anything that doesn't so
  // attackers can't use the upload as a free 2 MiB blob store in R2.
  if (text[0] !== "A" || !text.includes("HFDTE")) {
    throw new IgcValidationException({
      kind: "not_igc_content",
      message: "File does not look like an IGC track log",
    });
  }
  return text;
}
