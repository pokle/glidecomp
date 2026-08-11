// Copyright (c) 2026, Tushar Pokle.  All rights reserved.
import { describe, expect, test } from "bun:test";
import {
  airscoreCompUrl,
  airscoreTaskUrl,
  parseCuratedOfficialRows,
  parseRawOfficialRows,
} from "./official-results";

/** A verbatim-shaped result row: rank, id, name anchor, …, dist at 10, total last. */
function rawRow(rank: string, name: string, dist: unknown, total: unknown): unknown[] {
  return [
    rank,
    "199213",
    `<a href="tracklog_map.html?trackid=1&comPk=466&tasPk=2027">${name}</a>`,
    "AUS",
    "Glider",
    "C",
    "15:45:00",
    "17:01:18",
    "1:16:18",
    "",
    dist,
    0,
    0,
    629.2,
    361.2,
    "",
    total,
  ];
}

describe("parseRawOfficialRows", () => {
  test("reads rank, name and total from published rows", () => {
    const rows = parseRawOfficialRows({
      data: [
        rawRow("<b>1</b>", "Olav Opsanger", 67.54, 990),
        rawRow("<b>2</b>", "Rohan Holtkamp", 67.54, 890),
      ],
    });
    expect(rows).toEqual([
      { name: "Olav Opsanger", rank: 1, total: 990 },
      { name: "Rohan Holtkamp", rank: 2, total: 890 },
    ]);
  });

  test("keeps published tie ranks verbatim (repeat, then skip)", () => {
    const rows = parseRawOfficialRows({
      data: [
        rawRow("<b>34</b>", "John Harriott", 0.09, 38),
        rawRow("<b>36</b>", "Airie Merlin", 67.54, 0),
        rawRow("<b>36</b>", "Brett Davis", 0.41, 0),
      ],
    });
    expect(rows.map((r) => r.rank)).toEqual([34, 36, 36]);
  });

  test("drops absent rows and rank-0 DNF rows", () => {
    const rows = parseRawOfficialRows({
      data: [
        rawRow("<b>1</b>", "Flew Fine", 50, 900),
        rawRow("<b>0</b>", "James McGinty", "dnf", 0),
        rawRow("<b>9</b>", "Stayed Home", "abs", 0),
      ],
    });
    expect(rows).toEqual([{ name: "Flew Fine", rank: 1, total: 900 }]);
  });

  test("tolerates a missing or empty data array", () => {
    expect(parseRawOfficialRows({})).toEqual([]);
    expect(parseRawOfficialRows({ data: null })).toEqual([]);
  });
});

describe("parseCuratedOfficialRows", () => {
  test("derives competition ranks from totals, ties sharing a rank", () => {
    const rows = parseCuratedOfficialRows({
      pilots: [
        { name: "Stuart McElroy", total: 68 },
        { name: "Jon Durand", total: 1000 },
        { name: "Tied One", total: 500 },
        { name: "Tied Two", total: 500 },
        { name: "After Ties", total: 400 },
      ],
    });
    expect(rows).toEqual([
      { name: "Jon Durand", rank: 1, total: 1000 },
      { name: "Tied One", rank: 2, total: 500 },
      { name: "Tied Two", rank: 2, total: 500 },
      { name: "After Ties", rank: 4, total: 400 },
      { name: "Stuart McElroy", rank: 5, total: 68 },
    ]);
  });

  test("tolerates a missing pilots array and junk entries", () => {
    expect(parseCuratedOfficialRows({})).toEqual([]);
    expect(
      parseCuratedOfficialRows({ pilots: [{ name: "", total: 3 }, { name: "X" }] }),
    ).toEqual([]);
  });
});

describe("AirScore URLs", () => {
  test("builds the comp and task scores page URLs from the manifest keys", () => {
    expect(airscoreCompUrl("https://xc.highcloud.net", 466)).toBe(
      "https://xc.highcloud.net/comp_overall.html?comPk=466",
    );
    expect(airscoreTaskUrl("https://xc.highcloud.net", 466, 2027)).toBe(
      "https://xc.highcloud.net/task_result.html?comPk=466&tasPk=2027",
    );
  });
});
