import { describe, expect, it } from "vitest";
import type { XCTask } from "@glidecomp/engine";
import {
  buildTaskDiagram,
  describeTaskRoute,
  gateTickPlacement,
  placeArrows,
  type TaskDiagramOptions,
} from "./task-diagram-layout";

const BOX: TaskDiagramOptions = {
  width: 340,
  height: 240,
  padding: 26,
  labelFontSize: 10,
  labelMaxChars: 12,
  arrowMinLength: 22,
  dotRadius: 2.8,
};

function tp(
  name: string,
  lat: number,
  lon: number,
  radius = 400,
  type?: "TAKEOFF" | "SSS" | "ESS"
) {
  return { type, radius, waypoint: { name, lat, lon } };
}

/** A four-turnpoint race, roughly the Corryong shape: launch, start, turn, goal. */
function raceTask(): XCTask {
  return {
    taskType: "CLASSIC",
    version: 1,
    turnpoints: [
      tp("LAUNCH", -36.2, 147.9, 400, "TAKEOFF"),
      tp("STARTC", -36.25, 147.95, 5000, "SSS"),
      tp("MIDWAY", -36.5, 148.3, 2000),
      tp("ESSRNG", -36.7, 148.5, 3000, "ESS"),
      tp("GOALPT", -36.72, 148.52, 400),
    ],
    sss: { type: "RACE", direction: "EXIT" },
    goal: { type: "CYLINDER" },
  };
}

describe("buildTaskDiagram", () => {
  it("returns null for a task with no turnpoints", () => {
    expect(
      buildTaskDiagram({ taskType: "CLASSIC", version: 1, turnpoints: [] }, BOX)
    ).toBeNull();
  });

  it("returns null when a coordinate is missing", () => {
    const task = raceTask();
    // A route being edited can carry a turnpoint with no coordinates yet.
    (task.turnpoints[2].waypoint as { lat: number }).lat = NaN;
    expect(buildTaskDiagram(task, BOX)).toBeNull();
  });

  it("lays out one point per turnpoint, inside the box", () => {
    const layout = buildTaskDiagram(raceTask(), BOX)!;
    expect(layout.path).toHaveLength(5);
    expect(layout.turnpoints).toHaveLength(5);
    for (const point of layout.path) {
      expect(point.x).toBeGreaterThanOrEqual(BOX.padding - 0.01);
      expect(point.x).toBeLessThanOrEqual(BOX.width - BOX.padding + 0.01);
      expect(point.y).toBeGreaterThanOrEqual(BOX.padding - 0.01);
      expect(point.y).toBeLessThanOrEqual(BOX.height - BOX.padding + 0.01);
    }
  });

  it("keeps north up and east right", () => {
    const layout = buildTaskDiagram(raceTask(), BOX)!;
    const launch = layout.path[0];
    const goal = layout.path[4];
    // The goal is south and east of launch.
    expect(goal.y).toBeGreaterThan(launch.y);
    expect(goal.x).toBeGreaterThan(launch.x);
  });

  it("is deterministic — the same task lays out identically twice", () => {
    // SSR renders this markup and the client must hydrate onto it unchanged.
    expect(buildTaskDiagram(raceTask(), BOX)).toEqual(
      buildTaskDiagram(raceTask(), BOX)
    );
  });

  it("marks the start, ESS and goal turnpoints", () => {
    const layout = buildTaskDiagram(raceTask(), BOX)!;
    expect(layout.turnpoints.map((t) => t.role)).toEqual([
      "TAKEOFF",
      "SSS",
      null,
      "ESS",
      "GOAL",
    ]);
    expect(layout.turnpoints[1].isStart).toBe(true);
    expect(layout.turnpoints[3].isEss).toBe(true);
    expect(layout.turnpoints[4].isGoal).toBe(true);
    expect(layout.turnpoints[0].isGoal).toBe(false);
  });

  it("draws cylinders only in the legible band", () => {
    const layout = buildTaskDiagram(raceTask(), BOX)!;
    // 400 m turnpoints on a ~60 km task are sub-pixel: not drawn. The 5 km
    // start and 3 km ESS rings are worth seeing.
    expect(layout.turnpoints[0].showCylinder).toBe(false);
    expect(layout.turnpoints[4].showCylinder).toBe(false);
    expect(layout.turnpoints[1].showCylinder).toBe(true);
    expect(layout.turnpoints[3].showCylinder).toBe(true);
  });

  it("drops a cylinder that would swamp the box", () => {
    const task = raceTask();
    task.turnpoints[2].radius = 200_000; // 200 km — wider than the whole task
    const layout = buildTaskDiagram(task, BOX)!;
    expect(layout.turnpoints[2].showCylinder).toBe(false);
  });

  it("shows a single-turnpoint open-distance task as its launch cylinder", () => {
    const task: XCTask = {
      taskType: "CLASSIC",
      version: 1,
      turnpoints: [tp("JILJIL", -35.99, 142.92, 5000, "TAKEOFF")],
    };
    const layout = buildTaskDiagram(task, BOX)!;
    expect(layout.path).toHaveLength(1);
    expect(layout.arrows).toHaveLength(0);
    expect(layout.turnpoints[0].showCylinder).toBe(true);
    expect(layout.turnpoints[0].radius).toBeGreaterThan(1);
    expect(Number.isFinite(layout.metresPerUnit)).toBe(true);
  });

  it("resolves a LINE goal into drawable endpoints", () => {
    const task = raceTask();
    task.goal = { type: "LINE" };
    const layout = buildTaskDiagram(task, BOX)!;
    expect(layout.goalLine).not.toBeNull();
    const [a, b] = layout.goalLine!;
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeGreaterThan(0);
  });

  it("labels every turnpoint, truncated to the box's budget", () => {
    const task = raceTask();
    task.turnpoints[2].waypoint.name = "A VERY LONG WAYPOINT NAME";
    const layout = buildTaskDiagram(task, BOX)!;
    expect(layout.labels).toHaveLength(5);
    expect(layout.labels[2].text).toBe("A VERY LONG…");
    for (const label of layout.labels) {
      expect(label.x).toBeGreaterThanOrEqual(0);
      expect(label.x).toBeLessThanOrEqual(BOX.width);
      expect(label.y).toBeGreaterThanOrEqual(0);
      expect(label.y).toBeLessThanOrEqual(BOX.height);
    }
  });

  it("places no labels when the caller asks for none", () => {
    const layout = buildTaskDiagram(raceTask(), { ...BOX, labelFontSize: 0 })!;
    expect(layout.labels).toEqual([]);
  });

  it("separates labels that would otherwise overlap", () => {
    // ESS and goal are nearly concentric — the classic collision.
    const layout = buildTaskDiagram(raceTask(), BOX)!;
    const ess = layout.labels[3];
    const goal = layout.labels[4];
    expect(Math.abs(ess.y - goal.y)).toBeGreaterThanOrEqual(10);
  });

  it("fans labels around a fully concentric task", () => {
    // Every turnpoint on one summit (the exit-ring out-and-return shape):
    // there is no outward direction, so labels must not all stack up.
    const task: XCTask = {
      taskType: "CLASSIC",
      version: 1,
      turnpoints: [
        tp("KOSCI", -36.4558, 148.2635, 400, "TAKEOFF"),
        tp("KOSCI", -36.4558, 148.2635, 1000, "SSS"),
        tp("RING", -36.4558, 148.2635, 10000),
        tp("KOSCI", -36.4558, 148.2635, 400),
      ],
      sss: { type: "RACE", direction: "EXIT" },
    };
    const layout = buildTaskDiagram(task, BOX)!;
    const positions = new Set(layout.labels.map((l) => `${l.x},${l.y}`));
    expect(positions.size).toBe(4);
  });
});

describe("placeArrows", () => {
  it("puts an arrow at the midpoint of each long-enough leg", () => {
    const arrows = placeArrows(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
      ],
      20
    );
    expect(arrows).toHaveLength(2);
    expect(arrows[0]).toMatchObject({ x: 50, y: 0, angle: 0 });
    expect(arrows[1].angle).toBeCloseTo(Math.PI / 2);
  });

  it("still marks direction when every leg is short", () => {
    const arrows = placeArrows(
      [
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 5, y: 9 },
      ],
      20
    );
    expect(arrows).toHaveLength(1);
    expect(arrows[0].angle).toBeCloseTo(Math.PI / 2);
  });

  it("has nothing to point at with fewer than two points", () => {
    expect(placeArrows([{ x: 1, y: 1 }], 10)).toEqual([]);
  });
});

describe("gateTickPlacement", () => {
  const goal = { x: 100, y: 0 };

  it("sets the gate back from the turnpoint, not through it", () => {
    // The whole point: an ESS that is also the goal must not get a tick
    // struck across its ring, which reads as a "prohibited" symbol.
    const at = gateTickPlacement(goal, { x: 0, y: 0 }, 15)!;
    expect(at.x).toBe(85);
    expect(at.y).toBe(0);
    // Perpendicular to a due-east leg.
    expect(at.angle).toBeCloseTo(Math.PI / 2);
  });

  it("caps the setback at 40% of a short leg", () => {
    // A near-concentric ESS/goal: honouring the full offset would put the
    // gate back past the previous turnpoint.
    const at = gateTickPlacement({ x: 20, y: 0 }, { x: 0, y: 0 }, 15)!;
    expect(at.x).toBe(12); // 20 − min(15, 8)
  });

  it("stays on the leg whatever its direction", () => {
    const at = gateTickPlacement({ x: 0, y: 100 }, { x: 0, y: 0 }, 15)!;
    expect(at).toMatchObject({ x: 0, y: 85 });
    expect(at.angle).toBeCloseTo(Math.PI);
  });

  it("draws nothing for a zero-length leg", () => {
    expect(gateTickPlacement(goal, { ...goal }, 15)).toBeNull();
  });
});

describe("describeTaskRoute", () => {
  it("reads the route out in order with roles", () => {
    expect(describeTaskRoute(raceTask())).toBe(
      "Task route: LAUNCH (TAKEOFF), then STARTC (SSS), then MIDWAY, then ESSRNG (ESS), then GOALPT (GOAL)"
    );
  });

  it("says so when there is no route", () => {
    expect(
      describeTaskRoute({ taskType: "CLASSIC", version: 1, turnpoints: [] })
    ).toBe("Task route: no turnpoints set");
  });
});
