import { describe, expect, it } from "vitest";
import type { Turnpoint } from "@glidecomp/engine";
import {
  addMinutes,
  buildRoute,
  editableGates,
  formatCoords,
  gateToHHMM,
  parseCoords,
  startConfigSummary,
  turnpointsToCSV,
  turnpointToRow,
  xctskForPatch,
  type RouteRow,
} from "./route-editor";

function row(overrides: Partial<RouteRow> = {}): RouteRow {
  return {
    id: overrides.id ?? 1,
    name: "Mt Emu",
    description: "",
    type: "",
    coords: "-36.550979, 147.890395",
    radius: 400,
    altitude: "",
    leg: null,
    ...overrides,
  };
}

describe("parseCoords", () => {
  it("parses Google Maps format", () => {
    expect(parseCoords("-38.232923, 144.399782")).toEqual({
      lat: -38.232923,
      lon: 144.399782,
    });
  });

  it("accepts whitespace-only separation and extra spaces", () => {
    expect(parseCoords("  -38.2   144.4 ")).toEqual({ lat: -38.2, lon: 144.4 });
    expect(parseCoords("-38.2,144.4")).toEqual({ lat: -38.2, lon: 144.4 });
  });

  it("rejects out-of-range, non-numeric, and wrong-arity input", () => {
    expect(parseCoords("91, 0")).toBeNull();
    expect(parseCoords("0, 181")).toBeNull();
    expect(parseCoords("-38.2")).toBeNull();
    expect(parseCoords("-38.2, 144.4, 12")).toBeNull();
    expect(parseCoords("abc, def")).toBeNull();
    expect(parseCoords("36°33'S, 147°53'E")).toBeNull();
    expect(parseCoords("")).toBeNull();
  });

  it("round-trips through formatCoords", () => {
    expect(parseCoords(formatCoords(-36.550979, 147.890395))).toEqual({
      lat: -36.550979,
      lon: 147.890395,
    });
  });
});

describe("turnpointToRow", () => {
  it("converts a turnpoint to an editable row", () => {
    const tp: Turnpoint = {
      type: "SSS",
      radius: 2000,
      waypoint: { name: "STRT", description: "Start Hill", lat: -36.5, lon: 147.9, altSmoothed: 680 },
    };
    expect(turnpointToRow(tp, 7)).toEqual({
      id: 7,
      name: "STRT",
      description: "Start Hill",
      type: "SSS",
      coords: "-36.500000, 147.900000",
      radius: 2000,
      altitude: 680,
      leg: null,
    });
  });
});

describe("buildRoute", () => {
  it("builds turnpoints and reports complete geometry", () => {
    const result = buildRoute(
      [
        row({ id: 1, name: "Launch", type: "TAKEOFF" }),
        row({ id: 2, name: "Start", type: "SSS", coords: "-36.6, 147.8", radius: 2000 }),
        row({ id: 3, name: "TP1", type: "", coords: "-36.65, 147.75" }),
        row({ id: 4, name: "Goal", type: "ESS", coords: "-36.7, 147.7", altitude: 300 }),
      ],
      { openDistance: false }
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.geometryComplete).toBe(true);
    expect(result.rowIds).toEqual([1, 2, 3, 4]);
    expect(result.turnpoints).toHaveLength(4);
    expect(result.turnpoints[0].type).toBe("TAKEOFF");
    expect(result.turnpoints[1]).toMatchObject({ type: "SSS", radius: 2000 });
    expect(result.turnpoints[3].waypoint.altSmoothed).toBe(300);
    // Plain turnpoints must not carry a type key at all (strict server schema)
    expect("type" in result.turnpoints[2]).toBe(false);
  });

  it("keeps the long name as the waypoint description, separate from the code", () => {
    const result = buildRoute(
      [row({ id: 1, name: "A01", description: "Bordano Landing" })],
      { openDistance: false }
    );
    expect(result.turnpoints[0].waypoint.name).toBe("A01");
    expect(result.turnpoints[0].waypoint.description).toBe("Bordano Landing");
  });

  it("omits the description when it only repeats the code", () => {
    const result = buildRoute([row({ id: 1, name: "CURY", description: "CURY" })], {
      openDistance: false,
    });
    expect("description" in result.turnpoints[0].waypoint).toBe(false);
  });

  it("skips entirely blank rows (a stray inserted row can't block a save)", () => {
    const result = buildRoute(
      [row({ id: 1 }), { id: 2, name: "", description: "", type: "", coords: "", radius: 400, altitude: "", leg: null }],
      { openDistance: false }
    );
    expect(result.errors).toEqual([]);
    expect(result.turnpoints).toHaveLength(1);
  });

  it("flags invalid coordinates, radius and altitude with the row number", () => {
    const result = buildRoute(
      [
        row({ id: 1, coords: "not coords" }),
        row({ id: 2, name: "B", radius: 0 }),
        row({ id: 3, name: "C", radius: 400.5 }),
        row({ id: 4, name: "D", altitude: 99999 }),
      ],
      { openDistance: false }
    );
    expect(result.errors.some((e) => e.startsWith("Turnpoint 1") && /coordinates/.test(e))).toBe(true);
    expect(result.errors.some((e) => e.startsWith("Turnpoint 2") && /radius/.test(e))).toBe(true);
    expect(result.errors.some((e) => e.startsWith("Turnpoint 3") && /radius/.test(e))).toBe(true);
    expect(result.errors.some((e) => e.startsWith("Turnpoint 4") && /altitude/.test(e))).toBe(true);
    expect(result.geometryComplete).toBe(false);
  });

  it("requires a name and at least one turnpoint", () => {
    expect(
      buildRoute([row({ name: "" })], { openDistance: false }).errors.some((e) =>
        /name is required/.test(e)
      )
    ).toBe(true);
    expect(buildRoute([], { openDistance: false }).errors).toContain(
      "The route needs at least one turnpoint"
    );
  });

  it("warns about missing SSS/ESS on multi-turnpoint GAP tasks", () => {
    const result = buildRoute(
      [row({ id: 1 }), row({ id: 2, name: "B", coords: "-36.6, 147.8" })],
      { openDistance: false }
    );
    expect(result.warnings.some((w) => /No Start \(SSS\) turnpoint/.test(w))).toBe(true);
    expect(result.warnings.some((w) => /No ESS turnpoint/.test(w))).toBe(true);
    // Single-turnpoint tasks don't warn (nothing to start/end yet)
    expect(buildRoute([row()], { openDistance: false }).warnings).toEqual([]);
  });

  it("warns when SSS comes after ESS or types are duplicated", () => {
    const result = buildRoute(
      [
        row({ id: 1, type: "ESS" }),
        row({ id: 2, name: "B", type: "SSS", coords: "-36.6, 147.8" }),
        row({ id: 3, name: "C", type: "SSS", coords: "-36.7, 147.7" }),
      ],
      { openDistance: false }
    );
    expect(result.warnings.some((w) => /comes after the ESS/.test(w))).toBe(true);
    expect(result.warnings.some((w) => /Multiple Start \(SSS\)/.test(w))).toBe(true);
  });

  it("enforces the open-distance single-Takeoff rule", () => {
    const bad = buildRoute([row({ type: "" })], { openDistance: true });
    expect(bad.errors.some((e) => /exactly one turnpoint, of type Takeoff/.test(e))).toBe(true);
    const good = buildRoute([row({ type: "TAKEOFF" })], { openDistance: true });
    expect(good.errors).toEqual([]);
    const twoTps = buildRoute(
      [row({ id: 1, type: "TAKEOFF" }), row({ id: 2, name: "B", coords: "-36.6, 147.8" })],
      { openDistance: true }
    );
    expect(twoTps.errors.some((e) => /exactly one turnpoint/.test(e))).toBe(true);
  });

  it("tolerates string editor output for radius and altitude", () => {
    const result = buildRoute(
      [row({ radius: "1500", altitude: "700" })],
      { openDistance: false }
    );
    expect(result.errors).toEqual([]);
    expect(result.turnpoints[0].radius).toBe(1500);
    expect(result.turnpoints[0].waypoint.altSmoothed).toBe(700);
  });
});

describe("gate helpers", () => {
  it("gateToHHMM normalises xctsk gate formats", () => {
    expect(gateToHHMM("13:30:00Z")).toBe("13:30");
    expect(gateToHHMM("3:05")).toBe("03:05");
    expect(gateToHHMM("noon")).toBeNull();
  });

  it("editableGates drops the lone 00:00 placeholder", () => {
    expect(editableGates({ type: "RACE", direction: "EXIT", timeGates: ["00:00:00Z"] })).toEqual([]);
    expect(
      editableGates({ type: "RACE", direction: "EXIT", timeGates: ["13:00:00Z", "13:15:00Z"] })
    ).toEqual(["13:00", "13:15"]);
  });

  it("addMinutes wraps at midnight", () => {
    expect(addMinutes("13:45", 15)).toBe("14:00");
    expect(addMinutes("23:50", 20)).toBe("00:10");
  });

  it("startConfigSummary describes race starts with gates", () => {
    expect(
      startConfigSummary({ type: "RACE", direction: "EXIT", timeGates: ["13:00:00Z"] })
    ).toBe("Race to goal · exit start · 1 start gate: 13:00 UTC");
  });

  it("startConfigSummary shows comp-local gates when the comp zone is known", () => {
    const summary = startConfigSummary(
      // 01:30 / 02:00 UTC on 2026-02-07 = 12:30 / 13:00 AEDT
      { type: "RACE", direction: "EXIT", timeGates: ["01:30:00Z", "02:00:00Z"] },
      { timeZone: "Australia/Melbourne", taskDate: "2026-02-07" }
    );
    expect(summary).toContain(
      "2 start gates: 12:30, 13:00 Australia/Melbourne (GMT+11)"
    );
    expect(summary).not.toContain("UTC");
  });

  it("startConfigSummary stays UTC when no comp zone is set", () => {
    expect(
      startConfigSummary(
        { type: "RACE", direction: "EXIT", timeGates: ["13:00:00Z"] },
        { timeZone: null, taskDate: "2026-02-07" }
      )
    ).toBe("Race to goal · exit start · 1 start gate: 13:00 UTC");
  });
});

describe("xctskForPatch", () => {
  it("keeps only schema-known fields and drops empty optionals", () => {
    const patched = xctskForPatch({
      taskType: "CLASSIC",
      version: 1,
      turnpoints: [
        { radius: 400, waypoint: { name: "A", lat: -36.5, lon: 147.9 } },
      ],
      sss: { type: "RACE", direction: "EXIT", timeGates: [] },
      goal: { type: "LINE", deadline: "23:00:00Z" },
    });
    expect(patched).toEqual({
      taskType: "CLASSIC",
      version: 1,
      turnpoints: [{ radius: 400, waypoint: { name: "A", lat: -36.5, lon: 147.9 } }],
      sss: { type: "RACE", direction: "EXIT" },
      goal: { type: "LINE", deadline: "23:00:00Z" },
    });
  });
});

describe("turnpointsToCSV", () => {
  const tps: Turnpoint[] = [
    { type: "TAKEOFF", radius: 400, waypoint: { name: "CORRY", lat: -36.185, lon: 147.8914, altSmoothed: 955 } },
    { radius: 5000, waypoint: { name: "ELLIOT", lat: -36.185833, lon: 147.976667 } },
  ];

  it("writes the competition waypoint CSV header + rows", () => {
    const csv = turnpointsToCSV(tps).trim().split("\n");
    expect(csv[0]).toBe("Name,Latitude,Longitude,Description,Proximity Distance,Altitude");
    expect(csv[1]).toBe("CORRY,-36.185000,147.891400,,400,955");
    expect(csv[2]).toBe("ELLIOT,-36.185833,147.976667,,5000,0");
  });

  it("round-trips back through parseWaypointsCSV to the same coordinates", async () => {
    const { parseWaypointsCSV } = await import("@glidecomp/engine");
    const parsed = parseWaypointsCSV(turnpointsToCSV(tps));
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ name: "CORRY", latitude: -36.185, longitude: 147.8914, radius: 400, altitude: 955 });
  });

  it("quotes names containing a comma", () => {
    const csv = turnpointsToCSV([
      { radius: 400, waypoint: { name: "Hill, North", lat: -36, lon: 147 } },
    ]);
    expect(csv).toContain('"Hill, North",-36.000000,147.000000,,400,0');
  });
});
