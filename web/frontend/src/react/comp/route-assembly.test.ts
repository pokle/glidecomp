import { describe, expect, it } from "vitest";
import { assembleRouteTask, type RouteRow } from "./route-editor";
import { parsePilotClasses } from "./comp-fields";
import { importedRows, type ImportClassifiedRow, type ParsedRow } from "./csv";

const row = (id: number, name: string, coords: string, type: RouteRow["type"] = ""): RouteRow => ({
  id,
  name,
  description: "",
  type,
  coords,
  radius: 400,
  altitude: "",
  leg: null,
  dir: null,
});

const settings = {
  sssType: "RACE" as const,
  direction: "EXIT" as const,
  gates: ["12:30", "12:00", "12:30"],
  goalType: "LINE" as const,
  goalDeadline: "18:00",
};

describe("assembleRouteTask", () => {
  const rows = [row(1, "T", "-28, 153", "TAKEOFF"), row(2, "S", "-28.1, 153.1", "SSS"), row(3, "G", "-28.2, 153.2", "GOAL")];

  it("builds the task: gates de-duplicated and sorted on the comp's clock, then UTC", () => {
    const { task, errors } = assembleRouteTask(rows, settings, { openDistance: false, toUtc: (t) => `U${t}` });
    expect(errors).toEqual([]);
    expect(task!.sss).toEqual({ type: "RACE", direction: "EXIT", timeGates: ["U12:00:00Z", "U12:30:00Z"] });
    expect(task!.goal).toEqual({ type: "LINE", deadline: "U18:00:00Z" });
    expect(task!.turnpoints.map((t) => t.type)).toEqual(["TAKEOFF", "SSS", undefined]);
  });

  it("blocks a bad gate, and keeps the loaded task's own fields", () => {
    const bad = assembleRouteTask(rows, { ...settings, gates: ["25:00"] }, { openDistance: false, toUtc: (t) => t });
    expect(bad.task).toBeNull();
    expect(bad.errors[0]).toMatch(/start gate/);
    const kept = assembleRouteTask(rows, settings, {
      openDistance: false,
      toUtc: (t) => t,
      base: { taskType: "CLASSIC", version: 2, earthModel: "WGS84", turnpoints: [] },
    });
    expect(kept.task!.version).toBe(2);
    expect(kept.task!.earthModel).toBe("WGS84");
  });
});

describe("small shared rules", () => {
  it("reads pilot classes, defaulting to open", () => {
    expect(parsePilotClasses(" Open, SPORT ,open")).toEqual(["open", "sport"]);
    expect(parsePilotClasses("")).toEqual(["open"]);
  });

  it("an import keeps matched pilots' ids and nothing else", () => {
    const parsed = { name: "A" } as ParsedRow;
    const classified: ImportClassifiedRow[] = [
      { parsed, action: "match", matchedId: "p1" },
      { parsed, action: "name" },
    ];
    expect(importedRows(classified).map((r) => r.comp_pilot_id)).toEqual(["p1", undefined]);
  });
});
