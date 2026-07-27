import { describe, expect, it } from "vitest";
import type { XCTask } from "@glidecomp/engine";
import {
  buildTaskStrip,
  compassPoint,
  courseChange,
  REVERSAL_DEG,
} from "./task-strip-layout";

function tp(
  name: string,
  lat: number,
  lon: number,
  radius = 400,
  type?: "TAKEOFF" | "SSS" | "ESS"
) {
  return { type, radius, waypoint: { name, lat, lon } };
}

/** A dog-leg: north up the first leg, then east — a 90° right turn. */
function dogLeg(): XCTask {
  return {
    taskType: "CLASSIC",
    version: 1,
    turnpoints: [
      tp("START", -36.0, 148.0, 400, "TAKEOFF"),
      tp("NORTH", -35.8, 148.0),
      tp("EAST", -35.8, 148.3, 400),
    ],
  };
}

describe("compassPoint", () => {
  it("names the 16 points", () => {
    expect(compassPoint(0)).toBe("N");
    expect(compassPoint(45)).toBe("NE");
    expect(compassPoint(90)).toBe("E");
    expect(compassPoint(180)).toBe("S");
    expect(compassPoint(270)).toBe("W");
    expect(compassPoint(337.5)).toBe("NNW");
  });

  it("wraps past 360 and below 0", () => {
    expect(compassPoint(359)).toBe("N");
    expect(compassPoint(360)).toBe("N");
    expect(compassPoint(-90)).toBe("W");
  });
});

describe("courseChange", () => {
  it("is positive turning right, negative turning left", () => {
    expect(courseChange(0, 90)).toBe(90);
    expect(courseChange(90, 0)).toBe(-90);
  });

  it("takes the short way round the compass", () => {
    // 350° → 10° is a 20° right turn, not a 340° left one.
    expect(courseChange(350, 10)).toBe(20);
    expect(courseChange(10, 350)).toBe(-20);
  });

  it("reports an exact reversal stably as +180", () => {
    // Both signs are arbitrary for a reversal; picking one keeps an
    // out-and-return task from flipping its turn side on a rounding wobble.
    expect(courseChange(0, 180)).toBe(180);
    expect(courseChange(180, 0)).toBe(180);
  });

  it("is zero for no change", () => {
    expect(courseChange(42, 42)).toBe(0);
  });
});

describe("buildTaskStrip", () => {
  it("returns null when there is no course to describe", () => {
    // One turnpoint (an open-distance launch cylinder) has an order of one.
    expect(
      buildTaskStrip({
        taskType: "CLASSIC",
        version: 1,
        turnpoints: [tp("JILJIL", -35.99, 142.92, 5000, "TAKEOFF")],
      })
    ).toBeNull();
    expect(
      buildTaskStrip({ taskType: "CLASSIC", version: 1, turnpoints: [] })
    ).toBeNull();
  });

  it("returns null when a coordinate is missing", () => {
    const task = dogLeg();
    (task.turnpoints[1].waypoint as { lat: number }).lat = NaN;
    expect(buildTaskStrip(task)).toBeNull();
  });

  it("gives one leg per gap, with headings as compass bearings", () => {
    const strip = buildTaskStrip(dogLeg())!;
    expect(strip.stations).toHaveLength(3);
    expect(strip.legs).toHaveLength(2);
    // Roughly due north then due east — "roughly" on purpose: these bearings
    // are taken from the OPTIMISED tag points, not the turnpoint centres, so
    // the cylinder radii shift them a degree or so. That is the whole point of
    // the strip (it describes the route as flown and scored), and a test that
    // demanded exactly 0°/90° would be asserting the wrong geometry.
    expect(Math.abs(strip.legs[0].bearingDeg)).toBeLessThan(2);
    expect(strip.legs[0].compass).toBe("N");
    expect(Math.abs(strip.legs[1].bearingDeg - 90)).toBeLessThan(2);
    expect(strip.legs[1].compass).toBe("E");
  });

  it("never reports a negative heading", () => {
    // Turf's bearing is -180..180; a heading is 0..360.
    const west: XCTask = {
      taskType: "CLASSIC",
      version: 1,
      turnpoints: [tp("A", -36.0, 148.0, 400, "TAKEOFF"), tp("B", -36.0, 147.6)],
    };
    const strip = buildTaskStrip(west)!;
    expect(strip.legs[0].bearingDeg).toBeGreaterThan(180);
    expect(strip.legs[0].bearingDeg).toBeLessThanOrEqual(360);
    expect(strip.legs[0].compass).toBe("W");
  });

  it("measures the turn at the middle turnpoint only", () => {
    const strip = buildTaskStrip(dogLeg())!;
    expect(strip.stations[0].turnDeg).toBeNull();
    expect(strip.stations[2].turnDeg).toBeNull();
    // ~90°, off by a degree because the tag points sit on the cylinder edges.
    expect(Math.abs(strip.stations[1].turnDeg! - 90)).toBeLessThan(3);
    expect(strip.stations[1].turnSide).toBe("right");
    expect(strip.stations[1].isReversal).toBe(false);
  });

  it("calls a doubling-back leg a reversal", () => {
    const outAndReturn: XCTask = {
      taskType: "CLASSIC",
      version: 1,
      turnpoints: [
        tp("HOME", -36.0, 148.0, 400, "TAKEOFF"),
        tp("OUT", -35.7, 148.0),
        tp("HOME", -36.0, 148.0, 400),
      ],
    };
    const turn = buildTaskStrip(outAndReturn)!.stations[1];
    expect(turn.turnDeg).toBeGreaterThanOrEqual(REVERSAL_DEG);
    expect(turn.isReversal).toBe(true);
  });

  it("says straight on rather than inventing a turn side", () => {
    const almostStraight: XCTask = {
      taskType: "CLASSIC",
      version: 1,
      turnpoints: [
        tp("A", -36.0, 148.0, 400, "TAKEOFF"),
        tp("B", -35.8, 148.0),
        tp("C", -35.6, 148.001),
      ],
    };
    const turn = buildTaskStrip(almostStraight)!.stations[1];
    expect(turn.turnDeg).toBeLessThan(8);
    expect(turn.turnSide).toBeNull();
    expect(turn.isReversal).toBe(false);
  });

  it("carries roles, elevations and the optimised total", () => {
    const task = dogLeg();
    task.turnpoints[1].waypoint = {
      ...task.turnpoints[1].waypoint,
      altSmoothed: 1200,
    };
    const strip = buildTaskStrip(task)!;
    expect(strip.stations.map((s) => s.role)).toEqual(["TAKEOFF", null, "GOAL"]);
    expect(strip.stations[1].elevationM).toBe(1200);
    expect(strip.stations[0].elevationM).toBeNull();
    expect(strip.totalMeters).toBeCloseTo(
      strip.legs.reduce((sum, l) => sum + l.meters, 0),
      6
    );
  });
});
