import { describe, expect, it } from "vitest";
import { TYPE_OPTIONS, typeOptions } from "./turnpoint-draft";

describe("typeOptions", () => {
  it("keeps the untyped option as Turnpoint mid-route", () => {
    expect(typeOptions()).toEqual(TYPE_OPTIONS);
    expect(typeOptions({ lastIsGoal: false }).find((o) => o.value === "")?.label).toBe(
      "Turnpoint"
    );
  });

  it("names the last turnpoint's untyped option as the goal", () => {
    const last = typeOptions({ lastIsGoal: true });
    expect(last.find((o) => o.value === "")?.label).toBe("Turnpoint (last is goal)");
    expect(last.filter((o) => o.value !== "").map((o) => o.label)).toEqual(
      TYPE_OPTIONS.filter((o) => o.value !== "").map((o) => o.label)
    );
  });
});
