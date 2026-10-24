import { describe, expect, it } from "vitest";
import { linkify, webHref } from "./linkify";

const links = (text: string) =>
  linkify(text).filter((p) => p.kind === "link").map((p) => (p.kind === "link" ? p.href : ""));

describe("linkify", () => {
  it("leaves text without addresses as one text part", () => {
    expect(linkify("Briefing 9:30 at the launch shelter.")).toEqual([
      { kind: "text", text: "Briefing 9:30 at the launch shelter." },
    ]);
    expect(linkify("")).toEqual([]);
  });

  it("links http and https addresses, keeping the text around them", () => {
    expect(linkify("Live tracking: https://puretrack.io/g/abc then dinner")).toEqual([
      { kind: "text", text: "Live tracking: " },
      { kind: "link", text: "https://puretrack.io/g/abc", href: "https://puretrack.io/g/abc" },
      { kind: "text", text: " then dinner" },
    ]);
    expect(links("see http://example.com/a?b=1#c")).toEqual(["http://example.com/a?b=1#c"]);
    expect(links("HTTPS://Example.com/X")).toEqual(["https://example.com/X"]);
  });

  it("keeps the text intact, links or not", () => {
    const text = "a https://x.com/1 b\nhttps://y.com/2.\njavascript:alert(1) c";
    expect(linkify(text).map((p) => p.text).join("")).toBe(text);
  });

  it("leaves sentence punctuation outside the link", () => {
    expect(links("Results at https://x.com/r.")).toEqual(["https://x.com/r"]);
    expect(links("(see https://x.com/r)")).toEqual(["https://x.com/r"]);
    expect(links("https://x.com/r, https://y.com/s;")).toEqual(["https://x.com/r", "https://y.com/s"]);
    // A parenthesis that belongs to the address stays.
    expect(links("https://en.wikipedia.org/wiki/Glider_(sailplane)")).toEqual([
      "https://en.wikipedia.org/wiki/Glider_(sailplane)",
    ]);
  });

  it("never links a script, data or other non-web scheme", () => {
    for (const text of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "java\tscript:alert(1)",
      " javascript:alert(document.cookie)",
      "&#106;avascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "mailto:someone@example.com",
      "ftp://example.com/x",
      "//evil.example/x",
      "www.example.com",
    ]) {
      expect(links(text), text).toEqual([]);
    }
  });

  it("does not let a web scheme smuggle in another one", () => {
    expect(links("https://javascript:alert(1)")).toEqual([]);
    expect(links("http://")).toEqual([]);
    // Only the address up to the first angle bracket or quote is taken, and
    // the href is the parser's normalised form, never raw markup.
    expect(links('https://x.com/"><script>alert(1)</script>')).toEqual(["https://x.com/"]);
    expect(links("https://x.com/<img src=x onerror=alert(1)>")).toEqual(["https://x.com/"]);
  });
});

describe("webHref", () => {
  it("answers only for absolute http(s) URLs", () => {
    expect(webHref("https://x.com")).toBe("https://x.com/");
    expect(webHref("javascript:alert(1)")).toBeNull();
    expect(webHref("/relative")).toBeNull();
    expect(webHref("not a url")).toBeNull();
  });
});
