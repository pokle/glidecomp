import { describe, expect, it } from "bun:test";
import { XCTSK_QR_MAX_BYTES, type WaypointFileRecord, type XCTask } from "@glidecomp/engine";
import { formatsFor, instrumentFile, instrumentQr, TASK_FORMATS, WAYPOINT_FORMATS, type InstrumentSource } from "./instrument";

const task: XCTask = {
  taskType: "CLASSIC",
  version: 1,
  turnpoints: [
    { type: "TAKEOFF", radius: 400, waypoint: { name: "CANUN", description: "Canungra Launch", lat: -28.0, lon: 153.1, altSmoothed: 620 } },
    { type: "SSS", radius: 5000, waypoint: { name: "BEECH", description: "Beechmont", lat: -28.1, lon: 153.2, altSmoothed: 430 } },
    { radius: 400, waypoint: { name: "BEACH", description: "On the beach", lat: -28.2, lon: 153.4, altSmoothed: 0 } },
  ],
};
const taskSource: InstrumentSource = { kind: "task", name: "Task 3 — Canungra", task };

const records: WaypointFileRecord[] = [
  { code: "CANUN", name: "Canungra Launch", latitude: -28.0, longitude: 153.1, altitude: 620, radius: 400 },
  { code: "SEA", name: "Sea level", latitude: -28.2, longitude: 153.4, altitude: 0, radius: 400 },
  { code: "UNK", name: "Unknown altitude", latitude: -28.3, longitude: 153.5, radius: 400 },
];
const setSource: InstrumentSource = { kind: "waypoints", name: "Canungra Classic", records };

describe("instrumentFile", () => {
  it("names files as the competition worker does", () => {
    expect(instrumentFile(taskSource, "xctsk")?.filename).toBe("task-3-canungra.xctsk");
    expect(instrumentFile(taskSource, "gpx")?.filename).toBe("task-3-canungra-turnpoints.gpx");
    expect(instrumentFile(setSource, "seeyou-cup")?.filename).toBe("canungra-classic-waypoints.cup");
  });

  it("writes the task file XCTrack imports", () => {
    const file = instrumentFile(taskSource, "xctsk")!;
    const json = JSON.parse(file.text);
    expect(json.taskType).toBe("CLASSIC");
    expect(json.turnpoints).toHaveLength(3);
    expect(file.mimeType).toBe("application/xctsk");
  });

  it("offers no task file for a waypoint set, and nothing for an unknown format", () => {
    expect(instrumentFile(setSource, "xctsk")).toBeNull();
    expect(instrumentFile(setSource, "nonsense")).toBeNull();
    expect(formatsFor(setSource)).toEqual(WAYPOINT_FORMATS);
    expect(formatsFor(taskSource)).toEqual(TASK_FORMATS);
    expect(TASK_FORMATS[0].id).toBe("xctsk");
  });

  it("states OziExplorer altitudes in feet, with -777 for an unknown one", () => {
    const lines = instrumentFile(setSource, "ozi")!.text.split(/\r?\n/).slice(4);
    const altitudeField = (line: string) => line.split(",")[14];
    expect(Number(altitudeField(lines[0]))).toBeCloseTo(620 * 3.28084, 0);
    expect(altitudeField(lines[1])).toBe("0");
    expect(altitudeField(lines[2])).toBe("-777");
  });

  it("swaps code and name in the waypoint formats only", () => {
    const swapped = instrumentFile(setSource, "csv", { swap: true })!.text;
    const plain = instrumentFile(setSource, "csv")!.text;
    expect(swapped).not.toBe(plain);
    expect(instrumentFile(taskSource, "xctsk", { swap: true })!.text).toBe(instrumentFile(taskSource, "xctsk")!.text);
  });
});

describe("instrumentQr", () => {
  it("encodes the XCTSK: payload with a count for the caption", () => {
    const qr = instrumentQr(taskSource);
    expect(qr.value?.startsWith("XCTSK:")).toBe(true);
    expect(qr.count).toBe(3);
  });

  it("says when a set is too big for one code", () => {
    const many: WaypointFileRecord[] = Array.from({ length: 400 }, (_, i) => ({
      code: `WP${i}`,
      name: `Waypoint number ${i}`,
      latitude: -28 - i / 1000,
      longitude: 153 + i / 1000,
      altitude: 100 + i,
      radius: 400,
    }));
    const qr = instrumentQr({ kind: "waypoints", name: "Big", records: many });
    expect(qr.value).toBeNull();
    expect(qr.count).toBe(400);
    expect(instrumentQr(setSource).value!.length).toBeLessThan(XCTSK_QR_MAX_BYTES);
  });

  it("has nothing to encode for an empty set", () => {
    expect(instrumentQr({ kind: "waypoints", name: "Empty", records: [] })).toEqual({ value: null, count: 0 });
  });
});
