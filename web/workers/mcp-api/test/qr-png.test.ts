import { describe, expect, test } from "bun:test";
import { encode } from "uqr";
import { qrPng } from "../src/qr-png";

/** The PNG's pixels back out, as rows of true-for-black. */
async function decode(png: Uint8Array<ArrayBuffer>): Promise<{ width: number; rows: boolean[][] }> {
  const view = new DataView(png.buffer, png.byteOffset);
  let at = 8;
  let width = 0;
  const idat: Uint8Array<ArrayBuffer>[] = [];
  while (at < png.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const body = png.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      expect([...body.subarray(8)]).toEqual([1, 0, 0, 0, 0]);
    }
    if (type === "IDAT") idat.push(body.slice());
    at += 12 + len;
  }
  const stream = new Blob(idat).stream().pipeThrough(new DecompressionStream("deflate"));
  const raw = new Uint8Array(await new Response(stream).arrayBuffer());
  const rowBytes = Math.ceil(width / 8);
  const rows = Array.from({ length: width }, (_, y) => {
    expect(raw[y * (rowBytes + 1)]).toBe(0);
    return Array.from({ length: width }, (_, x) => !(raw[y * (rowBytes + 1) + 1 + (x >> 3)]! & (0x80 >> (x & 7))));
  });
  return { width, rows };
}

describe("qrPng", () => {
  test("draws exactly the QR's modules, 8 px each, with a 4-module quiet zone", async () => {
    const text = 'XCTSK:{"version":2,"t":[{"n":"ELLIOT","z":"abc"}],"taskType":"CLASSIC"}';
    const qr = encode(text, { ecc: "L", border: 4 });
    const { width, rows } = await decode(await qrPng(text));
    expect(width).toBe(qr.size * 8);
    for (let y = 0; y < width; y++) {
      for (let x = 0; x < width; x++) {
        if (rows[y]![x] !== qr.data[y >> 3]![x >> 3]) throw new Error(`pixel ${x},${y} differs from its module`);
      }
    }
    // The quiet zone is white all round.
    expect(rows[0]!.every((b) => !b)).toBe(true);
    expect(rows.every((r) => !r[width - 1])).toBe(true);
  });
});
