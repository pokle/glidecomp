import { describe, it, expect } from "vitest";
import { safeNext } from "./safe-next";

describe("safeNext (post-sign-in redirect target)", () => {
  it("passes through ordinary same-origin paths", () => {
    expect(safeNext("/comp")).toBe("/comp");
    expect(safeNext("/comp/abc/task/def")).toBe("/comp/abc/task/def");
    expect(safeNext("/comp?x=1#y")).toBe("/comp?x=1#y");
  });

  it("falls back when next is empty or missing", () => {
    expect(safeNext(null)).toBe("/comp");
    expect(safeNext(undefined)).toBe("/comp");
    expect(safeNext("")).toBe("/comp");
  });

  it("rejects protocol-relative and absolute URLs (open redirect)", () => {
    expect(safeNext("//evil.example")).toBe("/comp");
    expect(safeNext("https://evil.example")).toBe("/comp");
    expect(safeNext("http://evil.example/path")).toBe("/comp");
  });

  // SEC-30 regression: the old `startsWith("/") && !startsWith("//")` guard let
  // this through, but browsers fold "/\\" into "//" so it resolves to
  // https://evil.example — an open redirect.
  it("rejects the backslash-folded host bypass", () => {
    expect(safeNext("/\\evil.example")).toBe("/comp");
    expect(safeNext("/\\\\evil.example")).toBe("/comp");
    expect(safeNext("/\\/evil.example")).toBe("/comp");
  });

  it("rejects non-http schemes like javascript:", () => {
    expect(safeNext("javascript:alert(1)")).toBe("/comp");
    expect(safeNext("data:text/html,<script>1</script>")).toBe("/comp");
  });

  it("honours a custom fallback", () => {
    expect(safeNext("//evil.example", "")).toBe("");
    expect(safeNext(null, "/")).toBe("/");
  });
});
