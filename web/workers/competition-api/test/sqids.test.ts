import { describe, expect, test } from "vitest";
import { encodeId, decodeId } from "../src/sqids";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz";

describe("Sqids encoding/decoding", () => {
  test("encodes an ID to a lowercase string of at least 4 chars", () => {
    const encoded = encodeId(ALPHABET, 1);
    expect(encoded.length).toBeGreaterThanOrEqual(4);
    expect(encoded).toMatch(/^[a-z]+$/);
  });

  test("decodes back to the original ID", () => {
    for (const id of [1, 42, 100, 9999, 123456]) {
      const encoded = encodeId(ALPHABET, id);
      const decoded = decodeId(ALPHABET, encoded);
      expect(decoded).toBe(id);
    }
  });

  test("returns null for invalid encoded strings", () => {
    expect(decodeId(ALPHABET, "")).toBeNull();
    expect(decodeId(ALPHABET, "!!!")).toBeNull();
    expect(decodeId(ALPHABET, "ABCD")).toBeNull();
  });

  test("different IDs produce different encoded strings", () => {
    const a = encodeId(ALPHABET, 1);
    const b = encodeId(ALPHABET, 2);
    expect(a).not.toBe(b);
  });

  test("encoded strings are lowercase only", () => {
    for (const id of [1, 100, 10000]) {
      const encoded = encodeId(ALPHABET, id);
      expect(encoded).toBe(encoded.toLowerCase());
      expect(encoded).toMatch(/^[a-z]+$/);
    }
  });
});
