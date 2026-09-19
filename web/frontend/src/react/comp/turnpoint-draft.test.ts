/**
 * The one conversion from a competition waypoint to a turnpoint draft, and
 * the Type list the sheet and the add-inference share.
 *
 * Mostly about a single character: a waypoint at sea level carries 0, and only
 * an ABSENT altitude is blank. That distinction was fixed in
 * `draftFromRecord` while `TurnpointSheet` kept its own copy of the line, so
 * picking a sea-level waypoint in the route editor went on turning 0 into
 * "unknown" — the exact bug the conversion was moved here to kill. These tests
 * hold both entry points to it.
 */
import { describe, expect, it } from "vitest";
import type { WaypointFileRecord } from "@glidecomp/engine";
import type { TurnpointDraft } from "./turnpoint-draft";
import {
  NEW_ROW_RADIUS,
  TYPE_OPTIONS,
  blankDraft,
  demoteOtherGoals,
  draftFromRecord,
  draftWithRecord,
  inferAddedType,
  missingAltitude,
  moveRowToEnd,
  reconcileGoalPosition,
  showGoalSettings,
  typeOptions,
} from "./turnpoint-draft";

const waypoint = (over: Partial<WaypointFileRecord> = {}): WaypointFileRecord => ({
  code: "BEACH",
  name: "Sea level launch",
  latitude: -36.5,
  longitude: 146.5,
  radius: 0,
  ...over,
});

describe("typeOptions", () => {
  it("lists Takeoff, SSS, Turnpoint, ESS, Goal in that order", () => {
    expect(TYPE_OPTIONS.map((o) => o.label)).toEqual([
      "Takeoff",
      "Start Speed Section (SSS)",
      "Turnpoint",
      "End Speed Section (ESS)",
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

describe("showGoalSettings", () => {
  it("hides Goal on open distance", () => {
    expect(showGoalSettings({ openDistance: true, isLast: true })).toBe(false);
    expect(showGoalSettings({ openDistance: true, addingType: "GOAL" })).toBe(false);
  });

  it("hides Goal while adding a Takeoff or Start", () => {
    expect(showGoalSettings({ addingType: "TAKEOFF" })).toBe(false);
    expect(showGoalSettings({ addingType: "SSS" })).toBe(false);
  });

  it("shows Goal when adding a Turnpoint or Goal", () => {
    expect(showGoalSettings({ addingType: "" })).toBe(true);
    expect(showGoalSettings({ addingType: "GOAL" })).toBe(true);
  });

  it("shows Goal when editing the last turnpoint", () => {
    expect(showGoalSettings({ isLast: true })).toBe(true);
    expect(showGoalSettings({ isLast: false })).toBe(false);
  });
});

describe("reconcileGoalPosition", () => {
  it("demotes a Goal that is no longer last and gives Goal to the new last", () => {
    const rows = [
      { id: 1, type: "TAKEOFF" as const },
      { id: 2, type: "GOAL" as const },
      { id: 3, type: "" as const },
    ];
    expect(reconcileGoalPosition(rows)).toEqual([
      { id: 1, type: "TAKEOFF" },
      { id: 2, type: "" },
      { id: 3, type: "GOAL" },
    ]);
  });

  it("leaves an ESS last alone and demotes the Goal", () => {
    const rows = [
      { id: 1, type: "GOAL" as const },
      { id: 2, type: "ESS" as const },
    ];
    expect(reconcileGoalPosition(rows)).toEqual([
      { id: 1, type: "" },
      { id: 2, type: "ESS" },
    ]);
  });

  it("is a no-op when Goal is already last", () => {
    const rows = [
      { id: 1, type: "SSS" as const },
      { id: 2, type: "GOAL" as const },
    ];
    expect(reconcileGoalPosition(rows)).toEqual(rows);
  });
});

describe("draftFromRecord", () => {
  it("carries a sea-level 0 across as 0", () => {
    expect(draftFromRecord(waypoint({ altitude: 0 })).altitude).toBe(0);
  });

  it("leaves an absent altitude blank", () => {
    expect(draftFromRecord(waypoint()).altitude).toBe("");
  });

  it("copies the waypoint's own radius, and defaults when it has none", () => {
    expect(draftFromRecord(waypoint({ radius: 2000 })).radius).toBe(2000);
    expect(draftFromRecord(waypoint({ radius: 0 })).radius).toBe(NEW_ROW_RADIUS);
  });

  it("names the turnpoint after the code, and only describes a longer name", () => {
    const named = draftFromRecord(waypoint({ code: "BEACH", name: "Sea level launch" }));
    expect(named.name).toBe("BEACH");
    expect(named.description).toBe("Sea level launch");
    const same = draftFromRecord(waypoint({ code: "BEACH", name: "BEACH" }));
    expect(same.description).toBe("");
  });
});

/** A half-filled turnpoint, as the details sheet has it before a load. */
const started = (over: Partial<TurnpointDraft> = {}): TurnpointDraft => ({
  ...blankDraft(),
  ...over,
});

describe("draftWithRecord", () => {
  it("takes the waypoint's altitude, 0 included", () => {
    const current = started({ altitude: 1200, type: "SSS" });
    expect(draftWithRecord(current, waypoint({ altitude: 0 })).altitude).toBe(0);
  });

  it("blanks the altitude when the waypoint has none", () => {
    const current = started({ altitude: 1200 });
    expect(draftWithRecord(current, waypoint()).altitude).toBe("");
  });

  it("keeps the turnpoint type, which no waypoint carries", () => {
    const current = started({ type: "ESS" });
    expect(draftWithRecord(current, waypoint({ radius: 1000 })).type).toBe("ESS");
  });

  it("keeps a radius the organiser chose when the waypoint has none of its own", () => {
    const current = started({ radius: 3000 });
    expect(draftWithRecord(current, waypoint({ radius: 0 })).radius).toBe(3000);
    expect(draftWithRecord(current, waypoint({ radius: 1000 })).radius).toBe(1000);
  });

  it("agrees with draftFromRecord about everything else", () => {
    const rec = waypoint({ altitude: 0, radius: 5000 });
    const fresh = draftFromRecord(rec);
    const loaded = draftWithRecord(started({ type: "SSS" }), rec);
    expect({ ...loaded, type: fresh.type }).toEqual(fresh);
  });
});

describe("missingAltitude", () => {
  it("counts a blank and an unparseable one, and never a zero", () => {
    expect(missingAltitude("")).toBe(true);
    expect(missingAltitude("   ")).toBe(true);
    expect(missingAltitude("about 400")).toBe(true);
    expect(missingAltitude(0)).toBe(false);
    expect(missingAltitude("0")).toBe(false);
    expect(missingAltitude(-3)).toBe(false);
  });
});
