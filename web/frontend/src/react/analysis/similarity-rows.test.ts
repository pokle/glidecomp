import { describe, expect, it } from "vitest";
import { alikeAndOpposite } from "./similarity-rows";

describe("alikeAndOpposite", () => {
  it("names the strongest behaviour of each kind, in words", () => {
    expect(
      alikeAndOpposite([
        { label: "Glide speed between climbs", contribution: 0.3 },
        { label: "Glide L/D against the field median", contribution: 0.1 },
        { label: "Time spent flying with a gaggle", contribution: -0.2 },
        { label: "Mean climb rate", contribution: -0.05 },
      ])
    ).toBe("Alike: glide speed between climbs. Opposite: time spent flying with a gaggle.");
  });

  it("leaves out the half that is not there", () => {
    expect(alikeAndOpposite([{ label: "Mean climb rate", contribution: 0.4 }])).toBe(
      "Alike: mean climb rate."
    );
    expect(alikeAndOpposite([])).toBe("");
  });

  it("does not lower an abbreviation at the start of a name", () => {
    expect(alikeAndOpposite([{ label: "L/D on final glide", contribution: 0.2 }])).toBe(
      "Alike: L/D on final glide."
    );
  });
});
