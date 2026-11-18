import { describe, expect, it } from "vitest";
import { legBoundaries } from "./LegWaterfall";

describe("legBoundaries", () => {
  it("names each turnpoint once where the legs join end to end", () => {
    expect(legBoundaries(["SSS→HALFWY", "HALFWY→CUDGWE", "CUDGWE→ESS"])).toEqual([
      "SSS",
      "HALFWY",
      "CUDGWE",
      "ESS",
    ]);
  });

  it("reads a single leg", () => {
    expect(legBoundaries(["SSS→ESS"])).toEqual(["SSS", "ESS"]);
  });

  it("gives up on legs that do not join, so each is named whole", () => {
    expect(legBoundaries(["SSS→A", "B→ESS"])).toBeNull();
  });

  it("gives up on a label that is not two names and an arrow", () => {
    expect(legBoundaries(["SSS to ESS"])).toBeNull();
    expect(legBoundaries(["SSS→A→B", "B→ESS"])).toBeNull();
    expect(legBoundaries(["→A", "A→ESS"])).toBeNull();
    expect(legBoundaries([])).toBeNull();
  });
});
