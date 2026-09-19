/**
 * The one conversion from a competition waypoint to a turnpoint draft.
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
  blankDraft,
  draftFromRecord,
  draftWithRecord,
  missingAltitude,
} from "./turnpoint-draft";

const waypoint = (over: Partial<WaypointFileRecord> = {}): WaypointFileRecord => ({
  code: "BEACH",
  name: "Sea level launch",
  latitude: -36.5,
  longitude: 146.5,
  radius: 0,
  ...over,
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
