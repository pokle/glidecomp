import { describe, expect, test } from "vitest";
import { isExternalHref } from "./router";

describe("isExternalHref", () => {
  test("an external URL is not an app route", () => {
    // The regression: react-router's useHref resolved this against the current
    // path, so the "New Google Sheet" button rendered
    // /comp/<comp>/scores/https:/sheets.new — a 404 only a click revealed.
    expect(isExternalHref("https://sheets.new")).toBe(true);
    expect(isExternalHref("http://example.com/x")).toBe(true);
  });

  test("non-http schemes pass through too", () => {
    expect(isExternalHref("mailto:someone@example.com")).toBe(true);
    expect(isExternalHref("tel:+61400000000")).toBe(true);
  });

  test("protocol-relative URLs are external", () => {
    expect(isExternalHref("//cdn.example.com/a.png")).toBe(true);
  });

  test("app routes are not external", () => {
    expect(isExternalHref("/comp/corryong-cup-2026-wuhu/scores")).toBe(false);
    expect(isExternalHref("/comp")).toBe(false);
  });

  test("a relative path is not external", () => {
    // Relative hrefs are exactly what useHref exists to resolve.
    expect(isExternalHref("scores")).toBe(false);
    expect(isExternalHref("./scores.csv")).toBe(false);
    expect(isExternalHref("../task/1")).toBe(false);
  });

  test("a path that merely contains a colon is not external", () => {
    // A scheme is a colon at the START, after a letter-led token — a colon
    // deeper in the path (a slug, a query) must not be mistaken for one.
    expect(isExternalHref("/comp/a-b/scores?x=a:b")).toBe(false);
    expect(isExternalHref("/comp/9:30-start-qffi")).toBe(false);
  });
});
