/**
 * The officially published results annotation (issue #603, migration 0031).
 *
 * The task score endpoint serves `official_results` read LIVE from the task
 * row — outside the cached score blob, because the annotation is display
 * only and must never invalidate scores — with stored comp_pilot ids
 * encoded to the same sqids the score entries carry, and the column folded
 * into the ETag so a change to the annotation is never 304'd away.
 */
import { SELF, env } from "cloudflare:test";
import { describe, expect, test, beforeEach } from "vitest";
import { request, createComp, createTask, clearCompData } from "./helpers";
import { decodeId, encodeId } from "../src/sqids";

interface OfficialWire {
  source: string;
  comp_url: string | null;
  task_url: string | null;
  ranks: Record<string, { rank: number; total: number }>;
}

beforeEach(async () => {
  await clearCompData();
});

/** A scoreable comp + task (no tracks needed — the annotation rides on the
 * response regardless of the field), one registered pilot, and the task's
 * numeric id for direct column writes. */
async function setup() {
  const compId = await createComp({ category: "hg" });
  const taskId = await createTask(compId, {
    xctsk: JSON.parse(env.SAMPLE_TASK_XCTSK),
  });
  const compIdNum = decodeId(env.SQIDS_ALPHABET, compId)!;
  const taskIdNum = decodeId(env.SQIDS_ALPHABET, taskId)!;
  await env.DB.prepare(
    `INSERT INTO comp_pilot (comp_id, registered_pilot_name, pilot_class)
     VALUES (?, 'Olav Opsanger', 'open')`
  )
    .bind(compIdNum)
    .run();
  const pilot = await env.DB.prepare(
    "SELECT comp_pilot_id FROM comp_pilot WHERE comp_id = ?"
  )
    .bind(compIdNum)
    .first<{ comp_pilot_id: number }>();
  return { compId, taskId, taskIdNum, compPilotId: pilot!.comp_pilot_id };
}

function officialJson(compPilotId: number, total = 812) {
  return JSON.stringify({
    source: "AirScore",
    comp_url: "https://xc.highcloud.net/comp_overall.html?comPk=466",
    task_url: "https://xc.highcloud.net/task_result.html?comPk=466&tasPk=2027",
    results: [{ comp_pilot_id: compPilotId, rank: 3, total }],
  });
}

describe("official results on the task score endpoint", () => {
  test("absent from the response when the task has none", async () => {
    const { compId, taskId } = await setup();
    const res = await request(
      "GET",
      `/api/comp/${compId}/task/${taskId}/score`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("official_results");
  });

  test("served with sqid-encoded pilot ids and the source links", async () => {
    const { compId, taskId, taskIdNum, compPilotId } = await setup();
    await env.DB.prepare("UPDATE task SET official_results = ? WHERE task_id = ?")
      .bind(officialJson(compPilotId), taskIdNum)
      .run();

    const res = await request(
      "GET",
      `/api/comp/${compId}/task/${taskId}/score`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { official_results: OfficialWire };
    expect(body.official_results.source).toBe("AirScore");
    expect(body.official_results.comp_url).toBe(
      "https://xc.highcloud.net/comp_overall.html?comPk=466"
    );
    expect(body.official_results.task_url).toBe(
      "https://xc.highcloud.net/task_result.html?comPk=466&tasPk=2027"
    );
    const sqid = encodeId(env.SQIDS_ALPHABET, compPilotId);
    expect(body.official_results.ranks).toEqual({
      [sqid]: { rank: 3, total: 812 },
    });
  });

  test("a changed annotation changes the ETag, so it is never 304'd away", async () => {
    const { compId, taskId, taskIdNum, compPilotId } = await setup();
    await env.DB.prepare("UPDATE task SET official_results = ? WHERE task_id = ?")
      .bind(officialJson(compPilotId), taskIdNum)
      .run();
    const path = `/api/comp/${compId}/task/${taskId}/score`;

    const first = await request("GET", path);
    expect(first.status).toBe(200);
    const etag = first.headers.get("ETag")!;
    expect(etag).toBeTruthy();

    // Unchanged annotation: the ETag revalidates.
    const unchanged = await SELF.fetch(`https://test${path}`, {
      headers: { "If-None-Match": etag },
    });
    expect(unchanged.status).toBe(304);

    // Changed annotation: the old ETag must NOT revalidate.
    await env.DB.prepare("UPDATE task SET official_results = ? WHERE task_id = ?")
      .bind(officialJson(compPilotId, 900), taskIdNum)
      .run();
    const changed = await SELF.fetch(`https://test${path}`, {
      headers: { "If-None-Match": etag },
    });
    expect(changed.status).toBe(200);
    const body = (await changed.json()) as { official_results: OfficialWire };
    const sqid = encodeId(env.SQIDS_ALPHABET, compPilotId);
    expect(body.official_results.ranks[sqid].total).toBe(900);
  });

  test("a javascript: URL in either link field is nulled out, not passed through", async () => {
    const { compId, taskId, taskIdNum, compPilotId } = await setup();
    const malicious = JSON.stringify({
      source: "AirScore",
      comp_url: "javascript:alert(document.cookie)",
      task_url: "javascript:alert(document.cookie)",
      results: [{ comp_pilot_id: compPilotId, rank: 3, total: 812 }],
    });
    await env.DB.prepare("UPDATE task SET official_results = ? WHERE task_id = ?")
      .bind(malicious, taskIdNum)
      .run();

    const res = await request(
      "GET",
      `/api/comp/${compId}/task/${taskId}/score`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { official_results: OfficialWire };
    expect(body.official_results.comp_url).toBeNull();
    expect(body.official_results.task_url).toBeNull();
    // The rest of the annotation still serves — a bad link doesn't sink the row.
    const sqid = encodeId(env.SQIDS_ALPHABET, compPilotId);
    expect(body.official_results.ranks[sqid]).toEqual({ rank: 3, total: 812 });
  });

  test("an unreadable column degrades to no annotation, not a failure", async () => {
    const { compId, taskId, taskIdNum } = await setup();
    await env.DB.prepare("UPDATE task SET official_results = ? WHERE task_id = ?")
      .bind("{not json", taskIdNum)
      .run();
    const res = await request(
      "GET",
      `/api/comp/${compId}/task/${taskId}/score`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("official_results");
  });
});
