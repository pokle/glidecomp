import { describe, expect, test } from "vitest";
import {
  defaultListSlug,
  matchList,
  nameKey,
  type ListInfo,
  type ListMatches,
  type RankingRow,
} from "../src/civl-ranking-match";

/**
 * The rules the roster editor's two fill buttons run on. Read the module
 * header for why each refusal is a refusal — in short, a rank follows a CIVL
 * ID and nothing else, and a name may only propose an ID when exactly one
 * human on both sides answers to it.
 */

const HG: ListInfo = {
  slug: "hang-gliding-class-1-xc",
  name: "HG Class 1",
  ranking_date: "2026-07-01",
};

function ranked(rank: number, civl_id: string, pilot_name: string): RankingRow {
  return { rank, civl_id, pilot_name, points: 100 - rank };
}

describe("matchList — by CIVL ID", () => {
  test("a row carrying an id gets that pilot's rank", () => {
    const result = matchList(HG, [{ name: "Ana Silva", civl_id: "25161" }], [
      ranked(12, "25161", "Ana Silva"),
    ]);
    expect(result.matches[0]).toMatchObject({
      matched_by: "civl_id",
      rank: 12,
      pilot_name: "Ana Silva",
    });
    expect(result.rankable_count).toBe(1);
  });

  test("the id wins even when the roster spells the name differently", () => {
    // The id identifies the human; the roster's spelling of their name is not
    // evidence against it.
    const result = matchList(HG, [{ name: "A. Silva", civl_id: "25161" }], [
      ranked(12, "25161", "Ana Silva"),
    ]);
    expect(result.matches[0]).toMatchObject({ matched_by: "civl_id", rank: 12 });
  });

  test("an id this list has never ranked matches nothing", () => {
    const result = matchList(HG, [{ name: "Ana Silva", civl_id: "99999" }], [
      ranked(12, "25161", "Ana Silva"),
    ]);
    expect(result.matches[0]).toBeUndefined();
    expect(result.matched_count).toBe(0);
  });

  test("surrounding whitespace in an id is ignored", () => {
    const result = matchList(HG, [{ name: "Ana", civl_id: " 25161 " }], [
      ranked(12, "25161", "Ana Silva"),
    ]);
    expect(result.matches[0]?.rank).toBe(12);
  });
});

describe("matchList — by name", () => {
  test("an empty id cell is offered the uniquely-named pilot's id", () => {
    const result = matchList(HG, [{ name: "Ana Silva", civl_id: null }], [
      ranked(12, "25161", "Ana Silva"),
    ]);
    expect(result.matches[0]).toMatchObject({
      matched_by: "name",
      civl_id: "25161",
      rank: 12,
    });
    // It can be placed, but it cannot fill a RANK until the id is really there.
    expect(result.matched_count).toBe(1);
    expect(result.rankable_count).toBe(0);
  });

  test("case and inner whitespace do not matter", () => {
    const result = matchList(HG, [{ name: "  ana   SILVA ", civl_id: null }], [
      ranked(12, "25161", "Ana Silva"),
    ]);
    expect(result.matches[0]?.civl_id).toBe("25161");
  });

  test("accents are not folded — the row is left alone", () => {
    // Documented limit: SQLite's NOCASE is ASCII-only, so folding here would
    // claim a match the query could never have fetched.
    const result = matchList(HG, [{ name: "Jose Garcia", civl_id: null }], [
      ranked(3, "40001", "José García"),
    ]);
    expect(result.matches[0]).toBeUndefined();
  });

  test("two ranked pilots sharing a name are both refused", () => {
    const result = matchList(HG, [{ name: "John Smith", civl_id: null }], [
      ranked(20, "1001", "John Smith"),
      ranked(51, "1002", "John Smith"),
    ]);
    expect(result.matches[0]).toBeUndefined();
  });

  test("two roster rows naming the same pilot are both refused", () => {
    // One of the two is not that person, and nothing here can say which.
    const result = matchList(
      HG,
      [
        { name: "Ana Silva", civl_id: null },
        { name: "ana silva", civl_id: null },
      ],
      [ranked(12, "25161", "Ana Silva")]
    );
    expect(result.matches[0]).toBeUndefined();
    expect(result.matches[1]).toBeUndefined();
  });

  test("an id already held by another row is never handed out again", () => {
    // Otherwise the bulk save rejects the roster with "two rows resolved to
    // the same pilot" — after the organiser has typed the rest of it.
    const result = matchList(
      HG,
      [
        { name: "Ana Silva", civl_id: "25161" },
        { name: "Ana Silva", civl_id: null },
      ],
      [ranked(12, "25161", "Ana Silva")]
    );
    expect(result.matches[0]).toMatchObject({ matched_by: "civl_id" });
    expect(result.matches[1]).toBeUndefined();
  });

  test("a row that already has an id is never name-matched", () => {
    const result = matchList(HG, [{ name: "Ana Silva", civl_id: "99999" }], [
      ranked(12, "25161", "Ana Silva"),
    ]);
    expect(result.matches[0]).toBeUndefined();
  });
});

describe("matchList — a list that places nobody", () => {
  test("still reports itself, with zero counts", () => {
    const result = matchList(HG, [{ name: "Ana Silva", civl_id: null }], []);
    expect(result).toMatchObject({
      slug: "hang-gliding-class-1-xc",
      name: "HG Class 1",
      ranking_date: "2026-07-01",
      matched_count: 0,
      rankable_count: 0,
    });
  });
});

describe("nameKey", () => {
  test("normalises case and whitespace only", () => {
    expect(nameKey("  Ana   SILVA\t")).toBe("ana silva");
    expect(nameKey("José")).toBe("josé");
  });
});

describe("defaultListSlug", () => {
  const list = (
    slug: string,
    matched_count: number
  ): ListMatches => ({
    slug,
    name: slug,
    ranking_date: "2026-07-01",
    matches: {},
    matched_count,
    rankable_count: 0,
  });

  test("prefers the comp's own discipline over a bigger match elsewhere", () => {
    // A hang gliding comp defaults to a hang gliding list even when more of
    // its pilots happen to be ranked in a paragliding one.
    const slug = defaultListSlug(
      [list("hang-gliding-class-1-xc", 3), list("paragliding-xc", 9)],
      "hg"
    );
    expect(slug).toBe("hang-gliding-class-1-xc");
  });

  test("within the discipline, the list that places the most pilots wins", () => {
    const slug = defaultListSlug(
      [
        list("hang-gliding-class-1-xc", 4),
        list("hang-gliding-class-1-sport-xc", 18),
      ],
      "hg"
    );
    expect(slug).toBe("hang-gliding-class-1-sport-xc");
  });

  test("falls back across disciplines rather than offering an empty list", () => {
    const slug = defaultListSlug(
      [list("hang-gliding-class-1-xc", 0), list("paragliding-xc", 6)],
      "hg"
    );
    expect(slug).toBe("paragliding-xc");
  });

  test("with no matches anywhere it still opens on the right discipline", () => {
    const slug = defaultListSlug(
      [list("paragliding-xc", 0), list("hang-gliding-class-1-xc", 0)],
      "hg"
    );
    expect(slug).toBe("hang-gliding-class-1-xc");
  });

  test("no lists held at all", () => {
    expect(defaultListSlug([], "pg")).toBeNull();
  });
});
