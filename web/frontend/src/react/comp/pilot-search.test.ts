import { describe, expect, it } from "vitest";
import type { CompPilot } from "./csv";
import { filterPilots, fold, matchesPilot } from "./pilot-search";

function pilot(overrides: Partial<CompPilot> = {}): CompPilot {
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

describe("fold", () => {
  it("ignores case and accents", () => {
    expect(fold("Müller")).toBe("muller");
    expect(fold("JÉRÔME")).toBe("jerome");
  });

  it("folds the letters Unicode does not decompose", () => {
    expect(fold("Søren Łukasz Æsir")).toBe("soren lukasz aesir");
  });
});

describe("matchesPilot", () => {
  it("matches every word, in any order", () => {
    const p = pilot();
    expect(matchesPilot(p, "smi tom")).toBe(true);
    expect(matchesPilot(p, "tom jones")).toBe(false);
  });

  it("finds an accented name from plain letters", () => {
    expect(matchesPilot(pilot({ name: "Ana Müller" }), "muller")).toBe(true);
  });

  it("finds a pilot by any ID off a licence", () => {
    expect(matchesPilot(pilot({ civl_id: "12345" }), "12345")).toBe(true);
    expect(matchesPilot(pilot({ safa_id: "S-998" }), "s-998")).toBe(true);
    expect(matchesPilot(pilot({ fai_id: "F77" }), "f77")).toBe(true);
  });

  it("finds by glider, team, driver, email and @username", () => {
    expect(matchesPilot(pilot({ glider: "Moyes Litespeed RX" }), "litespeed")).toBe(true);
    expect(matchesPilot(pilot({ team_name: "Bright Team" }), "bright")).toBe(true);
    expect(matchesPilot(pilot({ driver_contact: "Sam 0400 111 222" }), "0400")).toBe(true);
    expect(matchesPilot(pilot({ email: "tom@example.com" }), "example.com")).toBe(true);
    expect(matchesPilot(pilot({ linked_username: "tsmith" }), "@tsmith")).toBe(true);
  });

  it("finds a class by its name, so no class filter is needed", () => {
    expect(matchesPilot(pilot({ pilot_class: "sport" }), "Sport")).toBe(true);
  });

  it("words can match different fields", () => {
    expect(matchesPilot(pilot({ pilot_class: "open" }), "tom open")).toBe(true);
  });

  it("an empty or blank query matches everyone", () => {
    expect(matchesPilot(pilot(), "")).toBe(true);
    expect(matchesPilot(pilot(), "   ")).toBe(true);
  });
});

describe("filterPilots", () => {
  it("keeps the order it was given", () => {
    const list = [
      pilot({ comp_pilot_id: "a", name: "Zed Tom" }),
      pilot({ comp_pilot_id: "b", name: "Ann Lee" }),
      pilot({ comp_pilot_id: "c", name: "Tom Ames" }),
    ];
    expect(filterPilots(list, "tom").map((p) => p.comp_pilot_id)).toEqual(["a", "c"]);
  });
});
