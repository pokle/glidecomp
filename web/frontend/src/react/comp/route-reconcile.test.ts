import { describe, expect, it } from "vitest";
import type { WaypointFileRecord } from "@glidecomp/engine";
import { quickTaskApply } from "./quick-task";
import { reconcileRoute, removedByReconcile } from "./route-reconcile";
import type { RouteRow } from "./route-editor";

function wp(
  code: string,
  name = code,
  extra: Partial<WaypointFileRecord> = {}
): WaypointFileRecord {
  return {
    code,
    name,
    latitude: -36.5,
    longitude: 147.8,
    altitude: 0,
    radius: 400,
    ...extra,
  };
}

const WAYPOINTS = [
  wp("ELLIOT", "Mount Elliot"),
  wp("MITTA", "Mitta Mitta"),
  wp("CUDGWA", "Cudgewa"),
  wp("NCORRY", "North Corryong"),
];

function row(name: string, over: Partial<RouteRow> = {}): RouteRow {
  return {
    id: over.id ?? 1,
    name,
    description: "",
    type: "",
    coords: "-36.500000, 147.800000",
    radius: 400,
    altitude: "",
    leg: null,
    dir: null,
    ...over,
  };
}

/** Ids for turnpoints the line adds, continuing past whatever `prev` holds. */
function idFactory(from = 100): () => number {
  let n = from;
  return () => ++n;
}

function apply(text: string, prev: RouteRow[]) {
  return quickTaskApply(text, WAYPOINTS, {
    defaultRadius: 400,
    knownNames: prev.map((r) => r.name),
  });
}

describe("reconcileRoute", () => {
  it("keeps the coordinates and altitude the line can't say", () => {
    // A turnpoint whose position and elevation were set by hand — neither is
    // anything the quick-task grammar can carry.
    const prev = [
      row("ELLIOT", {
        id: 1,
        coords: "-36.123456, 147.123456",
        altitude: 1723,
        description: "Mount Elliot",
      }),
      row("MITTA", { id: 2 }),
    ];
    const next = reconcileRoute(prev, apply("elliot 400m mitta 5k", prev).picks, idFactory());

    expect(next.map((r) => r.name)).toEqual(["ELLIOT", "MITTA"]);
    expect(next[0].coords).toBe("-36.123456, 147.123456");
    expect(next[0].altitude).toBe(1723);
    expect(next[0].description).toBe("Mount Elliot");
    // What the line DID say still lands.
    expect(next[1].radius).toBe(5000);
  });

  it("keeps row ids stable, so the list doesn't re-mount on every apply", () => {
    const prev = [row("ELLIOT", { id: 7 }), row("MITTA", { id: 9 })];
    const next = reconcileRoute(prev, apply("elliot mitta", prev).picks, idFactory());
    expect(next.map((r) => r.id)).toEqual([7, 9]);
  });

  it("reorders by moving the existing turnpoints, not rebuilding them", () => {
    const prev = [
      row("ELLIOT", { id: 1, altitude: 1723 }),
      row("MITTA", { id: 2 }),
      row("CUDGWA", { id: 3 }),
    ];
    const next = reconcileRoute(prev, apply("cudgwa mitta elliot", prev).picks, idFactory());
    expect(next.map((r) => r.id)).toEqual([3, 2, 1]);
    expect(next[2].altitude).toBe(1723);
  });

  it("aligns repeated waypoints in order rather than collapsing them", () => {
    // Two concentric cylinders at ELLIOT — the take-off and the start.
    const prev = [
      row("ELLIOT", { id: 1, radius: 400, altitude: 1723 }),
      row("ELLIOT", { id: 2, radius: 5000, altitude: 1723 }),
      row("MITTA", { id: 3 }),
    ];
    const next = reconcileRoute(prev, apply("ell 400m ell 5k mitta", prev).picks, idFactory());
    expect(next.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(next.map((r) => r.radius)).toEqual([400, 5000, 400]);
  });

  it("adds turnpoints the line names and removes the ones it doesn't", () => {
    const prev = [row("ELLIOT", { id: 1 }), row("MITTA", { id: 2 })];
    const next = reconcileRoute(prev, apply("elliot ncorry", prev).picks, idFactory(100));

    expect(next.map((r) => r.name)).toEqual(["ELLIOT", "NCORRY"]);
    expect(next[0].id).toBe(1);
    expect(next[1].id).toBe(101);
    expect(removedByReconcile(prev, apply("elliot ncorry", prev).picks)).toHaveLength(1);
    expect(removedByReconcile(prev, apply("elliot ncorry", prev).picks)[0].name).toBe("MITTA");
  });

  it("keeps a turnpoint that is no competition waypoint at all", () => {
    // An imported XContest task: its names match nothing in the waypoint set,
    // so a fuzzy match would silently swap them for the nearest guess.
    const prev = [
      row("D01123", { id: 1, coords: "-37.000000, 148.000000", altitude: 900 }),
      row("MITTA", { id: 2 }),
    ];
    const next = reconcileRoute(prev, apply("D01123 400m mitta 5k", prev).picks, idFactory());

    expect(next.map((r) => r.name)).toEqual(["D01123", "MITTA"]);
    expect(next[0].id).toBe(1);
    expect(next[0].coords).toBe("-37.000000, 148.000000");
    expect(next[0].altitude).toBe(900);
  });

  it("counts a name that is neither a waypoint nor a turnpoint as unmatched", () => {
    const prev = [row("ELLIOT", { id: 1 })];
    const result = apply("elliot zzzzzzz", prev);
    expect(result.unmatched).toBe(1);
    expect(result.picks).toHaveLength(1);
  });

  it("leaves a radius the line didn't state alone", () => {
    // The grammar has a default radius, so a bare name PARSES as 400 m. That
    // is the parser filling a gap, not the reader asking for 400 — applying it
    // over a hand-set 3 km cylinder would undo their work silently.
    const prev = [row("ELLIOT", { id: 1, radius: 3000 }), row("MITTA", { id: 2 })];
    const next = reconcileRoute(prev, apply("elliot mitta", prev).picks, idFactory());
    expect(next[0].radius).toBe(3000);
  });

  it("takes a radius the line does state", () => {
    const prev = [row("ELLIOT", { id: 1, radius: 3000 })];
    const next = reconcileRoute(prev, apply("elliot 1k", prev).picks, idFactory());
    expect(next[0].radius).toBe(1000);
  });

  it("reads a leading distance as stated for the whole line", () => {
    // "2k ell mitta" is the line saying two 2 km cylinders.
    const prev = [row("ELLIOT", { id: 1, radius: 3000 }), row("MITTA", { id: 2 })];
    const next = reconcileRoute(prev, apply("2k elliot mitta", prev).picks, idFactory());
    expect(next.map((r) => r.radius)).toEqual([2000, 2000]);
  });

  it("gives a new turnpoint the waypoint's own radius when the line is silent", () => {
    const waypointsWithRadius = [wp("DELTA", "Delta Ridge", { radius: 1500 })];
    const picks = quickTaskApply("delta", waypointsWithRadius, {
      defaultRadius: 400,
    }).picks;
    const next = reconcileRoute([], picks, idFactory(0));
    expect(next[0].radius).toBe(1500);
  });

  it("takes the type the line states", () => {
    const prev = [row("ELLIOT", { id: 1 }), row("MITTA", { id: 2 })];
    const next = reconcileRoute(prev, apply("elliot to mitta goal", prev).picks, idFactory());
    expect(next[0].type).toBe("TAKEOFF");
    expect(next[1].type).toBe("");
  });

  it("builds the whole route from scratch when there is nothing to reconcile", () => {
    const next = reconcileRoute([], apply("elliot 400m mitta 5k", []).picks, idFactory(0));
    expect(next.map((r) => r.name)).toEqual(["ELLIOT", "MITTA"]);
    expect(next.map((r) => r.id)).toEqual([1, 2]);
    expect(next[0].coords).toBe("-36.500000, 147.800000");
  });
});
