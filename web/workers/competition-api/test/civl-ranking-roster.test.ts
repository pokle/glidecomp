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
        1000 - r.rank
      )
      .run();
  }
}

interface LookupList {
  slug: string;
  name: string;
  ranking_date: string;
  matched_count: number;
  rankable_count: number;
  matches: Record<string, { matched_by: string; civl_id: string; rank: number }>;
}

async function lookup(
  compId: string,
  pilots: { name: string; civl_id?: string | null }[]
): Promise<{ lists: LookupList[]; default_slug: string | null }> {
  const res = await authRequest(
    "POST",
    `/api/comp/${compId}/pilot/civl-rankings`,
    { pilots }
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { lists: LookupList[]; default_slug: string | null };
}

beforeEach(async () => {
  await clearCompData();
  await env.DB.prepare("DELETE FROM pilot_ranking").run();
});
afterEach(async () => {
  await clearCompData();
  await env.DB.prepare("DELETE FROM pilot_ranking").run();
});

describe("comp_pilot.civl_ranking round trip", () => {
  test("a rank stores the list and month it came from", async () => {
    const compId = await createComp();
    const res = await authRequest("POST", `/api/comp/${compId}/pilot`, {
      registered_pilot_name: "Ana Silva",
      pilot_class: "open",
      civl_ranking: 12,
      civl_ranking_slug: "hang-gliding-class-1-xc",
      civl_ranking_date: "2026-07-01",
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as Record<string, unknown>;
    expect(created.civl_ranking).toBe(12);
    expect(created.civl_ranking_slug).toBe("hang-gliding-class-1-xc");
    expect(created.civl_ranking_date).toBe("2026-07-01");

    // And it survives a read, which is what the pilots table renders from.
    const list = await request("GET", `/api/comp/${compId}/pilot`, {
      user: "user-1",
    });
    const { pilots } = (await list.json()) as { pilots: Record<string, unknown>[] };
    expect(pilots[0].civl_ranking).toBe(12);
    expect(pilots[0].civl_ranking_date).toBe("2026-07-01");
  });

  test("an organiser's hand override drops the source", async () => {
    // A rank CIVL never published must not keep CIVL's name and month on it —
    // that is the difference the roster shows as "set by organiser".
    const compId = await createComp();
    const created = await authRequest("POST", `/api/comp/${compId}/pilot`, {
      registered_pilot_name: "Ana Silva",
      pilot_class: "open",
      civl_ranking: 12,
      civl_ranking_slug: "hang-gliding-class-1-xc",
      civl_ranking_date: "2026-07-01",
    });
    const { comp_pilot_id } = (await created.json()) as { comp_pilot_id: string };

    const patched = await authRequest(
      "PATCH",
      `/api/comp/${compId}/pilot/${comp_pilot_id}`,
      { civl_ranking: 5 }
    );
    const after = (await patched.json()) as Record<string, unknown>;
    expect(after.civl_ranking).toBe(5);
    expect(after.civl_ranking_slug).toBeNull();
    expect(after.civl_ranking_date).toBeNull();
  });

  test("changing a rank is audit-logged with both values", async () => {
    const compId = await createComp();
    const created = await authRequest("POST", `/api/comp/${compId}/pilot`, {
      registered_pilot_name: "Ana Silva",
      pilot_class: "open",
      civl_ranking: 12,
    });
    const { comp_pilot_id } = (await created.json()) as { comp_pilot_id: string };
    await authRequest("PATCH", `/api/comp/${compId}/pilot/${comp_pilot_id}`, {
      civl_ranking: 5,
    });

    const log = await request("GET", `/api/comp/${compId}/audit`, { user: "user-1" });
    const { entries } = (await log.json()) as { entries: { description: string }[] };
    const ranking = entries.find((e) => e.description.includes("CIVL ranking"));
    expect(ranking?.description).toContain("Ana Silva");
    expect(ranking?.description).toContain("12");
    expect(ranking?.description).toContain("5");
  });

  test("the bulk save round-trips the rank and its source", async () => {
    const compId = await createComp();
    const res = await authRequest("POST", `/api/comp/${compId}/pilot/bulk`, {
      pilots: [
        {
          registered_pilot_name: "Ana Silva",
          pilot_class: "open",
          civl_ranking: 12,
          civl_ranking_slug: "hang-gliding-class-1-xc",
          civl_ranking_date: "2026-07-01",
        },
      ],
    });
    expect(res.status).toBe(200);
    const { pilots } = (await res.json()) as { pilots: Record<string, unknown>[] };
    expect(pilots[0].civl_ranking).toBe(12);
    expect(pilots[0].civl_ranking_slug).toBe("hang-gliding-class-1-xc");
  });

  test("a ranking that is not a positive whole number is refused", async () => {
    const compId = await createComp();
    const res = await authRequest("POST", `/api/comp/${compId}/pilot`, {
      registered_pilot_name: "Ana Silva",
      pilot_class: "open",
      civl_ranking: 0,
    });
    expect(res.status).toBe(400);
  });

  test("a source list that is not a CIVL slug is refused", async () => {
    // The slug is rendered as the provenance of a published number, so it may
    // not be arbitrary text an import decided on.
    const compId = await createComp();
    const res = await authRequest("POST", `/api/comp/${compId}/pilot`, {
      registered_pilot_name: "Ana Silva",
      pilot_class: "open",
      civl_ranking: 12,
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

    const { lists } = await lookup(compId, [
      { name: "Ana Silva", civl_id: "25161" },
    ]);
    expect(lists).toHaveLength(1);
    expect(lists[0].matches["0"]).toMatchObject({
      matched_by: "civl_id",
      rank: 12,
    });
  });

  test("offers an id for an unambiguous name, and no rank with it", async () => {
    const compId = await createComp();
    await seedRanking([{ rank: 12, civlId: "25161", pilotName: "Ana Silva" }]);

    const { lists } = await lookup(compId, [{ name: "ana silva", civl_id: null }]);
    expect(lists[0].matches["0"]).toMatchObject({
      matched_by: "name",
      civl_id: "25161",
    });
    expect(lists[0].matched_count).toBe(1);
    expect(lists[0].rankable_count).toBe(0);
  });

  test("every list we hold is returned, including the ones that place nobody", async () => {
    const compId = await createComp({ category: "hg" });
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

    const { lists, default_slug } = await lookup(compId, [
      { name: "Ana Silva", civl_id: "25161" },
    ]);
    expect(lists.map((l) => l.slug).sort()).toEqual([
      "hang-gliding-class-1-xc",
      "paragliding-xc",
    ]);
    const pg = lists.find((l) => l.slug === "paragliding-xc")!;
    expect(pg.matched_count).toBe(0);
    expect(pg.ranking_date).toBe("2026-07-01");
    // An HG comp opens on the HG list.
    expect(default_slug).toBe("hang-gliding-class-1-xc");
  });

  test("only the newest snapshot of a list is matched against", async () => {
    // The importer writes the new month before deleting the old one, so the
    // table transiently holds both. A rank from the outgoing month would be
    // stamped with a date the pilot no longer holds.
    const compId = await createComp();
    await seedRanking([
      { date: "2026-06-01", rank: 40, civlId: "25161", pilotName: "Ana Silva" },
      { date: "2026-07-01", rank: 12, civlId: "25161", pilotName: "Ana Silva" },
    ]);

    const { lists } = await lookup(compId, [
      { name: "Ana Silva", civl_id: "25161" },
    ]);
    expect(lists).toHaveLength(1);
    expect(lists[0].ranking_date).toBe("2026-07-01");
    expect(lists[0].matches["0"].rank).toBe(12);
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

    const { lists } = await lookup(compId, pilots);
    expect(lists[0].matched_count).toBe(120);
    expect(lists[0].rankable_count).toBe(120);
    expect(lists[0].matches["119"]).toMatchObject({ rank: 120 });
  });

  test("a pilot matched by BOTH id and name is not mistaken for two people", async () => {
    // The id chunk and the name chunk each return that row; a duplicate left
    // in place reads as two ranked pilots sharing a name, which the matcher
    // refuses — so a correct roster would silently stop matching.
    const compId = await createComp();
    await seedRanking([{ rank: 12, civlId: "25161", pilotName: "Ana Silva" }]);

    const { lists } = await lookup(compId, [
      { name: "Ana Silva", civl_id: "25161" },
    ]);
    expect(lists[0].matches["0"]).toMatchObject({ matched_by: "civl_id", rank: 12 });
  });

  test("with nothing imported it answers empty rather than failing", async () => {
    const compId = await createComp();
    const { lists, default_slug } = await lookup(compId, [{ name: "Ana Silva" }]);
    expect(lists).toEqual([]);
    expect(default_slug).toBeNull();
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
