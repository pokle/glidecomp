import { describe, expect, it } from "vitest";
import { approxTextWidth, truncateToWidth, wrapToWidth } from "./text-width";

describe("truncateToWidth", () => {
  it("leaves a label that fits alone", () => {
    expect(truncateToWidth("17. Steve Blenkinsop", 13, 400)).toBe("17. Steve Blenkinsop");
  });

  it("cuts a label that does not fit, and says that it did", () => {
    const cut = truncateToWidth("17. Steve Blenkinsop", 13, 100);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.startsWith("17. Steve")).toBe(true);
    expect(approxTextWidth(cut, 13)).toBeLessThanOrEqual(100);
    // As much of the name as there is room for: one more letter would not fit.
    const longer = `${"17. Steve Blenkinsop".slice(0, cut.length)}…`;
    expect(approxTextWidth(longer, 13)).toBeGreaterThan(100);
  });

  it("does not leave a space before the ellipsis", () => {
    expect(truncateToWidth("Jon Durand", 13, approxTextWidth("Jon …", 13))).toBe("Jon…");
  });

  it("is an ellipsis alone where nothing fits", () => {
    expect(truncateToWidth("Jon Durand", 13, 1)).toBe("…");
  });
});

describe("wrapToWidth", () => {
  const title = "How much of the thermal the pilot climbed before leaving it (per cent)";

  it("keeps a title that fits on one line", () => {
    expect(wrapToWidth("Glide speed", 13, 300)).toEqual(["Glide speed"]);
  });

  it("breaks at spaces, and no line is wider than the room", () => {
    const lines = wrapToWidth(title, 13, 280);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(" ")).toBe(title);
    for (const line of lines) expect(approxTextWidth(line, 13)).toBeLessThanOrEqual(280);
  });

  it("gives a word wider than the room a line of its own", () => {
    expect(wrapToWidth("a incomprehensibilities b", 13, 40)).toEqual([
      "a",
      "incomprehensibilities",
      "b",
    ]);
  });
});
