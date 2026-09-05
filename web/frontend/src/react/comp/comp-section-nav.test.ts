import { describe, expect, it } from "vitest";
import {
  buildCompSectionNavModel,
  currentCompSection,
} from "./CompSectionNav";

const BASE = {
  compId: "voqc",
  compName: "Corryong Cup 2026",
  taskCount: 6,
  waypointCount: 42,
  pilotCount: 99,
  scoringFormat: "gap" as const,
  isAdmin: false,
};

describe("currentCompSection", () => {
  it("reads the segment after the competition id", () => {
    expect(currentCompSection("/comp/corryong-cup-2026-voqc", "")).toBe("tasks");
    expect(currentCompSection("/comp/corryong-cup-2026-voqc/scores", "")).toBe(
      "scores"
    );
    expect(
      currentCompSection("/comp/corryong-cup-2026-voqc/waypoints", "")
    ).toBe("waypoints");
    expect(currentCompSection("/comp/corryong-cup-2026-voqc/pilots", "")).toBe(
      "pilots"
    );
    expect(currentCompSection("/comp/corryong-cup-2026-voqc/analysis", "")).toBe(
      "analysis"
    );
  });

  it("treats #activity as current only on the hub", () => {
    expect(
      currentCompSection("/comp/corryong-cup-2026-voqc", "#activity")
    ).toBe("activity");
    expect(
      currentCompSection("/comp/corryong-cup-2026-voqc/scores", "#activity")
    ).toBe("scores");
  });

  it("does not take a task-analysis URL as the comp analysis", () => {
    expect(
      currentCompSection(
        "/comp/corryong-cup-2026-voqc/task/task-3-open-zqfs/analysis",
        ""
      )
    ).toBe("tasks");
  });
});

describe("buildCompSectionNavModel", () => {
  it("keeps Tasks and Activity as in-page jumps on the hub", () => {
    const items = buildCompSectionNavModel({
      ...BASE,
      pathname: "/comp/corryong-cup-2026-voqc",
      hash: "",
    });
    expect(items.map((i) => i.id)).toEqual([
      "tasks",
      "scores",
      "waypoints",
      "analysis",
      "activity",
    ]);
    expect(items.find((i) => i.id === "tasks")).toMatchObject({
      label: "Tasks (6)",
      inPage: true,
      href: undefined,
      isCurrent: true,
    });
    expect(items.find((i) => i.id === "activity")).toMatchObject({
      inPage: true,
      href: undefined,
      isCurrent: false,
    });
    expect(items.find((i) => i.id === "scores")?.href).toBe(
      "/comp/corryong-cup-2026-voqc/scores"
    );
  });

  it("routes Tasks and Activity back to the hub from a sibling page", () => {
    const items = buildCompSectionNavModel({
      ...BASE,
      pathname: "/comp/corryong-cup-2026-voqc/scores",
      hash: "",
    });
    expect(items.find((i) => i.id === "tasks")).toMatchObject({
      inPage: false,
      href: "/comp/corryong-cup-2026-voqc#tasks",
      isCurrent: false,
    });
    expect(items.find((i) => i.id === "scores")?.isCurrent).toBe(true);
    expect(items.find((i) => i.id === "activity")).toMatchObject({
      inPage: false,
      href: "/comp/corryong-cup-2026-voqc#activity",
    });
  });

  it("marks Activity current on the hub when the hash says so", () => {
    const items = buildCompSectionNavModel({
      ...BASE,
      pathname: "/comp/corryong-cup-2026-voqc",
      hash: "#activity",
    });
    expect(items.find((i) => i.id === "tasks")?.isCurrent).toBe(false);
    expect(items.find((i) => i.id === "activity")?.isCurrent).toBe(true);
  });

  it("adds the roster link only for admins", () => {
    const visitor = buildCompSectionNavModel({
      ...BASE,
      pathname: "/comp/corryong-cup-2026-voqc",
      hash: "",
    });
    const admin = buildCompSectionNavModel({
      ...BASE,
      isAdmin: true,
      pathname: "/comp/corryong-cup-2026-voqc/pilots",
      hash: "",
    });
    expect(visitor.some((i) => i.id === "pilots")).toBe(false);
    expect(admin.find((i) => i.id === "pilots")).toMatchObject({
      label: "Pilots (99)",
      href: "/comp/corryong-cup-2026-voqc/pilots",
      isCurrent: true,
    });
  });

  it("hides Comp analysis on an open-distance competition", () => {
    const items = buildCompSectionNavModel({
      ...BASE,
      scoringFormat: "open_distance",
      pathname: "/comp/corryong-cup-2026-voqc",
      hash: "",
    });
    expect(items.map((i) => i.id)).toEqual([
      "tasks",
      "scores",
      "waypoints",
      "activity",
    ]);
  });

  it("omits counts when they are not known yet", () => {
    const items = buildCompSectionNavModel({
      ...BASE,
      taskCount: undefined,
      waypointCount: undefined,
      pilotCount: undefined,
      isAdmin: true,
      pathname: "/comp/corryong-cup-2026-voqc/waypoints",
      hash: "",
    });
    expect(items.find((i) => i.id === "tasks")?.label).toBe("Tasks");
    expect(items.find((i) => i.id === "waypoints")?.label).toBe("Waypoints");
    expect(items.find((i) => i.id === "pilots")?.label).toBe("Pilots");
  });
});
