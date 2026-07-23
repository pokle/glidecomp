import { describe, expect, it } from "vitest";
import { deriveSetupSteps } from "./CompSetupProgress";
import type { CompDetailData, TaskSummary } from "./types";

function comp(overrides: Partial<CompDetailData> = {}): CompDetailData {
  return {
    comp_id: "abc",
    name: "Fresh Comp",
    category: "hg",
    creation_date: "2026-07-12T00:00:00Z",
    close_date: null,
    test: false,
    pilot_classes: ["open"],
    default_pilot_class: "open",
    gap_params: null,
    scoring_format: "gap",
    series_scoring: "total",
    ftv_factor: null,
    timezone: null,
    open_igc_upload: true,
    tasks: [],
    admins: [{ email: "a@b.c", name: "Admin" }],
    pilot_count: 0,
    waypoint_count: 0,
    settings_reviewed: false,
    class_coverage_warnings: [],
    ...overrides,
  };
}

function task(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    task_id: "t1",
    name: "Task 1",
    task_date: "2026-07-13",
    has_xctsk: false,
    pilot_classes: ["open"],
    missing_sss: false,
    missing_ess: false,
    line_goal: false,
    ...overrides,
  };
}

describe("deriveSetupSteps", () => {
  it("a fresh comp is 1 of 5 (create pre-checked)", () => {
    const steps = deriveSetupSteps(comp());
    expect(steps).toHaveLength(5);
    expect(steps.map((s) => s.complete)).toEqual([true, false, false, false, false]);
    expect(steps[0].label).toBe("Create the competition");
  });

  it("each signal flips its step independently (steps can complete out of order)", () => {
    expect(
      deriveSetupSteps(comp({ settings_reviewed: true })).find((s) => s.key === "settings")
        ?.complete
    ).toBe(true);
    expect(
      deriveSetupSteps(comp({ waypoint_count: 3 })).find((s) => s.key === "waypoints")
        ?.complete
    ).toBe(true);
    expect(
      deriveSetupSteps(comp({ pilot_count: 12 })).find((s) => s.key === "pilots")?.complete
    ).toBe(true);
    // Flipping one signal leaves the others untouched.
    const steps = deriveSetupSteps(comp({ pilot_count: 12 }));
    expect(steps.find((s) => s.key === "settings")?.complete).toBe(false);
    expect(steps.find((s) => s.key === "waypoints")?.complete).toBe(false);
  });

  it("a task without a route keeps step 5 active with the set-the-route variant", () => {
    const steps = deriveSetupSteps(
      comp({ tasks: [task({ task_id: "t9", name: "Day 1" })] })
    );
    const taskStep = steps.find((s) => s.key === "task")!;
    expect(taskStep.complete).toBe(false);
    expect(taskStep.label).toBe("Set the route for Day 1");
    expect(taskStep.routeTaskId).toBe("t9");
  });

  it("a task with a route completes step 5, even beside route-less tasks", () => {
    const steps = deriveSetupSteps(
      comp({ tasks: [task({ has_xctsk: true }), task({ task_id: "t2" })] })
    );
    const taskStep = steps.find((s) => s.key === "task")!;
    expect(taskStep.complete).toBe(true);
    expect(taskStep.routeTaskId).toBeUndefined();
  });

  it("the settings step is optional (doesn't gate completion)", () => {
    const settings = deriveSetupSteps(comp()).find((s) => s.key === "settings")!;
    expect(settings.optional).toBe(true);
  });

  it("all required steps can complete without reviewing settings", () => {
    const steps = deriveSetupSteps(
      comp({
        settings_reviewed: false,
        waypoint_count: 1,
        pilot_count: 1,
        tasks: [task({ has_xctsk: true })],
      })
    );
    const required = steps.filter((s) => !s.optional);
    expect(required.every((s) => s.complete)).toBe(true);
    // The optional settings step remains incomplete but doesn't block.
    expect(steps.find((s) => s.key === "settings")?.complete).toBe(false);
  });

  it("all signals set → every step complete (guide hides)", () => {
    const steps = deriveSetupSteps(
      comp({
        settings_reviewed: true,
        waypoint_count: 1,
        pilot_count: 1,
        tasks: [task({ has_xctsk: true })],
      })
    );
    expect(steps.every((s) => s.complete)).toBe(true);
  });
});
