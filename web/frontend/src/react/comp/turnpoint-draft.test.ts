import { describe, expect, it } from "vitest";
import {
  TYPE_OPTIONS,
  demoteOtherGoals,
  inferAddedType,
  moveRowToEnd,
  typeOptions,
} from "./turnpoint-draft";

describe("typeOptions", () => {
  it("lists Takeoff, Start, Turnpoint, ESS, Goal in that order", () => {
    expect(TYPE_OPTIONS.map((o) => o.label)).toEqual([
      "Takeoff",
      "Start",
      "Turnpoint",
      "ESS",
      "Goal",
    ]);
  });

  it("keeps the untyped option as Turnpoint mid-route", () => {
    expect(typeOptions({ lastIsGoal: false }).find((o) => o.value === "")?.label).toBe(
      "Turnpoint"
    );
  });

  it("names the last turnpoint's untyped option as last-is-goal", () => {
    const last = typeOptions({ lastIsGoal: true });
    expect(last.find((o) => o.value === "")?.label).toBe("Turnpoint (last is goal)");
    expect(last.find((o) => o.value === "GOAL")?.label).toBe("Goal");
  });
});

describe("inferAddedType", () => {
  it("makes the first Takeoff, the second Start, then Turnpoint", () => {
    expect(inferAddedType([])).toBe("TAKEOFF");
    expect(inferAddedType([{ type: "TAKEOFF" }])).toBe("SSS");
    expect(inferAddedType([{ type: "TAKEOFF" }, { type: "SSS" }])).toBe("");
    expect(
      inferAddedType([{ type: "TAKEOFF" }, { type: "SSS" }, { type: "" }])
    ).toBe("");
  });

  it("makes a new last Goal when the current last already is", () => {
    expect(
      inferAddedType([{ type: "TAKEOFF" }, { type: "SSS" }, { type: "GOAL" }])
    ).toBe("GOAL");
  });

  it("does not infer ESS, and does not treat an ESS last as Goal", () => {
    expect(
      inferAddedType([{ type: "TAKEOFF" }, { type: "SSS" }, { type: "ESS" }])
    ).toBe("");
  });

  it("open distance is Takeoff when empty, untyped after that", () => {
    expect(inferAddedType([], { openDistance: true })).toBe("TAKEOFF");
    expect(inferAddedType([{ type: "TAKEOFF" }], { openDistance: true })).toBe("");
  });
});

describe("demoteOtherGoals", () => {
  it("turns every other Goal into a Turnpoint", () => {
    const rows = [
      { id: 1, type: "TAKEOFF" as const },
      { id: 2, type: "GOAL" as const },
      { id: 3, type: "GOAL" as const },
    ];
    expect(demoteOtherGoals(rows, 3)).toEqual([
      { id: 1, type: "TAKEOFF" },
      { id: 2, type: "" },
      { id: 3, type: "GOAL" },
    ]);
  });
});

describe("moveRowToEnd", () => {
  it("moves a mid-route row to the end", () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(moveRowToEnd(rows, 2).map((r) => r.id)).toEqual([1, 3, 2]);
    expect(moveRowToEnd(rows, 3).map((r) => r.id)).toEqual([1, 2, 3]);
  });
});
