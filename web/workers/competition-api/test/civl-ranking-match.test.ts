import { describe, expect, test } from "vitest";
import {
  bestPerPilot,
  matchRoster,
  nameKey,
  type RankedEntry,
} from "../src/civl-ranking-match";

/**
 * The rules the roster editor's fill button runs on. Read the module header
 * for why each refusal is a refusal — in short, a rank follows a CIVL ID and
 * nothing else, a name may only propose an ID when exactly one human answers
 * to it, and a pilot who appears in several lists is one human at their best
 * rank rather than several claimants to a name.
 */

const HG = { ranking_slug: "hang-gliding-class-1-xc", ranking_name: "HG Class 1" };
const PG = { ranking_slug: "paragliding-xc", ranking_name: "PG XC" };
const SPORT = {
  ranking_slug: "paragliding-xc-sport",
  ranking_name: "PG XC Sport",
};
const DATE = "2026-08-01";

function ranked(
  list: { ranking_slug: string; ranking_name: string },
  rank: number,
  civl_id: string,
  pilot_name: string,
  points = 100 - rank
): RankedEntry {
  return { ...list, ranking_date: DATE, rank, civl_id, pilot_name, points };
}

describe("bestPerPilot — one number per human", () => {
  test("keeps the lowest rank across lists", () => {
    const best = bestPerPilot([
      ranked(PG, 106, "25161", "Luke Nicol"),
      ranked(SPORT, 1, "25161", "Luke Nicol"),
    ]);
    expect(best.size).toBe(1);
    expect(best.get("25161")).toMatchObject({ rank: 1, ranking_name: "PG XC Sport" });
  });

  test("an equal rank in two lists goes to the one with more points", () => {
    // Same position in two pools is not the same achievement; the WPRS score
    // is the tiebreak that means something.
    const best = bestPerPilot([
      ranked(SPORT, 5, "900", "Twin Rank", 120),
      ranked(HG, 5, "900", "Twin Rank", 250),
    ]);
    expect(best.get("900")).toMatchObject({ ranking_name: "HG Class 1", points: 250 });
  });

  test("an exact tie is broken by slug, so a re-run answers identically", () => {
    const forwards = bestPerPilot([
      ranked(PG, 5, "900", "Twin Rank", 100),
      ranked(HG, 5, "900", "Twin Rank", 100),
    ]);
    const backwards = bestPerPilot([
      ranked(HG, 5, "900", "Twin Rank", 100),
      ranked(PG, 5, "900", "Twin Rank", 100),
    ]);
    expect(forwards.get("900")).toEqual(backwards.get("900"));
    expect(forwards.get("900")?.ranking_slug).toBe("hang-gliding-class-1-xc");
  });
});

describe("matchRoster — by CIVL ID", () => {
  test("a row carrying an id gets that pilot's best rank, and the list it is from", () => {
    const result = matchRoster(
      [{ name: "Luke Nicol", civl_id: "25161" }],
      [ranked(PG, 106, "25161", "Luke Nicol"), ranked(SPORT, 1, "25161", "Luke Nicol")]
    );
    expect(result.matches[0]).toMatchObject({
      matched_by: "civl_id",
      rank: 1,
      ranking_slug: "paragliding-xc-sport",
      ranking_name: "PG XC Sport",
      ranking_date: DATE,
    });
    expect(result.rankable_count).toBe(1);
  });

  test("the id wins even when the roster spells the name differently", () => {
    const result = matchRoster(
      [{ name: "A. Silva", civl_id: "25161" }],
      [ranked(HG, 12, "25161", "Ana Silva")]
    );
    expect(result.matches[0]).toMatchObject({ matched_by: "civl_id", rank: 12 });
  });

  test("an id no list has ranked matches nothing", () => {
    const result = matchRoster(
      [{ name: "Ana Silva", civl_id: "99999" }],
      [ranked(HG, 12, "25161", "Ana Silva")]
    );
    expect(result.matches[0]).toBeUndefined();
    expect(result.matched_count).toBe(0);
  });

  test("surrounding whitespace in an id is ignored", () => {
    const result = matchRoster(
      [{ name: "Ana", civl_id: " 25161 " }],
      [ranked(HG, 12, "25161", "Ana Silva")]
    );
    expect(result.matches[0]?.rank).toBe(12);
  });
});

describe("matchRoster — by name", () => {
  test("an empty id cell is offered the uniquely-named pilot's id", () => {
    const result = matchRoster(
      [{ name: "Ana Silva", civl_id: null }],
      [ranked(HG, 12, "25161", "Ana Silva")]
    );
    expect(result.matches[0]).toMatchObject({
      matched_by: "name",
      civl_id: "25161",
      rank: 12,
    });
    // It can be placed, but it cannot fill a RANK until the id is really there.
    expect(result.matched_count).toBe(1);
    expect(result.rankable_count).toBe(0);
  });

  test("ONE pilot in several lists is not an ambiguity", () => {
    // The whole reason the picker could be removed: collapsing to the best
    // rank first means four appearances read as one human, not four rivals
    // for a name.
    const result = matchRoster(
      [{ name: "Luke Nicol", civl_id: null }],
      [
        ranked(PG, 106, "25161", "Luke Nicol"),
        ranked(SPORT, 1, "25161", "Luke Nicol"),
        ranked(HG, 40, "25161", "Luke Nicol"),
      ]
    );
    expect(result.matches[0]).toMatchObject({ civl_id: "25161", rank: 1 });
  });

  test("two DIFFERENT humans sharing a name are still refused, across lists", () => {
    const result = matchRoster(
      [{ name: "John Smith", civl_id: null }],
      [ranked(HG, 20, "1001", "John Smith"), ranked(PG, 51, "1002", "John Smith")]
    );
    expect(result.matches[0]).toBeUndefined();
  });

  test("case and inner whitespace do not matter", () => {
    const result = matchRoster(
      [{ name: "  ana   SILVA ", civl_id: null }],
      [ranked(HG, 12, "25161", "Ana Silva")]
    );
    expect(result.matches[0]?.civl_id).toBe("25161");
  });

  test("accents are not folded — the row is left alone", () => {
    // Documented limit: SQLite's NOCASE is ASCII-only, so folding here would
    // claim a match the query could never have fetched.
    const result = matchRoster(
      [{ name: "Jose Garcia", civl_id: null }],
      [ranked(HG, 3, "40001", "José García")]
    );
    expect(result.matches[0]).toBeUndefined();
  });

  test("two roster rows naming the same pilot are both refused", () => {
    const result = matchRoster(
      [
        { name: "Ana Silva", civl_id: null },
        { name: "ana silva", civl_id: null },
      ],
      [ranked(HG, 12, "25161", "Ana Silva")]
    );
    expect(result.matches[0]).toBeUndefined();
    expect(result.matches[1]).toBeUndefined();
  });

  test("an id already held by another row is never handed out again", () => {
    const result = matchRoster(
      [
        { name: "Ana Silva", civl_id: "25161" },
        { name: "Ana Silva", civl_id: null },
      ],
      [ranked(HG, 12, "25161", "Ana Silva")]
    );
    expect(result.matches[0]).toMatchObject({ matched_by: "civl_id" });
    expect(result.matches[1]).toBeUndefined();
  });

  test("a row that already has an id is never name-matched", () => {
    const result = matchRoster(
      [{ name: "Ana Silva", civl_id: "99999" }],
      [ranked(HG, 12, "25161", "Ana Silva")]
    );
    expect(result.matches[0]).toBeUndefined();
  });
});

describe("matchRoster — nothing to match against", () => {
  test("no rankings imported at all", () => {
    const result = matchRoster([{ name: "Ana Silva", civl_id: "25161" }], []);
    expect(result).toEqual({ matches: {}, matched_count: 0, rankable_count: 0 });
  });
});

describe("nameKey", () => {
  test("normalises case and whitespace only", () => {
    expect(nameKey("  Ana   SILVA\t")).toBe("ana silva");
    expect(nameKey("José")).toBe("josé");
  });
});
