import { describe, expect, test } from "vitest";
import { isExternalHref, isServerHref } from "./router";

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

describe("isServerHref", () => {
  const BASE = "https://glidecomp.com/settings";

  test("a Pages Function download is the server's to answer", () => {
    // The regression: the superadmin CIVL rankings button client-navigated to
    // /civl-rankings.csv, react-router matched nothing and rendered the 404
    // page — and only a reload (a real request) produced the file.
    expect(isServerHref("/civl-rankings.csv", BASE)).toBe(true);
    expect(isServerHref("/sitemap.xml", BASE)).toBe(true);
  });

  test("a separate Vite entry is too", () => {
    expect(isServerHref("/analysis.html?storedTrack=abc", BASE)).toBe(true);
  });

  test("a relative file href resolves against the current page", () => {
    expect(isServerHref("./scores.csv", "https://glidecomp.com/comp/a-wuhu/")).toBe(true);
  });

  test("SPA routes are not server hrefs", () => {
    expect(isServerHref("/comp/corryong-cup-2026-wuhu/scores", BASE)).toBe(false);
    expect(isServerHref("/u/some-pilot", BASE)).toBe(false);
    expect(isServerHref("/", BASE)).toBe(false);
    expect(isServerHref("scores", BASE)).toBe(false);
  });

  test("a dot in the query or hash is not a filename", () => {
    expect(isServerHref("/comp?q=a.csv", BASE)).toBe(false);
    expect(isServerHref("/comp/a-wuhu/scores#pilot-1.5", BASE)).toBe(false);
  });

  test("external URLs stay isExternalHref's business", () => {
    // Both branches do the same thing at the call site; keeping them disjoint
    // means neither claims a URL the other already handled.
    expect(isServerHref("https://sheets.new", BASE)).toBe(false);
    expect(isServerHref("mailto:someone@example.com", BASE)).toBe(false);
  });
});
