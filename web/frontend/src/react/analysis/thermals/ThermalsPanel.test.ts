/**
 * The census's URL parameter, which is the whole of the section's selection
 * state — and which had a hole in it: thermal ids start at ZERO, and
 * `URLSearchParams.get` answers `null` for an absent parameter, so the
 * `Number(...)` this replaced read "no thermal chosen" as "the thermal with
 * id 0". Stacked, that meant /analysis/thermals opened on a thermal instead
 * of the census, and "All thermals" — which deletes the parameter — put the
 * reader straight back where they were.
 */
import { describe, it, expect } from "vitest";
import { thermalFromParam } from "./ThermalsPanel";

const shapes = [{ id: 0 }, { id: 1 }, { id: 42 }];

describe("thermalFromParam", () => {
  it("chooses nothing when the parameter is absent, even where a thermal has id 0", () => {
    expect(thermalFromParam(null, shapes)).toBeNull();
  });

  it("chooses nothing for an empty or unparseable value", () => {
    expect(thermalFromParam("", shapes)).toBeNull();
    expect(thermalFromParam("abc", shapes)).toBeNull();
    expect(thermalFromParam("1.0", shapes)).toBeNull();
  });

  it("chooses nothing for an id this report does not carry", () => {
    expect(thermalFromParam("7", shapes)).toBeNull();
  });

  it("chooses the thermal the value names, id 0 included", () => {
    expect(thermalFromParam("0", shapes)).toBe(shapes[0]);
    expect(thermalFromParam("42", shapes)).toBe(shapes[2]);
  });
});
