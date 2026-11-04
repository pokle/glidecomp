import { describe, expect, it } from "vitest";
import { openedHere, wasOpenedHere } from "./leave";
import { reportViewState } from "../analysis/TaskAnalysisFrame";

describe("openedHere", () => {
  it("marks the entry it opens, beside any state of the opener's own", () => {
    const { state } = openedHere({ addingType: "GOAL" });
    expect(wasOpenedHere(state)).toBe(true);
    expect(state.addingType).toBe("GOAL");
  });

  it("is not claimed by an entry nobody marked: a reload, a bookmark", () => {
    expect(wasOpenedHere(null)).toBe(false);
    expect(wasOpenedHere(undefined)).toBe(false);
    expect(wasOpenedHere({ preserveScroll: true })).toBe(false);
    expect(wasOpenedHere({ openedHere: "yes" })).toBe(false);
  });

  it("survives what useCanonicalPath does to state: a spread with preserveScroll", () => {
    const corrected = { ...openedHere().state, preserveScroll: true };
    expect(wasOpenedHere(corrected)).toBe(true);
  });
});

describe("reportViewState", () => {
  it("keeps the class and the pinned pilot, and nothing a section reads", () => {
    const q = new URLSearchParams("class=open&pilot=Ana&metric=climb&thermal=3&map=1");
    expect(reportViewState(q)).toBe("class=open&pilot=Ana");
    expect(reportViewState(new URLSearchParams("metric=climb"))).toBe("");
  });
});
