import { describe, expect, it } from "vitest";
import { isSuperAdminEmail } from "./super-admin";

describe("isSuperAdminEmail", () => {
  it("matches the allowlist case-insensitively", () => {
    expect(isSuperAdminEmail("tushar.pokle@gmail.com")).toBe(true);
    expect(isSuperAdminEmail("Tushar.Pokle@gmail.com")).toBe(true);
    expect(isSuperAdminEmail("  tushar.pokle@gmail.com  ")).toBe(true);
  });

  it("rejects everyone else", () => {
    expect(isSuperAdminEmail("organiser@example.com")).toBe(false);
    expect(isSuperAdminEmail("")).toBe(false);
    expect(isSuperAdminEmail(null)).toBe(false);
    expect(isSuperAdminEmail(undefined)).toBe(false);
  });
});
