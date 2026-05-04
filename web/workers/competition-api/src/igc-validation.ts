/**
 * Validate and stream-decompress an uploaded IGC body.
 *
 * SEC-11 mitigation. The IGC upload routes accept gzip-compressed
 * bodies; the previous code applied a single 5 MB cap to the
 * *compressed* size, then materialised the entire decompressed buffer
 * with `arrayBuffer()`. A small gzip-bomb (~5 KB compressed → many GB
 * decompressed) could trip the worker's memory limit.
 *
 * This helper enforces three independent caps in the order they're
 * cheapest to check:
 *   1. Compressed-size cap (rejects giant blobs before allocating).
 *   2. Gzip magic (rejects non-gzip bodies before starting the
 *      DecompressionStream).
 *   3. Decompressed-size cap, enforced *while* streaming — never
 *      buffers more than the cap, even for highly compressible input.
 *
 * Errors are typed so the route can return a clean 400 with a
 * specific message instead of a generic 500.
 */

export const MAX_COMPRESSED_BYTES = 1 * 1024 * 1024; // 1 MiB compressed
export const MAX_DECOMPRESSED_BYTES = 2 * 1024 * 1024; // 2 MiB decompressed

export type IgcValidationError =
  | { kind: "empty"; message: string }
  | { kind: "compressed_too_large"; message: string }
  | { kind: "not_gzip"; message: string }
  | { kind: "decompressed_too_large"; message: string }
  | { kind: "decompression_failed"; message: string };

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

  // Gzip magic: 1f 8b. Reject anything that isn't gzip before allocating
  // a DecompressionStream — kills "store arbitrary bytes in R2" abuse too.
  const head = new Uint8Array(body, 0, Math.min(2, body.byteLength));
  if (head.length < 2 || head[0] !== 0x1f || head[1] !== 0x8b) {
    throw new IgcValidationException({
      kind: "not_gzip",
      message: "File is not gzip-compressed",
    });
  }

  // Stream-decompress with a hard cap. The pipeline is: source body →
  // gzip decompressor → byte counter (errors on overflow) → consumer.
  // We await every promise the pipeline produces (via allSettled) so
  // pipeline errors are observed exactly once and never leak as
  // unhandled rejections.
  let total = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > MAX_DECOMPRESSED_BYTES) {
        controller.error(
          new IgcValidationException({
            kind: "decompressed_too_large",
            message: `Decompressed file too large (max ${MAX_DECOMPRESSED_BYTES} bytes)`,
          })
        );
        return;
      }
      controller.enqueue(chunk);
    },
  });

  const decompressor = new DecompressionStream("gzip");
  const source = new Response(body).body!;

  const sourcePipe = source.pipeTo(decompressor.writable);
  const decompressPipe = decompressor.readable.pipeTo(counter.writable);
  const consume = new Response(counter.readable).arrayBuffer();

  const [, , consumeResult] = await Promise.allSettled([
    sourcePipe,
    decompressPipe,
    consume,
  ]);

  if (consumeResult.status === "fulfilled") {
    return new TextDecoder().decode(consumeResult.value);
  }
  const err = consumeResult.reason;
  if (err instanceof IgcValidationException) throw err;
  throw new IgcValidationException({
    kind: "decompression_failed",
    message: "Could not decompress file (not valid gzip)",
  });
}
