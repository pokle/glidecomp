import { describe, expect, it } from "vitest";
import { exportCsvContent, pilotToRow, type CompPilot } from "./csv";
import { planImport, planRequest } from "./roster-import";

const CLASSES = ["open", "sport"];

function pilot(overrides: Partial<CompPilot>): CompPilot {
  return {
    comp_pilot_id: "p1",
    linked: false,
    linked_email: null,
    linked_username: null,
    name: "Tom Smith",
    email: null,
    civl_id: null,
    safa_id: null,
    ushpa_id: null,
    bhpa_id: null,
    dhv_id: null,
    ffvl_id: null,
    fai_id: null,
    glider: null,
    pilot_class: "open",
    team_name: null,
    driver_contact: null,
    wprs_points: null,
    civl_ranking_slug: null,
    civl_ranking_date: null,
    first_start_order: null,
    track_count: 0,
    ...overrides,
  };
}

const ROSTER = [
  pilot({ comp_pilot_id: "a", name: "Ada Thermal", civl_id: "1", wprs_points: 261.5,
    civl_ranking_slug: "hang-gliding-class-1-xc", civl_ranking_date: "2026-10-01" }),
  pilot({ comp_pilot_id: "b", name: "Bruno Ridge", email: "bruno@example.com", track_count: 3 }),
  pilot({ comp_pilot_id: "c", name: "Cleo Vario" }),
];

describe("planImport", () => {
  it("an exported roster re-imports as no change at all", () => {
    // Cleo has no ID or email; the export's glidecomp_id column is what
    // brings her back as herself rather than as somebody new.
    const csv = exportCsvContent(ROSTER.map(pilotToRow));
    const plan = planImport(csv, "pilots.csv", ROSTER, CLASSES);
    expect(plan.unchanged).toBe(3);
    expect(plan.updated).toEqual([]);
    expect(plan.added).toEqual([]);
    expect(plan.removed).toEqual([]);
  });

  it("a file of bare names re-adds them, and flags the originals it removes", () => {
    const csv = ["name,class", "Cleo Vario,open"].join("\n");
    const plan = planImport(csv, "names.csv", [ROSTER[2]], CLASSES);
    expect(plan.added.map((r) => r.registered_pilot_name)).toEqual(["Cleo Vario"]);
    expect(plan.removed.map((r) => [r.pilot.name, r.sameNameAsNew])).toEqual([["Cleo Vario", true]]);
  });

  it("ignores an id this roster does not hold", () => {
    const csv = ["name,class,glidecomp_id", "Dee New,open,zzzz"].join("\n");
    const plan = planImport(csv, "other-comp.csv", ROSTER, CLASSES);
    expect(plan.added.map((r) => [r.registered_pilot_name, r.comp_pilot_id])).toEqual([
      ["Dee New", undefined],
    ]);
  });

  it("keeps a CIVL score's source while the number is unchanged", () => {
    const csv = exportCsvContent(ROSTER.map(pilotToRow));
    const plan = planImport(csv, "pilots.csv", ROSTER, CLASSES);
    expect(plan.updated.find((u) => u.before.comp_pilot_id === "a")).toBeUndefined();
  });

  it("names who is updated, added and removed", () => {
    const csv = [
      "name,email,class,civl_id",
      "Ada Thermal,,sport,1",
      "Dee New,,open,",
    ].join("\n");
    const plan = planImport(csv, "pilots.csv", ROSTER, CLASSES);
    expect(plan.updated.map((u) => [u.before.name, u.row.pilot_class])).toEqual([["Ada Thermal", "sport"]]);
    expect(plan.added.map((r) => r.registered_pilot_name)).toEqual(["Dee New"]);
    expect(plan.removed.map((r) => r.pilot.name)).toEqual(["Bruno Ridge", "Cleo Vario"]);
    expect(plan.errors).toEqual([]);

    expect(planRequest(plan)).toEqual({
      pilots: [plan.updated[0].row, plan.added[0]],
      remove: ["b", "c"],
    });
  });

  it("reports a file it cannot apply", () => {
    const plan = planImport("name,class\nZed,floater", "bad.csv", ROSTER, CLASSES);
    expect(plan.errors.length).toBeGreaterThan(0);
  });

  it("an empty file is an error, not an empty roster", () => {
    const plan = planImport("", "empty.csv", ROSTER, CLASSES);
    expect(plan.errors.length).toBeGreaterThan(0);
    expect(plan.removed).toEqual([]);
  });
});
