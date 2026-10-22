import { describe, expect, it } from "bun:test";
import { ACTIVITY_FILTERS, activityQuery, groupActivityByDay } from "./audit";
import type { AuditEntry } from "./types";

const entry = (audit_id: number, timestamp: string): AuditEntry => ({
  audit_id,
  timestamp,
  actor_name: "Organiser",
  subject_type: "task",
  subject_id: null,
  subject_name: null,
  description: `Change ${audit_id}`,
});

describe("activityQuery", () => {
  it("asks for one page, filtered and older than the cursor", () => {
    expect(activityQuery("", null)).toEqual({ limit: "25" });
    expect(activityQuery("track", 120)).toEqual({ limit: "25", subject_type: "track", before: "120" });
  });

  it("offers the IA's five filters, All first", () => {
    expect(ACTIVITY_FILTERS.map((f) => f.label)).toEqual(["All", "Tasks", "Pilots", "Tracks", "Settings"]);
  });
});

describe("groupActivityByDay", () => {
  it("groups by the competition's calendar day, newest first", () => {
    const entries = [
      entry(3, "2026-01-14T13:30:00.000Z"), // 00:30 on the 15th in Sydney (AEDT)
      entry(2, "2026-01-14T02:00:00.000Z"),
      entry(1, "2026-01-13T02:00:00.000Z"),
    ];
    const days = groupActivityByDay(entries, "Australia/Sydney");
    expect(days.map((d) => d.date)).toEqual(["2026-01-15", "2026-01-14", "2026-01-13"]);
    expect(groupActivityByDay(entries, "UTC").map((d) => [d.date, d.entries.length])).toEqual([
      ["2026-01-14", 2],
      ["2026-01-13", 1],
    ]);
  });
});
