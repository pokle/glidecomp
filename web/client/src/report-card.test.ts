import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { getOptimizedSegmentDistances, type XCTask } from "@glidecomp/engine";
import { assertAnalysisMatchesScore, expectedScoredDistance } from "./report-card";

// Launch ~20 km from the start cylinder, goal ~30 km beyond it.
const task: XCTask = {
  taskType: "CLASSIC",
  version: 1,
  turnpoints: [
    { type: "TAKEOFF", radius: 400, waypoint: { name: "Launch", lat: -36.0, lon: 147.0 } },
    { type: "SSS", radius: 2000, waypoint: { name: "Start", lat: -36.2, lon: 147.0 } },
    { type: "ESS", radius: 400, waypoint: { name: "Goal", lat: -36.5, lon: 147.0 } },
  ],
};
const launchToSss = getOptimizedSegmentDistances(task)[0];
const MIN = 5000;

/** The check as the report card runs it: expectation in, published distance out. */
function check(
  flown: number,
  outcome: Parameters<typeof expectedScoredDistance>[1],
  published: number,
  t: XCTask = task,
) {
  assertAnalysisMatchesScore(expectedScoredDistance(flown, outcome, t, MIN), published);
}

describe("the report card's score/analysis check (issue #742)", () => {
  let errors: ReturnType<typeof spyOn>;
  beforeEach(() => {
    errors = spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => errors.mockRestore());

  it("expects the flown distance, floored at the minimum, for a normal start", () => {
    expect(expectedScoredDistance(42_000, undefined, task, MIN)).toBe(42_000);
    expect(expectedScoredDistance(1_200, null, task, MIN)).toBe(MIN);
    expect(expectedScoredDistance(42_000, "hg_penalty", task, MIN)).toBe(42_000);
  });

  it("does not trip for an HG start beyond the jump-the-gun limit (minimum distance)", () => {
    check(68_404.73637533985, "hg_min_distance", 5000);
    expect(errors).not.toHaveBeenCalled();
  });

  it("does not trip for a PG early start (the fixed launch→SSS leg)", () => {
    expect(launchToSss).toBeGreaterThan(MIN);
    check(68_404, "pg_launch_to_sss", launchToSss);
    // Landed short of their own start: still awarded the whole leg.
    check(launchToSss / 2, "pg_launch_to_sss", launchToSss);
    expect(errors).not.toHaveBeenCalled();
  });

  it("floors a PG launch→SSS leg shorter than the minimum (distanceOrigin start)", () => {
    const fromStart: XCTask = { ...task, turnpoints: task.turnpoints.slice(1) };
    expect(expectedScoredDistance(30_000, "pg_launch_to_sss", fromStart, MIN)).toBe(MIN);
    check(30_000, "pg_launch_to_sss", MIN, fromStart);
    expect(errors).not.toHaveBeenCalled();
  });

  it("still trips on a genuine mismatch", () => {
    check(68_404, undefined, 5000);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0][0])).toContain("Score/analysis mismatch");
  });

  it("still trips when a neutralised start was published with the wrong distance", () => {
    check(68_404, "hg_min_distance", 68_404);
    check(68_404, "pg_launch_to_sss", 68_404);
    expect(errors).toHaveBeenCalledTimes(2);
  });
});
