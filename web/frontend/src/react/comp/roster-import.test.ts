import { describe, expect, it } from "vitest";
import { exportCsvContent, pilotToRow, type CompPilot } from "./csv";
import { fallbackClass, listInWords, planImport, planRequest } from "./roster-import";

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

  it("groups the reasons it cannot apply, once per row", () => {
    const csv = [
      "name,class",
      "Zed One,floater",
      "Zed Two,floater",
      "Kite Three,kite",
      ",open",
      "No Class,",
    ].join("\n");
    const plan = planImport(csv, "bad.csv", ROSTER, CLASSES);
    expect(plan.problems.unknownClasses.map((g) => [g.cls, g.rows.map((r) => r.row)])).toEqual([
      ["floater", [1, 2]],
      ["kite", [3]],
    ]);
    expect(plan.problems.noName.map((r) => r.row)).toEqual([4]);
    expect(plan.problems.noClass.map((r) => r.row)).toEqual([5]);
    expect(plan.problems.other).toEqual([]);
    // One message per problem row: the class check is not repeated.
    expect(plan.errors).toHaveLength(5);
  });

  it("keeps an error it has no group for as it was said", () => {
    const plan = planImport("email,class\na@b.c,open", "noname.csv", ROSTER, CLASSES);
    expect(plan.problems.other).toEqual(plan.errors);
    expect(plan.errors.length).toBe(1);
  });

  it("puts pilots of a class the comp lacks in the one the organiser chose", () => {
    const csv = ["name,class", "Zed One,floater", "Zed Two,floater", "No Class,"].join("\n");
    const plan = planImport(csv, "bad.csv", ROSTER, CLASSES, { unknownClassAs: "open" });
    expect(plan.remapped).toEqual([{ from: "floater", to: "open", count: 2 }]);
    expect(plan.problems.unknownClasses).toEqual([]);
    expect(plan.added.filter((r) => r.pilot_class === "open").map((r) => r.registered_pilot_name)).toEqual([
      "Zed One",
      "Zed Two",
    ]);
    // A row with NO class is not moved: nobody said anything about it.
    expect(plan.problems.noClass.map((r) => r.row)).toEqual([3]);
    expect(plan.errors).toHaveLength(1);
  });

  it("ignores a fallback class the comp does not have", () => {
    const plan = planImport("name,class\nZed,floater", "bad.csv", ROSTER, CLASSES, {
      unknownClassAs: "kite",
    });
    expect(plan.remapped).toEqual([]);
    expect(plan.problems.unknownClasses.map((g) => g.cls)).toEqual(["floater"]);
  });

  it("an empty file is an error, not an empty roster", () => {
    const plan = planImport("", "empty.csv", ROSTER, CLASSES);
    expect(plan.errors.length).toBeGreaterThan(0);
    expect(plan.removed).toEqual([]);
  });
});

describe("wording helpers", () => {
  it("lists in words", () => {
    expect(listInWords(["open"])).toBe("open");
    expect(listInWords(["open", "sport"])).toBe("open and sport");
    expect(listInWords(["a", "b", "c"])).toBe("a, b and c");
  });

  it("falls back to the default class, else the first", () => {
    expect(fallbackClass(["open", "sport"], "sport")).toBe("sport");
    expect(fallbackClass(["open", "sport"], "kite")).toBe("open");
    expect(fallbackClass(["open", "sport"], null)).toBe("open");
  });
});
