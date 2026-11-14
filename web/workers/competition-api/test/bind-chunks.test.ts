import { describe, expect, test } from "vitest";
import { D1_BIND_CHUNK, bindList, chunkForBinds } from "../src/lib/bind-chunks";

describe("chunkForBinds", () => {
  test("keeps every statement under D1's 100 bound parameters", () => {
    const ids = Array.from({ length: 400 }, (_, i) => i);
    const once = chunkForBinds(ids);
    expect(once.every((c) => c.length <= D1_BIND_CHUNK)).toBe(true);
    expect(once.flat()).toEqual(ids);

    // A list bound twice in one statement gets half the room.
    const twice = chunkForBinds(ids, 2);
    expect(twice.every((c) => c.length * 2 <= D1_BIND_CHUNK)).toBe(true);
    expect(twice.flat()).toEqual(ids);
  });

  test("no values, no statements", () => {
    expect(chunkForBinds([])).toEqual([]);
  });

  test("bindList writes one placeholder per value", () => {
    expect(bindList(3)).toBe("?,?,?");
  });
});
