import { describe, expect, test } from "vitest";
import { linkUri } from "./pdf-writer";

describe("linkUri", () => {
  test("writes an http(s) URL as hex of its ASCII bytes", () => {
    const uri = linkUri("https://glidecomp.com/comp/a-b");
    expect(uri?.decodeText()).toBe("https://glidecomp.com/comp/a-b");
    expect(uri?.toString()).toBe(`<${Buffer.from("https://glidecomp.com/comp/a-b").toString("hex")}>`);
  });

  test("percent-encodes what a PDF string could not carry literally", () => {
    const uri = linkUri("https://glidecomp.com/comp/x) /S /JavaScript (é\\");
    const text = uri!.toString();
    // Only hex digits between the angle brackets: no delimiter survives.
    expect(text).toMatch(/^<[0-9a-f]+>$/);
    expect(Buffer.from(text.slice(1, -1), "hex").toString("latin1")).toBe(
      new URL("https://glidecomp.com/comp/x) /S /JavaScript (é\\").href
    );
  });

  test("refuses anything that is not http(s)", () => {
    expect(linkUri("javascript:alert(1)")).toBeNull();
    expect(linkUri("file:///etc/passwd")).toBeNull();
    expect(linkUri("not a url")).toBeNull();
  });
});
