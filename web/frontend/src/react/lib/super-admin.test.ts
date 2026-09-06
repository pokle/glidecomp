import { describe, expect, test } from "bun:test";
import { isSuperAdminEmail } from "./super-admin";

describe("isSuperAdminEmail", () => {
  test("matches the allowlist case-insensitively", () => {
    expect(isSuperAdminEmail("tushar.pokle@gmail.com")).toBe(true);
    expect(isSuperAdminEmail("Tushar.Pokle@gmail.com")).toBe(true);
    expect(isSuperAdminEmail("  tushar.pokle@gmail.com  ")).toBe(true);
  });

  test("rejects everyone else", () => {
    expect(isSuperAdminEmail("organiser@example.com")).toBe(false);
    expect(isSuperAdminEmail("")).toBe(false);
    expect(isSuperAdminEmail(null)).toBe(false);
    expect(isSuperAdminEmail(undefined)).toBe(false);
  });
});
