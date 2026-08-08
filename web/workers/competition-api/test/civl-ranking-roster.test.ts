import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { env } from "cloudflare:test";
import { authRequest, clearCompData, createComp, request } from "./helpers";

/**
 * The roster's CIVL ranking: the column organisers set a launch order from,
 * and the lookup that fills it from `pilot_ranking`.
 *
 * The number is COPIED onto comp_pilot rather than read live (migration 0029),
 * so these tests care about two things: that a stored rank keeps the list and
 * month it came from, and that the lookup only ever offers what the matching
 * rules allow.
 */

async function seedRanking(rows: {
  slug?: string;
  name?: string;
  date?: string;
  rank: number;
  civlId: string;
  pilotName: string;
  /** WPRS score. Defaults to a function of rank; pass it where a test needs
   *  points and rank to DISAGREE, which is the whole point of the rule. */
  points?: number;
}[]): Promise<void> {
  for (const r of rows) {
    await env.DB.prepare(
      `INSERT INTO pilot_ranking
         (ranking_slug, civl_ranking_id, ranking_date, ranking_name, region,
          selection, "rank", civl_id, pilot_name, gender, nation, points, fetched_at)
       VALUES (?, 1914, ?, ?, 'World', 'Overall', ?, ?, ?, 'M', 'Australia', ?, '2026-07-29T00:00:00Z')`
    )
      .bind(
        r.slug ?? "hang-gliding-class-1-xc",
        r.date ?? "2026-07-01",
        r.name ?? "HG Class 1",
        r.rank,
        r.civlId,
        r.pilotName,
        r.points ?? 1000 - r.rank
      )
      .run();
  }
}

interface Lookup {
  matches: Record<
    string,
    {
      matched_by: string;
      civl_id: string;
      rank: number;
      ranking_slug: string;
      ranking_name: string;
      ranking_date: string;
    }
  >;
  matched_count: number;
  rankable_count: number;
}

async function lookup(
  compId: string,
  pilots: { name: string; civl_id?: string | null }[]
): Promise<Lookup> {
  const res = await authRequest(
    "POST",
    `/api/comp/${compId}/pilot/civl-rankings`,
    { pilots }
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Lookup;
}

beforeEach(async () => {
  await clearCompData();
  await env.DB.prepare("DELETE FROM pilot_ranking").run();
});
afterEach(async () => {
  await clearCompData();
  await env.DB.prepare("DELETE FROM pilot_ranking").run();
});

describe("comp_pilot.wprs_points round trip", () => {
  test("a score stores the list and month it came from", async () => {
    const compId = await createComp();
    const res = await authRequest("POST", `/api/comp/${compId}/pilot`, {
      registered_pilot_name: "Ana Silva",
      pilot_class: "open",
      wprs_points: 261.5,
      civl_ranking_slug: "hang-gliding-class-1-xc",
      civl_ranking_date: "2026-07-01",
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as Record<string, unknown>;
    expect(created.wprs_points).toBe(261.5);
    expect(created.civl_ranking_slug).toBe("hang-gliding-class-1-xc");
    expect(created.civl_ranking_date).toBe("2026-07-01");

    // And it survives a read, which is what the pilots table renders from.
    const list = await request("GET", `/api/comp/${compId}/pilot`, {
      user: "user-1",
    });
    const { pilots } = (await list.json()) as { pilots: Record<string, unknown>[] };
    expect(pilots[0].wprs_points).toBe(261.5);
    expect(pilots[0].civl_ranking_date).toBe("2026-07-01");
  });

  test("an organiser's hand override drops the source", async () => {
    // A score CIVL never published must not keep CIVL's name and month on it
    // — that is the difference the roster shows as "set by organiser".
    const compId = await createComp();
    const created = await authRequest("POST", `/api/comp/${compId}/pilot`, {
      registered_pilot_name: "Ana Silva",
      pilot_class: "open",
      wprs_points: 261.5,
      civl_ranking_slug: "hang-gliding-class-1-xc",
      civl_ranking_date: "2026-07-01",
    });
    const { comp_pilot_id } = (await created.json()) as { comp_pilot_id: string };

    const patched = await authRequest(
      "PATCH",
      `/api/comp/${compId}/pilot/${comp_pilot_id}`,
      { wprs_points: 300 }
    );
    const after = (await patched.json()) as Record<string, unknown>;
    expect(after.wprs_points).toBe(300);
    expect(after.civl_ranking_slug).toBeNull();
    expect(after.civl_ranking_date).toBeNull();
  });

  test("changing a score is audit-logged with both values", async () => {
    const compId = await createComp();
    const created = await authRequest("POST", `/api/comp/${compId}/pilot`, {
      registered_pilot_name: "Ana Silva",
      pilot_class: "open",
      wprs_points: 261.5,
    });
    const { comp_pilot_id } = (await created.json()) as { comp_pilot_id: string };
    await authRequest("PATCH", `/api/comp/${compId}/pilot/${comp_pilot_id}`, {
      wprs_points: 300,
    });

    const log = await request("GET", `/api/comp/${compId}/audit`, { user: "user-1" });
    const { entries } = (await log.json()) as { entries: { description: string }[] };
    const scored = entries.find((e) => e.description.includes("WPRS points"));
    expect(scored?.description).toContain("Ana Silva");
    expect(scored?.description).toContain("261.5");
    expect(scored?.description).toContain("300");
  });

  test("the bulk save round-trips the score and its source", async () => {
    const compId = await createComp();
    const res = await authRequest("POST", `/api/comp/${compId}/pilot/bulk`, {
      pilots: [
        {
          registered_pilot_name: "Ana Silva",
          pilot_class: "open",
          wprs_points: 261.5,
          civl_ranking_slug: "hang-gliding-class-1-xc",
          civl_ranking_date: "2026-07-01",
        },
      ],
    });
    expect(res.status).toBe(200);
    const { pilots } = (await res.json()) as { pilots: Record<string, unknown>[] };
    expect(pilots[0].wprs_points).toBe(261.5);
    expect(pilots[0].civl_ranking_slug).toBe("hang-gliding-class-1-xc");
  });

  test("a score that is not a positive number is refused", async () => {
    const compId = await createComp();
    const res = await authRequest("POST", `/api/comp/${compId}/pilot`, {
      registered_pilot_name: "Ana Silva",
      pilot_class: "open",
      wprs_points: 0,
    });
    expect(res.status).toBe(400);
  });

  test("the decimal CIVL publishes survives the round trip", async () => {
    // 261.5 and 261.4 are two different pilots near the top of a list; an
    // integer column would have merged them.
    const compId = await createComp();
    const res = await authRequest("POST", `/api/comp/${compId}/pilot`, {
      registered_pilot_name: "Ana Silva",
      pilot_class: "open",
      wprs_points: 261.5,
    });
    const created = (await res.json()) as Record<string, unknown>;
    expect(created.wprs_points).toBe(261.5);
  });

  test("a source list that is not a CIVL slug is refused", async () => {
    // The slug is rendered as the provenance of a published number, so it may
    // not be arbitrary text an import decided on.
    const compId = await createComp();
    const res = await authRequest("POST", `/api/comp/${compId}/pilot`, {
      registered_pilot_name: "Ana Silva",
      pilot_class: "open",
      wprs_points: 261.5,
      civl_ranking_slug: "Trust me bro",
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/comp/:comp_id/pilot/civl-rankings", () => {
  test("answers about the roster in the BODY, not the stored one", async () => {
    // The grid is mid-edit when the organiser presses fill; the pilot below
    // has never been saved.
    const compId = await createComp();
    await seedRanking([{ rank: 12, civlId: "25161", pilotName: "Ana Silva" }]);

    const { matches } = await lookup(compId, [
      { name: "Ana Silva", civl_id: "25161" },
    ]);
    expect(matches["0"]).toMatchObject({ matched_by: "civl_id", rank: 12 });
  });

  test("offers an id for an unambiguous name, and no rank with it", async () => {
    const compId = await createComp();
    await seedRanking([{ rank: 12, civlId: "25161", pilotName: "Ana Silva" }]);

    const { matches, matched_count, rankable_count } = await lookup(compId, [
      { name: "ana silva", civl_id: null },
    ]);
    expect(matches["0"]).toMatchObject({ matched_by: "name", civl_id: "25161" });
    expect(matched_count).toBe(1);
    expect(rankable_count).toBe(0);
  });

  test("takes a pilot from the list where they score the most WPRS points", async () => {
    // The rule this endpoint exists to apply: CIVL publishes no overall
    // ranking, so a pilot in two lists needs one chosen. Points are the same
    // quantity in every list; a rank is only a position within one pool, and
    // a small pool flatters. Here #1 in the Sport list on 120 points loses to
    // #106 in PG XC on 261.5.
    const compId = await createComp({ category: "hg" });
    await seedRanking([
      { rank: 106, civlId: "25161", pilotName: "Luke Nicol", points: 261.5 },
      {
        slug: "paragliding-xc-sport",
        name: "PG XC Sport",
        rank: 1,
        civlId: "25161",
        pilotName: "Luke Nicol",
        points: 120,
      },
    ]);

    const { matches } = await lookup(compId, [
      { name: "Luke Nicol", civl_id: "25161" },
    ]);
    expect(matches["0"]).toMatchObject({
      rank: 106,
      points: 261.5,
      ranking_slug: "hang-gliding-class-1-xc",
      ranking_name: "HG Class 1",
    });
  });

  test("each match carries ITS OWN list, so one roster can span several", async () => {
    const compId = await createComp();
    await seedRanking([
      { rank: 12, civlId: "25161", pilotName: "Ana Silva" },
      {
        slug: "paragliding-xc",
        name: "PG XC",
        rank: 3,
        civlId: "70001",
        pilotName: "Someone Else",
      },
    ]);

    const { matches, matched_count } = await lookup(compId, [
      { name: "Ana Silva", civl_id: "25161" },
      { name: "Someone Else", civl_id: "70001" },
    ]);
    expect(matched_count).toBe(2);
    expect(matches["0"].ranking_name).toBe("HG Class 1");
    expect(matches["1"].ranking_name).toBe("PG XC");
  });

  test("only the newest snapshot of a list is matched against", async () => {
    // The importer writes the new month before deleting the old one, so the
    // table transiently holds both. Last month's rank is one the pilot no
    // longer holds — and, being lower, would otherwise win outright.
    const compId = await createComp();
    await seedRanking([
      { date: "2026-06-01", rank: 4, civlId: "25161", pilotName: "Ana Silva" },
      { date: "2026-07-01", rank: 12, civlId: "25161", pilotName: "Ana Silva" },
    ]);

    const { matches } = await lookup(compId, [
      { name: "Ana Silva", civl_id: "25161" },
    ]);
    expect(matches["0"]).toMatchObject({ rank: 12, ranking_date: "2026-07-01" });
  });

  test("a full-sized roster does not blow D1's bound-parameter limit", async () => {
    // The regression: D1 rejects a statement with more than 100 bound
    // parameters, and the lookup binds one per name PLUS one per id. A
    // 64-pilot roster passed on the first press and 500'd on the second —
    // after the ids had been filled in, which is the only time it can happen.
    const compId = await createComp();
    const pilots = Array.from({ length: 120 }, (_, i) => ({
      name: `Pilot Number ${i}`,
      civl_id: `80${String(i).padStart(4, "0")}`,
    }));
    await seedRanking(
      pilots.map((p, i) => ({ rank: i + 1, civlId: p.civl_id, pilotName: p.name }))
    );

    const { matches, matched_count, rankable_count } = await lookup(compId, pilots);
    expect(matched_count).toBe(120);
    expect(rankable_count).toBe(120);
    expect(matches["119"]).toMatchObject({ rank: 120 });
  });

  test("a pilot matched by BOTH id and name is not mistaken for two people", async () => {
    // The id chunk and the name chunk each return that row; a duplicate left
    // in place reads as two ranked pilots sharing a name, which the matcher
    // refuses — so a correct roster would silently stop matching.
    const compId = await createComp();
    await seedRanking([{ rank: 12, civlId: "25161", pilotName: "Ana Silva" }]);

    const { matches } = await lookup(compId, [
      { name: "Ana Silva", civl_id: "25161" },
    ]);
    expect(matches["0"]).toMatchObject({ matched_by: "civl_id", rank: 12 });
  });

  test("with nothing imported it answers empty rather than failing", async () => {
    const compId = await createComp();
    const result = await lookup(compId, [{ name: "Ana Silva" }]);
    expect(result).toEqual({ matches: {}, matched_count: 0, rankable_count: 0 });
  });

  test("a non-admin cannot read it", async () => {
    const compId = await createComp();
    await seedRanking([{ rank: 12, civlId: "25161", pilotName: "Ana Silva" }]);
    const res = await request("POST", `/api/comp/${compId}/pilot/civl-rankings`, {
      body: { pilots: [{ name: "Ana Silva" }] },
      user: "user-2",
    });
    expect(res.status).toBe(403);
  });

  test("anonymous is refused", async () => {
    const compId = await createComp();
    const res = await request("POST", `/api/comp/${compId}/pilot/civl-rankings`, {
      body: { pilots: [{ name: "Ana Silva" }] },
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/comp/:comp_id/pilot/civl-search", () => {
  async function search(
    compId: string,
    q: string
  ): Promise<{ pilots: { civl_id: string; rank: number; ranking_name: string; nation: string }[] }> {
    const res = await authRequest(
      "GET",
      `/api/comp/${compId}/pilot/civl-search?q=${encodeURIComponent(q)}`
    );
    expect(res.status).toBe(200);
    return (await res.json()) as {
      pilots: { civl_id: string; rank: number; ranking_name: string; nation: string }[];
    };
  }

  test("offers a pilot ONCE, with the same number the fill would give them", async () => {
    // The typeahead and the button have to agree: suggesting a per-list rank
    // here while the button filled the best-scoring list's would put two
    // different numbers in front of the organiser for one pilot.
    const compId = await createComp();
    await seedRanking([
      { rank: 106, civlId: "25161", pilotName: "Luke Nicol", points: 261.5 },
      {
        slug: "paragliding-xc-sport",
        name: "PG XC Sport",
        rank: 1,
        civlId: "25161",
        pilotName: "Luke Nicol",
        points: 120,
      },
    ]);

    const { pilots } = await search(compId, "Luke");
    expect(pilots).toHaveLength(1);
    expect(pilots[0]).toMatchObject({
      civl_id: "25161",
      rank: 106,
      ranking_name: "HG Class 1",
    });
  });

  test("two different humans of one name are two suggestions", async () => {
    // Unlike the fill, which refuses an ambiguous name outright: here a human
    // chooses, and their nation and rank are what tell the two apart.
    const compId = await createComp();
    await seedRanking([
      { rank: 20, civlId: "1001", pilotName: "John Smith" },
      { slug: "paragliding-xc", name: "PG XC", rank: 51, civlId: "1002", pilotName: "John Smith" },
    ]);

    const { pilots } = await search(compId, "john smith");
    expect(pilots.map((p) => p.civl_id).sort()).toEqual(["1001", "1002"]);
  });

  test("last month's rank is never suggested", async () => {
    const compId = await createComp();
    await seedRanking([
      { date: "2026-06-01", rank: 4, civlId: "25161", pilotName: "Ana Silva" },
      { date: "2026-07-01", rank: 12, civlId: "25161", pilotName: "Ana Silva" },
    ]);

    const { pilots } = await search(compId, "Ana");
    expect(pilots).toHaveLength(1);
    expect(pilots[0].rank).toBe(12);
  });

  test("a name containing LIKE's own wildcards is matched literally", async () => {
    const compId = await createComp();
    await seedRanking([
      { rank: 5, civlId: "3001", pilotName: "100% Nutty" },
      { rank: 6, civlId: "3002", pilotName: "Someone Else" },
    ]);

    const { pilots } = await search(compId, "100%");
    expect(pilots.map((p) => p.civl_id)).toEqual(["3001"]);
  });

  test("a non-admin cannot read it", async () => {
    const compId = await createComp();
    const res = await request(
      "GET",
      `/api/comp/${compId}/pilot/civl-search?q=Ana`,
      { user: "user-2" }
    );
    expect(res.status).toBe(403);
  });
});
