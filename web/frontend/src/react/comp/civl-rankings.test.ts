import { describe, expect, it } from "vitest";
import {
  fillCivlIds,
  fillRankings,
  pilotDetails,
  formatRankingMonth,
  listLabel,
  rankingSource,
  type RankingList,
  type RowMatch,
} from "./civl-rankings";
import { emptyRow, type ParsedRow } from "./csv";

/**
 * What the two fill buttons do to the grid. The matching itself is the
 * server's (civl-ranking-match.ts); these cover the half an organiser can see
 * — which cells move, which are left exactly as they were, and what the
 * roster then says about where a number came from.
 */

function row(overrides: Partial<ParsedRow> = {}): ParsedRow {
  return { ...emptyRow([]), name: "Jane Doe", pilot_class: "open", ...overrides };
}

const HG_LIST = (matches: Record<number, RowMatch>): RankingList => ({
  slug: "hang-gliding-class-1-xc",
  name: "HG Class 1",
  ranking_date: "2026-07-01",
  matches,
  matched_count: Object.keys(matches).length,
  rankable_count: Object.values(matches).filter((m) => m.matched_by === "civl_id")
    .length,
});

const byName = (civl_id: string, rank: number): RowMatch => ({
  matched_by: "name",
  civl_id,
  pilot_name: "Jane Doe",
  rank,
  points: 100,
});

const byId = (civl_id: string, rank: number): RowMatch => ({
  matched_by: "civl_id",
  civl_id,
  pilot_name: "Jane Doe",
  rank,
  points: 100,
});

describe("fillCivlIds", () => {
  it("fills an empty cell from a name match", () => {
    const outcome = fillCivlIds([row()], HG_LIST({ 0: byName("25161", 12) }));
    expect(outcome.rows[0].civl_id).toBe("25161");
    expect(outcome.filled).toBe(1);
  });

  it("never overwrites an ID that is already there", () => {
    // An id in the grid is somebody's deliberate answer.
    const outcome = fillCivlIds(
      [row({ civl_id: "99999" })],
      HG_LIST({ 0: byName("25161", 12) })
    );
    expect(outcome.rows[0].civl_id).toBe("99999");
    expect(outcome.filled).toBe(0);
  });

  it("leaves unmatched rows untouched", () => {
    const before = row();
    const outcome = fillCivlIds([before], HG_LIST({}));
    expect(outcome.rows[0]).toEqual(before);
    expect(outcome.filled).toBe(0);
  });

  it("does not touch the ranking column", () => {
    // A name match knows a rank, but a name is not allowed to decide one.
    const outcome = fillCivlIds([row()], HG_LIST({ 0: byName("25161", 12) }));
    expect(outcome.rows[0].civl_ranking).toBeNull();
  });
});

describe("fillRankings", () => {
  it("copies the rank with the list and month it came from", () => {
    const outcome = fillRankings(
      [row({ civl_id: "25161" })],
      HG_LIST({ 0: byId("25161", 12) })
    );
    expect(outcome.rows[0]).toMatchObject({
      civl_ranking: "12",
      civl_ranking_slug: "hang-gliding-class-1-xc",
      civl_ranking_date: "2026-07-01",
    });
    expect(outcome.filled).toBe(1);
  });

  it("ignores a name match — a rank follows the CIVL ID only", () => {
    // This is why the buttons are used in order: fill the ids, then the ranks.
    const outcome = fillRankings([row()], HG_LIST({ 0: byName("25161", 12) }));
    expect(outcome.rows[0].civl_ranking).toBeNull();
    expect(outcome.filled).toBe(0);
    expect(outcome.skipped).toBe(1);
  });

  it("replaces an earlier rank, source and all", () => {
    // The button means "use what CIVL published", including over a rank
    // filled from a different list a moment ago.
    const outcome = fillRankings(
      [
        row({
          civl_id: "25161",
          civl_ranking: "40",
          civl_ranking_slug: "hang-gliding-class-1-sport-xc",
          civl_ranking_date: "2026-06-01",
        }),
      ],
      HG_LIST({ 0: byId("25161", 12) })
    );
    expect(outcome.rows[0]).toMatchObject({
      civl_ranking: "12",
      civl_ranking_slug: "hang-gliding-class-1-xc",
      civl_ranking_date: "2026-07-01",
    });
  });

  it("counts the rows it left alone", () => {
    const outcome = fillRankings(
      [row({ civl_id: "25161" }), row({ name: "Bob" }), row({ civl_id: "70001" })],
      HG_LIST({ 0: byId("25161", 12) })
    );
    expect(outcome.filled).toBe(1);
    expect(outcome.skipped).toBe(2);
  });
});

describe("rankingSource", () => {
  it("names the list and the month for an imported rank", () => {
    expect(
      rankingSource({
        civl_ranking: 12,
        civl_ranking_slug: "hang-gliding-class-1-xc",
        civl_ranking_date: "2026-07-01",
      })
    ).toBe("HG Class 1 · Jul 2026");
  });

  it("says a hand-set rank is hand-set rather than leaving it bare", () => {
    expect(
      rankingSource({
        civl_ranking: 30,
        civl_ranking_slug: null,
        civl_ranking_date: null,
      })
    ).toBe("set by organiser");
  });

  it("says nothing at all when there is no rank", () => {
    expect(
      rankingSource({
        civl_ranking: null,
        civl_ranking_slug: null,
        civl_ranking_date: null,
      })
    ).toBe("");
  });
});

describe("formatRankingMonth", () => {
  it("reads an ISO snapshot date as a month", () => {
    expect(formatRankingMonth("2026-07-01")).toBe("Jul 2026");
    expect(formatRankingMonth("2026-01-01")).toBe("Jan 2026");
    expect(formatRankingMonth("2025-12-01")).toBe("Dec 2025");
  });

  it("is empty for no date and passes anything unexpected through", () => {
    expect(formatRankingMonth(null)).toBe("");
    expect(formatRankingMonth("not-a-date")).toBe("not-a-date");
  });
});

describe("listLabel", () => {
  it("labels the lists with CIVL's own names", () => {
    // Taken from a real import's ranking_name column, not guessed from the
    // slug: the picker shows the snapshot's name and the roster shows this
    // one, so "paragliding-accuracy" has to be "PGA" in both.
    expect(listLabel("paragliding-xc")).toBe("PG XC");
    expect(listLabel("hang-gliding-class-1-sport-xc")).toBe("HG Class 1 Sport");
    expect(listLabel("paragliding-accuracy")).toBe("PGA");
    expect(listLabel("paragliding-aerobatics")).toBe("PG Acro Solo");
  });

  it("makes an unknown list readable rather than dropping it", () => {
    // CIVL adding an eleventh list must not blank out a stored ranking's source.
    expect(listLabel("paragliding-speed-run")).toBe("Paragliding Speed Run");
  });
});

describe("pilotDetails", () => {
  const picked = {
    civl_id: "2231",
    pilot_name: "Jonny Durand",
    rank: 7,
    points: 281,
    nation: "Australia",
    ranking_slug: "hang-gliding-class-1-xc",
    ranking_date: "2026-08-01",
  };

  it("brings the id, the rank, and where the rank came from", () => {
    expect(pilotDetails(picked)).toEqual({
      name: "Jonny Durand",
      civl_id: "2231",
      civl_ranking: "7",
      civl_ranking_slug: "hang-gliding-class-1-xc",
      civl_ranking_date: "2026-08-01",
    });
  });

  it("takes CIVL's spelling of the name, not the organiser's", () => {
    // The half-typed "Durand" that opened the list is replaced by the full
    // name, which is what makes the NEXT lookup match this row by name too.
    expect(pilotDetails(picked).name).toBe("Jonny Durand");
  });

  it("writes the rank as the string the grid's cells hold", () => {
    // ParsedRow is the spreadsheet's shape: every cell is text, so a number
    // here would compare unequal to a typed one and re-render oddly.
    expect(pilotDetails(picked).civl_ranking).toBe("7");
  });
});
