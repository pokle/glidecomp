// Unit tests for auto-derived usernames (src/username.ts). Pure functions, no
// worker/D1 needed — `isTaken` is stubbed with an in-memory set.

import { describe, expect, test } from "vitest";
import {
  deriveUniqueUsername,
  slugifyUsername,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from "../src/username";

// The regex the manual set-username endpoint enforces. Every derived username
// must satisfy it, or the two paths would disagree about what's valid.
const VALID = /^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]$/;

function assertValid(username: string): void {
  expect(username.length).toBeGreaterThanOrEqual(USERNAME_MIN_LENGTH);
  expect(username.length).toBeLessThanOrEqual(USERNAME_MAX_LENGTH);
  expect(username).toMatch(VALID);
}

/** isTaken backed by a fixed set of already-used names. */
const taken = (...used: string[]) => {
  const set = new Set(used);
  return async (u: string) => set.has(u);
};

describe("slugifyUsername", () => {
  test("lowercases and hyphenates spaces", () => {
    expect(slugifyUsername("E2E Test Pilot")).toBe("e2e-test-pilot");
  });

  test("folds accents to ASCII", () => {
    expect(slugifyUsername("Renée Élan")).toBe("renee-elan");
  });

  test("collapses runs of punctuation to a single hyphen", () => {
    expect(slugifyUsername("a..b__c!!d")).toBe("a-b-c-d");
  });

  test("trims leading and trailing hyphens", () => {
    expect(slugifyUsername("  --Hi there!--  ")).toBe("hi-there");
  });

  test("returns empty for input with no usable characters", () => {
    expect(slugifyUsername("🪂🪂")).toBe("");
    expect(slugifyUsername("   ")).toBe("");
  });
});

describe("deriveUniqueUsername", () => {
  test("derives from the first candidate when free", async () => {
    const u = await deriveUniqueUsername(["Jane Doe", "jane@x.com"], taken());
    expect(u).toBe("jane-doe");
    assertValid(u);
  });

  test("falls back to the next candidate when the first slugifies too short", async () => {
    // "Al" slugifies to 2 chars (< min); the email local-part wins. The caller
    // passes the local-part, not the whole address (see the create hook).
    const u = await deriveUniqueUsername(["Al", "alberto"], taken());
    expect(u).toBe("alberto");
    assertValid(u);
  });

  test("falls back to 'pilot' when nothing usable", async () => {
    const u = await deriveUniqueUsername(["🪂", ""], taken());
    expect(u).toBe("pilot");
    assertValid(u);
  });

  test("appends -2 on collision, then -3", async () => {
    expect(await deriveUniqueUsername(["Jane Doe"], taken("jane-doe"))).toBe("jane-doe-2");
    expect(
      await deriveUniqueUsername(["Jane Doe"], taken("jane-doe", "jane-doe-2"))
    ).toBe("jane-doe-3");
  });

  test("caps the base at the max length", async () => {
    const u = await deriveUniqueUsername(
      ["Wolfeschlegelsteinhausenbergerdorff"],
      taken()
    );
    expect(u.length).toBeLessThanOrEqual(USERNAME_MAX_LENGTH);
    assertValid(u);
  });

  test("keeps the numeric suffix within the length cap and stays valid", async () => {
    // A 20-char base forces the stem to be truncated to make room for "-2".
    const base = "abcdefghijklmnopqrst"; // exactly 20 chars
    const u = await deriveUniqueUsername([base], taken(base));
    expect(u.length).toBeLessThanOrEqual(USERNAME_MAX_LENGTH);
    expect(u.endsWith("-2")).toBe(true);
    assertValid(u);
  });

  test("never emits a leading/trailing hyphen even after truncation", async () => {
    // Truncating right after a hyphen must not leave a trailing hyphen.
    const u = await deriveUniqueUsername(["ab cdefghijklmnopqrstuv"], taken());
    assertValid(u);
    expect(u.startsWith("-")).toBe(false);
    expect(u.endsWith("-")).toBe(false);
  });
});
