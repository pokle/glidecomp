/**
 * buildCompStandings carries what each pilot DID on each task (goal, the
 * distance flown, the speed-section time) into their task entries, so a page
 * of one pilot's competition can say "goal in 1:37:55" beside each task
 * without fetching every task's scores. The figures are copied, never
 * summed: the totals are unchanged by them.
 */
import { describe, it, expect } from "vitest";
import { buildCompStandings } from "../src/comp-standings";
import type { StandingsTask } from "../src/comp-standings";

type Pilot = StandingsTask["classes"][number]["pilots"][number];

function pilot(id: string, total: number, rank: number, extra: Partial<Pilot>): Pilot {
  return {
    rank,
    comp_pilot_id: id,
    pilot_name: id.toUpperCase(),
    made_goal: false,
    reached_ess: false,
    flown_distance: 0,
    speed_section_time: null,
    total_score: total,
    ...extra,
  } as Pilot;
}

function task(id: string, pilots: Pilot[]): StandingsTask {
  return {
    task_id: id,
    task_date: "2026-01-05",
    classes: [
      {
        pilot_class: "open",
        pilots,
        task_validity: { launch: 1, distance: 1, time: 1, task: 1 },
      } as unknown as StandingsTask["classes"][number],
    ],
  };
}

const comp = { category: "hg", scoring_format: "gap", series_scoring: "total", ftv_factor: null };

describe("buildCompStandings", () => {
  it("copies each task's goal, distance and time onto the pilot's entry", () => {
    const { classScores } = buildCompStandings(comp, [
      task("t1", [
        pilot("a", 1000, 1, { made_goal: true, reached_ess: true, flown_distance: 78845.9, speed_section_time: 5875.1 }),
        pilot("b", 480, 2, { flown_distance: 76948.4 }),
      ]),
    ]);
    const [a, b] = classScores[0].pilots;
    expect(a.tasks[0]).toMatchObject({
      task_id: "t1",
      score: 1000,
      rank: 1,
      made_goal: true,
      flown_distance: 78845.9,
      speed_section_time: 5875.1,
    });
    expect(b.tasks[0]).toMatchObject({ made_goal: false, flown_distance: 76948.4, speed_section_time: null });
    // Copied, not counted: the total is the task scores alone.
    expect(a.total_score).toBe(1000);
  });
});
