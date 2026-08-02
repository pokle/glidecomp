import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { request } from "./helpers";

/**
 * `/api/civl-rankings.csv` — the dump behind the root-level `/civl-rankings.csv`
 * verification hatch. It has no UI, so these tests are the only description of
 * what it promises: the whole table, in a stable order, as valid CSV.
 */

interface Row {
  slug: string;
  date: string;
  rankingId: number;
  rank: number;
  civlId: string;
  name: string;
  gender?: string;
  nation?: string;
  points?: number;
}

async function insert(rows: Row[]): Promise<void> {
  for (const r of rows) {
    await env.DB.prepare(
      `INSERT INTO pilot_ranking
         (ranking_slug, civl_ranking_id, ranking_date, ranking_name, region,
          selection, "rank", civl_id, pilot_name, gender, nation, points, fetched_at)
       VALUES (?, ?, ?, 'HG Class 1', 'World', 'Overall', ?, ?, ?, ?, ?, ?, '2026-07-29T00:00:00Z')`
    )
      .bind(
        r.slug,
        r.rankingId,
        r.date,
        r.rank,
        r.civlId,
        r.name,
        r.gender ?? "M",
        r.nation ?? "Italy",
        r.points ?? 0
      )
      .run();
  }
}

/** Fetch the dump. A fresh query string per call keeps the edge cache — which
 *  the route deliberately uses — from answering with a previous test's table. */
let bust = 0;
async function dump(query = ""): Promise<{ res: Response; lines: string[] }> {
  const sep = query ? "&" : "?";
  const res = await request("GET", `/api/civl-rankings.csv${query}${sep}t=${bust++}`);
  const text = await res.text();
  return { res, lines: text.split("\n").filter((l) => l.length > 0) };
}

const HEADER =
  "ranking_slug,ranking_name,region,selection,ranking_date,civl_ranking_id," +
  "rank,civl_id,pilot_name,gender,nation,points,fetched_at";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM pilot_ranking").run();
});

describe("GET /api/civl-rankings.csv", () => {
  test("serves a header row even when the table is empty", async () => {
    const { res, lines } = await dump();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toContain("civl-rankings.csv");
    // A dump of pilots' names and nations is not something to hand a crawler.
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
    expect(lines).toEqual([HEADER]);
  });

  test("returns every row, ordered by list then date then rank", async () => {
    await insert([
      { slug: "paragliding-xc", date: "2026-07-01", rankingId: 1913, rank: 2, civlId: "20", name: "Second PG" },
      { slug: "hang-gliding-class-1-xc", date: "2026-07-01", rankingId: 1914, rank: 3, civlId: "3", name: "Third" },
      { slug: "paragliding-xc", date: "2026-07-01", rankingId: 1913, rank: 1, civlId: "10", name: "First PG" },
      { slug: "hang-gliding-class-1-xc", date: "2026-07-01", rankingId: 1914, rank: 1, civlId: "1", name: "First" },
    ]);
    const { lines } = await dump();
    expect(lines).toHaveLength(5);
    expect(lines.slice(1).map((l) => l.split(",")[8])).toEqual([
      "First",
      "Third",
      "First PG",
      "Second PG",
    ]);
  });

  test("ties on rank are ordered by CIVL id, so the dump is stable", async () => {
    // Rank ties are pervasive in the real lists, so without a final
    // tiebreak two dumps of the same table could differ.
    await insert([
      { slug: "hang-gliding-class-1-xc", date: "2026-07-01", rankingId: 1914, rank: 695, civlId: "95565", name: "B" },
      { slug: "hang-gliding-class-1-xc", date: "2026-07-01", rankingId: 1914, rank: 695, civlId: "9854", name: "A" },
    ]);
    const first = await dump();
    const second = await dump();
    expect(first.lines).toEqual(second.lines);
    // Lexical, not numeric: civl_id is TEXT (to match pilot.civl_id and
    // comp_pilot.registered_pilot_civl_id, both TEXT), so "95565" sorts before
    // "9854". Only determinism matters here, but the order will surprise
    // anyone eyeballing the file.
    expect(first.lines[1]).toContain(",95565,");
    expect(first.lines[2]).toContain(",9854,");
  });

  test("emits every stored column", async () => {
    await insert([
      {
        slug: "hang-gliding-class-1-xc",
        date: "2026-07-01",
        rankingId: 1914,
        rank: 1,
        civlId: "25161",
        name: "Marco Laurenzi",
        points: 339.3,
      },
    ]);
    const { lines } = await dump();
    expect(lines[1]).toBe(
      "hang-gliding-class-1-xc,HG Class 1,World,Overall,2026-07-01,1914,1,25161," +
        "Marco Laurenzi,M,Italy,339.3,2026-07-29T00:00:00Z"
    );
  });

  test("quotes values containing a comma or a quote", async () => {
    // Both occur for real: "Korea, Republic of" is a nation in the HG Class 1
    // list. An unquoted comma silently shifts every later column.
    await insert([
      {
        slug: "hang-gliding-class-1-xc",
        date: "2026-07-01",
        rankingId: 1914,
        rank: 1,
        civlId: "17615",
        name: 'Daeyoun "Dae" Hwang',
        nation: "Korea, Republic of",
      },
    ]);
    const { lines } = await dump();
    expect(lines[1]).toContain('"Korea, Republic of"');
    expect(lines[1]).toContain('"Daeyoun ""Dae"" Hwang"');
  });

  test("guards a formula-looking name against CSV/DDE injection", async () => {
    // civlcomps.org's export is copied verbatim (see module header) and this
    // route is public/unauthenticated, so a name starting with =/+/-/@ must
    // never reach the downloaded CSV unguarded — Excel/Sheets would read it
    // as a formula the moment the file is opened.
    await insert([
      { slug: "hang-gliding-class-1-xc", date: "2026-07-01", rankingId: 1914, rank: 1, civlId: "1", name: "=SUM(A1:A9)" },
    ]);
    const { lines } = await dump();
    const nameCell = lines[1].split(",")[8];
    expect(nameCell).toBe("'=SUM(A1:A9)");
  });

  test("keeps non-ASCII names intact", async () => {
    await insert([
      {
        slug: "hang-gliding-class-1-xc",
        date: "2026-07-01",
        rankingId: 1914,
        rank: 695,
        civlId: "95565",
        name: "Francisco (Patxi) García González",
      },
    ]);
    const { lines } = await dump();
    expect(lines[1]).toContain("Francisco (Patxi) García González");
  });

  test("?slug= narrows the dump to one list", async () => {
    await insert([
      { slug: "hang-gliding-class-1-xc", date: "2026-07-01", rankingId: 1914, rank: 1, civlId: "1", name: "HG" },
      { slug: "paragliding-xc", date: "2026-07-01", rankingId: 1913, rank: 1, civlId: "2", name: "PG" },
    ]);
    const { lines } = await dump("?slug=paragliding-xc");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("PG");
  });

  test("an unknown slug is an empty dump, not an error", async () => {
    await insert([
      { slug: "hang-gliding-class-1-xc", date: "2026-07-01", rankingId: 1914, rank: 1, civlId: "1", name: "HG" },
    ]);
    const { res, lines } = await dump("?slug=not-a-list");
    expect(res.status).toBe(200);
    expect(lines).toEqual([HEADER]);
  });

  test("is readable anonymously", async () => {
    // Every row is a verbatim copy of a list anyone can download from
    // civlcomps.org, so there is nothing here to gate.
    const { res } = await dump();
    expect(res.status).toBe(200);
  });

  test("streams past one page of rows", async () => {
    // PAGE_SIZE is 2000 in the route; the real PG XC list is ~6.9k rows, so
    // the paging loop is not an edge case. 2001 rows exercises the boundary
    // and the short final page in one go.
    const rows: Row[] = Array.from({ length: 2001 }, (_, i) => ({
      slug: "paragliding-xc",
      date: "2026-07-01",
      rankingId: 1913,
      rank: i + 1,
      civlId: String(100000 + i),
      name: `Pilot ${i + 1}`,
    }));
    const stmt = env.DB.prepare(
      `INSERT INTO pilot_ranking
         (ranking_slug, civl_ranking_id, ranking_date, ranking_name, region,
          selection, "rank", civl_id, pilot_name, gender, nation, points, fetched_at)
       VALUES (?, ?, ?, 'PG XC', 'World', 'Overall', ?, ?, ?, 'M', 'France', 0, '2026-07-29T00:00:00Z')`
    );
    await env.DB.batch(
      rows.map((r) => stmt.bind(r.slug, r.rankingId, r.date, r.rank, r.civlId, r.name))
    );

    const { lines } = await dump();
    expect(lines).toHaveLength(2002);
    expect(lines[1]).toContain("Pilot 1,");
    expect(lines.at(-1)).toContain("Pilot 2001,");
  });
});
