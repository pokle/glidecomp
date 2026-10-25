/**
 * A QR code as a PNG, for a tool to return as an MCP `image` block.
 *
 * PNG rather than SVG because many clients pass an image to the model's
 * vision input, and that accepts raster formats only. uqr gives the module
 * matrix; the PNG is written here, one bit per pixel, with the Workers
 * runtime's own CompressionStream doing the zlib. "deflate" in the
 * Compression Streams spec IS zlib framing, which is what PNG's IDAT holds.
 */
import { encode } from "uqr";

/** Pixels per QR module: a version-25 task QR comes out near 1000 px. */
const SCALE = 8;
/** The quiet zone the QR spec asks for, in modules. */
const BORDER = 4;

/** The QR of `text` as PNG bytes. Error correction L, as the task page draws it. */
export async function qrPng(text: string): Promise<Uint8Array<ArrayBuffer>> {
  const { data, size } = encode(text, { ecc: "L", border: BORDER });
  const px = size * SCALE;
  const rowBytes = Math.ceil(px / 8);
  // Each row is a filter byte (0, none) then the packed bits; 1 is white.
  const raw = new Uint8Array((rowBytes + 1) * px);
  for (let y = 0; y < px; y++) {
    const row = data[Math.floor(y / SCALE)]!;
    const base = y * (rowBytes + 1) + 1;
    for (let x = 0; x < px; x++) {
      if (!row[Math.floor(x / SCALE)]) raw[base + (x >> 3)]! |= 0x80 >> (x & 7);
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, px);
  view.setUint32(4, px);
  header.set([1, 0, 0, 0, 0], 8); // bit depth 1, greyscale, deflate, no filter, no interlace
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", await zlib(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

async function zlib(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function chunk(type: string, body: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function concat(parts: Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Bytes as base64, which is how an MCP `image` block carries them. */
export function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
