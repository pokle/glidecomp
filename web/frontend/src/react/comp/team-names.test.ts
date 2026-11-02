import { describe, expect, it } from "vitest";
import { matchTeam, rosterTeams, teamKey, teamOptions } from "./team-names";

const roster = (...names: Array<string | null>) => names.map((team_name) => ({ team_name }));

describe("teamKey", () => {
  it("ignores case, spacing and accents", () => {
    expect(teamKey("  Alpha   GLIDERS ")).toBe("alpha gliders");
    expect(teamKey("Équipe Bleue")).toBe(teamKey("equipe bleue"));
  });
});

describe("rosterTeams", () => {
  it("counts pilots per team, most first, and leaves out the teamless", () => {
    expect(rosterTeams(roster("Alpha", "Bravo", "Alpha", null, "  "))).toEqual([
      { name: "Alpha", count: 2 },
      { name: "Bravo", count: 1 },
    ]);
  });

  it("joins spellings of one team under the spelling most pilots use", () => {
    expect(rosterTeams(roster("Alpha Gliders", "alpha gliders", "Alpha Gliders"))).toEqual([
      { name: "Alpha Gliders", count: 3 },
    ]);
  });
});

describe("matchTeam", () => {
  const teams = rosterTeams(roster("Alpha Gliders", "Alpha Gliders", "Bravo", "Sky Kings"));

  it("finds the team a differently-written name IS", () => {
    expect(matchTeam("alpha  GLIDERS", teams).exact?.name).toBe("Alpha Gliders");
  });

  it("offers the team a slip away, without deciding", () => {
    expect(matchTeam("Alpha Gilders", teams)).toEqual({
      exact: null,
      near: [{ name: "Alpha Gliders", count: 2 }],
    });
    expect(matchTeam("Brvao", teams).near.map((t) => t.name)).toEqual(["Bravo"]);
  });

  it("does not call a short name a slip of another", () => {
    const short = rosterTeams(roster("A", "B", "AB"));
    expect(matchTeam("C", short)).toEqual({ exact: null, near: [] });
  });

  it("a genuinely different name matches nothing", () => {
    expect(matchTeam("Thermal Hunters", teams)).toEqual({ exact: null, near: [] });
  });
});

describe("teamOptions", () => {
  const teams = rosterTeams(roster("Alpha Gliders", "Alpha Gliders", "Bravo"));

  it("lists every team for an empty field", () => {
    expect(teamOptions("", teams).map((o) => o.id)).toEqual(["team:Alpha Gliders", "team:Bravo"]);
  });

  it("narrows to the teams that contain what was typed, with nothing new to offer", () => {
    expect(teamOptions("alp", teams).map((o) => o.kind + ":" + o.name)).toEqual([
      "team:Alpha Gliders",
      "new:alp",
    ]);
    expect(teamOptions("alpha gliders", teams).map((o) => o.kind)).toEqual(["team"]);
  });

  it("puts Did you mean before New team for a slip", () => {
    expect(teamOptions("Alpha Gilders", teams).map((o) => o.kind + ":" + o.name)).toEqual([
      "near:Alpha Gliders",
      "new:Alpha Gilders",
    ]);
  });
});
