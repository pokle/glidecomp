import { describe, expect, it } from "vitest";
import { formatRankedScore, formatScore } from "./format";

describe("formatRankedScore", () => {
  it("prints the one-decimal total the ranks are decided on (S7F §15)", () => {
    expect(formatRankedScore(700.4)).toBe("700.4");
    expect(formatRankedScore(699.6)).toBe("699.6");
    expect(formatRankedScore(812.44)).toBe("812.4");
    expect(formatRankedScore(812.46)).toBe("812.5");
  });

  it("always shows the decimal, with thousands separators", () => {
    expect(formatRankedScore(1000)).toBe("1,000.0");
    expect(formatRankedScore(0)).toBe("0.0");
    expect(formatRankedScore(2250.33)).toBe("2,250.3");
  });

  it("leaves prose on whole points", () => {
    expect(formatScore(700.4)).toBe("700");
  });
});
