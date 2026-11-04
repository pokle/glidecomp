import { describe, expect, it } from "vitest";
import type { XCTask } from "@glidecomp/engine";
import { formatRouteDistance, rebaseRouteTimes, suggestCopyName } from "./comp-copy";

describe("suggestCopyName", () => {
  it("moves the year on by one", () => {
    expect(suggestCopyName("Corryong Cup 2026")).toBe("Corryong Cup 2027");
    expect(suggestCopyName("2019 Bright Open")).toBe("2020 Bright Open");
  });

  it("moves only the last year", () => {
    expect(suggestCopyName("2025 Winter Series 2026")).toBe("2025 Winter Series 2027");
  });

  it("leaves numbers that are not years alone", () => {
    expect(suggestCopyName("Route 66 Open")).toBe("Route 66 Open (copy)");
    expect(suggestCopyName("Comp 12026")).toBe("Comp 12026 (copy)");
  });

  it("keeps within the server's 128 characters", () => {
    const long = "x".repeat(128);
    expect(suggestCopyName(long)).toHaveLength(128);
    expect(suggestCopyName(long).endsWith(" (copy)")).toBe(true);
  });
});

describe("rebaseRouteTimes", () => {
  const route: XCTask = {
    taskType: "CLASSIC",
    version: 1,
    turnpoints: [],
    // 12:30 and 13:00 on a January day in Melbourne (AEDT, UTC+11).
    sss: { type: "RACE", direction: "EXIT", timeGates: ["01:30:00Z", "02:00:00Z"] },
    goal: { type: "CYLINDER", deadline: "07:00:00Z" },
    takeoff: { timeOpen: "00:00:00Z", timeClose: "03:00:00Z" },
  };

  it("keeps the local clock time across a daylight-saving change", () => {
    // In May Melbourne is on AEST (UTC+10): 12:30 local is 02:30 UTC.
    const moved = rebaseRouteTimes(route, "2026-01-05", "2026-05-05", "Australia/Melbourne");
    expect(moved.sss?.timeGates).toEqual(["02:30:00Z", "03:00:00Z"]);
    expect(moved.goal?.deadline).toBe("08:00:00Z");
    expect(moved.takeoff).toEqual({ timeOpen: "01:00:00Z", timeClose: "04:00:00Z" });
    // The turnpoints and everything else are untouched.
    expect(moved.turnpoints).toBe(route.turnpoints);
    expect(moved.sss?.type).toBe("RACE");
  });

  it("changes nothing on the same side of daylight saving", () => {
    const moved = rebaseRouteTimes(route, "2026-01-05", "2027-01-08", "Australia/Melbourne");
    expect(moved.sss?.timeGates).toEqual(route.sss?.timeGates);
    expect(moved.goal?.deadline).toBe("07:00:00Z");
  });

  it("returns the route as it was without a zone", () => {
    expect(rebaseRouteTimes(route, "2026-01-05", "2026-05-05", null)).toBe(route);
  });

  it("leaves a time it cannot read exactly as it was", () => {
    const odd: XCTask = { ...route, goal: { type: "LINE", deadline: "sunset" } };
    const moved = rebaseRouteTimes(odd, "2026-01-05", "2026-05-05", "Australia/Melbourne");
    expect(moved.goal?.deadline).toBe("sunset");
  });
});

describe("formatRouteDistance", () => {
  it("rounds to kilometres", () => {
    expect(formatRouteDistance(null)).toBeNull();
    expect(formatRouteDistance(0)).toBe("under 1 km away");
    expect(formatRouteDistance(12_400)).toBe("12 km away");
    expect(formatRouteDistance(1_234_567)).toBe("1,235 km away");
  });
});
