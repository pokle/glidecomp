import { describe, expect, it } from "vitest";
import { emptyRow, pilotToRow, type CompPilot } from "./csv";
import { createBody, draftProblems, isBlankDraft, isDirtyDraft, patchBody } from "./pilot-edit";

const CLASSES = ["open", "sport"];

function pilot(overrides: Partial<CompPilot> = {}): CompPilot {
  return {
    comp_pilot_id: "p1",
    linked: false,
    linked_email: null,
    linked_username: null,
    name: "Tom Smith",
    email: "tom@example.com",
    civl_id: "123",
    safa_id: null,
    ushpa_id: null,
    bhpa_id: null,
    dhv_id: null,
    ffvl_id: null,
    fai_id: null,
    glider: "Litespeed RX",
    pilot_class: "open",
    team_name: "Alpha",
    driver_contact: null,
    wprs_points: 261.5,
    civl_ranking_slug: "hang-gliding-class-1-xc",
    civl_ranking_date: "2026-10-01",
    first_start_order: null,
    track_count: 0,
    ...overrides,
  };
}

describe("patchBody", () => {
  it("sends only the fields that changed", () => {
    const p = pilot();
    expect(patchBody(p, { ...pilotToRow(p), team_name: "Bravo" })).toEqual({ team_name: "Bravo" });
  });

  it("sends nothing for an untouched pilot, whitespace included", () => {
    const p = pilot();
    expect(patchBody(p, { ...pilotToRow(p), glider: "  Litespeed RX " })).toEqual({});
  });

  it("clears a field with null", () => {
    const p = pilot();
    expect(patchBody(p, { ...pilotToRow(p), team_name: "" })).toEqual({ team_name: null });
  });

  it("sends an identity field under its server name", () => {
    const p = pilot();
    expect(patchBody(p, { ...pilotToRow(p), civl_id: "999" })).toEqual({
      registered_pilot_civl_id: "999",
    });
  });

  it("a typed-over score drops the list it came from", () => {
    const p = pilot();
    const body = patchBody(p, {
      ...pilotToRow(p),
      wprs_points: "300",
      civl_ranking_slug: null,
      civl_ranking_date: null,
    });
    expect(body).toEqual({ wprs_points: 300, civl_ranking_slug: null, civl_ranking_date: null });
  });
});

describe("createBody", () => {
  it("is the bulk row without an id", () => {
    const body = createBody({ ...emptyRow(CLASSES), name: " Jo Ridge ", pilot_class: "open" });
    expect(body.registered_pilot_name).toBe("Jo Ridge");
    expect(body.pilot_class).toBe("open");
    expect("comp_pilot_id" in body).toBe(false);
  });
});

describe("isBlankDraft / isDirtyDraft", () => {
  it("a new row with only the single class chosen is blank", () => {
    expect(isBlankDraft(emptyRow(["open"]))).toBe(true);
    expect(isBlankDraft({ ...emptyRow(["open"]), name: "Jo" })).toBe(false);
  });

  it("dirty means a saved value would change", () => {
    const start = pilotToRow(pilot());
    expect(isDirtyDraft(start, { ...start, team_name: " Alpha " })).toBe(false);
    expect(isDirtyDraft(start, { ...start, team_name: "Bravo" })).toBe(true);
  });
});

describe("draftProblems", () => {
  it("needs a name and one of the comp's classes", () => {
    expect(draftProblems({ ...emptyRow(CLASSES), name: "" }, CLASSES)).toEqual({
      name: "Enter the pilot's name.",
      pilot_class: "Choose a class.",
    });
  });

  it("checks the email's shape and the points", () => {
    const row = { ...pilotToRow(pilot()), email: "tom", wprs_points: "lots" };
    const problems = draftProblems(row, CLASSES);
    expect(Object.keys(problems).sort()).toEqual(["email", "wprs_points"]);
  });

  it("an empty email and empty points are fine", () => {
    expect(draftProblems({ ...pilotToRow(pilot()), email: "", wprs_points: "" }, CLASSES)).toEqual({});
  });
});
