// Copyright (c) 2026, Tushar Pokle.  All rights reserved.
//
// These run against the two REAL exports committed under
// web/samples/civl-rankings/ (HG Class 1 and HG Class 1 Sport, Jul 2026).
// They are the regression guard for the one failure this pipeline cannot
// detect at runtime: civlcomps.org changing the shape of the workbook.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCivlDate, parseRankingSheet } from "./civl-ranking-sheet";
import { readSheetRows } from "./xlsx-reader";

const SAMPLES = join(import.meta.dir, "../../samples/civl-rankings");

function load(file: string) {
  return parseRankingSheet(readSheetRows(readFileSync(join(SAMPLES, file))));
}

describe("parseCivlDate", () => {
  test("reads the format CIVL writes", () => {
    expect(parseCivlDate("Jul 1, 2026")).toBe("2026-07-01");
    expect(parseCivlDate("Dec 1, 2025")).toBe("2025-12-01");
    expect(parseCivlDate("Jan 1, 2007")).toBe("2007-01-01");
  });

  test("tolerates a full month name and stray whitespace", () => {
    expect(parseCivlDate("  September 1,2024 ")).toBe("2024-09-01");
  });

  test("throws rather than guessing", () => {
    // A date this can't read is what the importer compares against D1 to
    // decide 'do I already have this month?' — a silent wrong answer there
    // either re-imports forever or never imports again.
    expect(() => parseCivlDate("2026-07-01")).toThrow(/Unrecognised CIVL date/);
    expect(() => parseCivlDate("Jul 2026")).toThrow(/Unrecognised CIVL date/);
    expect(() => parseCivlDate("Xxx 1, 2026")).toThrow(/Unrecognised month/);
    expect(() => parseCivlDate("")).toThrow();
  });
});

describe("parseRankingSheet — HG Class 1", () => {
  const { meta, pilots } = load("hang-gliding-class-1-xc-2026-07.xlsx");

  test("reads the metadata block", () => {
    expect(meta).toEqual({
      ranking_date: "2026-07-01",
      name: "HG Class 1",
      region: "World",
      selection: "Overall",
      created: "Jul 1, 2026 03:05",
    });
  });

  test("reads every pilot the footer promises", () => {
    // The sheet's own `count` footer says 747; parseRankingSheet throws on a
    // mismatch, so reaching this assertion already proves agreement.
    expect(pilots).toHaveLength(747);
  });

  test("reads the first row across all six columns", () => {
    expect(pilots[0]).toEqual({
      rank: 1,
      civl_id: "25161",
      name: "Marco Laurenzi",
      gender: "M",
      nation: "Italy",
      points: 339.3,
    });
  });

  test("reads the last row before the footer", () => {
    expect(pilots.at(-1)).toEqual({
      rank: 695,
      civl_id: "95565",
      name: "Francisco (Patxi) García González",
      gender: "M",
      nation: "Spain",
      points: 0.1,
    });
  });

  test("keeps unicode and punctuation in names intact", () => {
    const names = pilots.map((p) => p.name);
    expect(names).toContain("Francisco (Patxi) García González");
    expect(names.every((n) => n.length > 0)).toBe(true);
  });

  test("ranks tie, which is why points is stored", () => {
    // 344 of 747 rows share a rank with someone. Rank alone cannot order the
    // list; anything building a launch order needs points as the tiebreak.
    const distinct = new Set(pilots.map((p) => p.rank)).size;
    expect(distinct).toBeLessThan(pilots.length);
    expect(pilots.filter((p) => p.rank === 695).length).toBeGreaterThan(1);
  });

  test("ranks are non-decreasing down the sheet", () => {
    for (let i = 1; i < pilots.length; i++) {
      expect(pilots[i].rank).toBeGreaterThanOrEqual(pilots[i - 1].rank);
    }
  });

  test("CIVL ids are unique and stay strings", () => {
    // TEXT, to match pilot.civl_id / comp_pilot.registered_pilot_civl_id.
    expect(new Set(pilots.map((p) => p.civl_id)).size).toBe(pilots.length);
    expect(pilots.every((p) => typeof p.civl_id === "string")).toBe(true);
  });

  test("gender is one of the two values CIVL publishes", () => {
    expect(new Set(pilots.map((p) => p.gender))).toEqual(new Set(["M", "F"]));
  });
});

describe("parseRankingSheet — HG Class 1 Sport", () => {
  const { meta, pilots } = load("hang-gliding-class-1-sport-xc-2026-07.xlsx");

  test("distinguishes itself from the Class 1 list by name alone", () => {
    // Same region, same selection, same date — `name` is the only metadata
    // field that separates two lists, which is why the row's identity is the
    // URL slug and not any of this.
    expect(meta.name).toBe("HG Class 1 Sport");
    expect(meta.region).toBe("World");
    expect(meta.selection).toBe("Overall");
    expect(meta.ranking_date).toBe("2026-07-01");
  });

  test("reads all 324 pilots", () => {
    expect(pilots).toHaveLength(324);
    expect(pilots[0]).toEqual({
      rank: 1,
      civl_id: "90055",
      name: "Michael Boisvert",
      gender: "M",
      nation: "United States",
      points: 172.2,
    });
  });
});

describe("parseRankingSheet — malformed input", () => {
  const good = readSheetRows(
    readFileSync(join(SAMPLES, "hang-gliding-class-1-sport-xc-2026-07.xlsx")),
  );

  test("rejects a truncated download", () => {
    // Drop the footer: the exporter's own row total is the only way to notice
    // a download that ended early but still parsed.
    const rows = good.filter((r) => (r[0] ?? "").trim().toLowerCase() !== "count");
    expect(() => parseRankingSheet(rows)).toThrow(/no "count" footer/);
  });

  test("rejects a count that disagrees with the rows", () => {
    const rows = good.map((r) => [...r]);
    const footer = rows.findIndex((r) => (r[0] ?? "").trim().toLowerCase() === "count");
    rows[footer + 1] = ["999"];
    expect(() => parseRankingSheet(rows)).toThrow(/count mismatch: footer says 999, parsed 324/);
  });

  test("rejects a sheet with no metadata block", () => {
    expect(() => parseRankingSheet(good.slice(4))).toThrow(/no metadata header row/);
  });

  test("rejects a sheet whose pilot header is missing", () => {
    const rows = good.map((r) => [...r]);
    const header = rows.findIndex((r) => (r[0] ?? "").trim() === "Rank");
    rows[header][0] = "Position";
    expect(() => parseRankingSheet(rows)).toThrow(/no pilot header row/);
  });

  test("rejects a duplicated pilot", () => {
    const rows = good.map((r) => [...r]);
    const header = rows.findIndex((r) => (r[0] ?? "").trim() === "Rank");
    rows[header + 2][1] = rows[header + 1][1];
    expect(() => parseRankingSheet(rows)).toThrow(/duplicate CIVL ID/);
  });
});
