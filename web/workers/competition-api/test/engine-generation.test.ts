/**
 * The task score endpoint names the engine generation that computed the body
 * it serves (`engine_generation`), which the results record prints so a kept
 * PDF can say which rules produced it.
 *
 * The one case worth pinning is the stale row: it is served while its
 * re-score runs, and it was computed by whatever engine wrote it — so the
 * generation must come from the ROW, never from the engine now running.
 */
import { env } from "cloudflare:test";
import { describe, expect, test, beforeEach } from "vitest";
import { SCORING_ENGINE_VERSION } from "@glidecomp/engine";
import { request, createComp, createTask, clearCompData } from "./helpers";
import { decodeId } from "../src/sqids";

beforeEach(async () => {
  await clearCompData();
});

const hex = (v: number) => v.toString(16).padStart(12, "0");

async function setup() {
  const compId = await createComp({ category: "hg" });
  const taskId = await createTask(compId, { xctsk: JSON.parse(env.SAMPLE_TASK_XCTSK) });
  return { compId, taskId, taskIdNum: decodeId(env.SQIDS_ALPHABET, taskId)! };
}

describe("engine_generation on the task score endpoint", () => {
  test("names the running engine on a cold compute and on the stored row", async () => {
    const { compId, taskId } = await setup();
    const path = `/api/comp/${compId}/task/${taskId}/score`;
    const cold = (await (await request("GET", path)).json()) as { engine_generation: string };
    expect(cold.engine_generation).toBe(hex(SCORING_ENGINE_VERSION));
    expect(cold.engine_generation).toMatch(/^[0-9a-f]{12}$/);

    const warm = (await (await request("GET", path)).json()) as { engine_generation: string };
    expect(warm.engine_generation).toBe(hex(SCORING_ENGINE_VERSION));
  });

  test("a row an older engine wrote names THAT engine while it is served stale", async () => {
    const { compId, taskId, taskIdNum } = await setup();
    const path = `/api/comp/${compId}/task/${taskId}/score`;
    await request("GET", path); // materialise the row
    const older = SCORING_ENGINE_VERSION === 123 ? 124 : 123;
    await env.DB.prepare("UPDATE task_scores SET engine_version = ? WHERE task_id = ?")
      .bind(older, taskIdNum)
      .run();

    const res = await request("GET", path);
    const body = (await res.json()) as { engine_generation: string; stale: boolean };
    expect(body.stale).toBe(true);
    expect(body.engine_generation).toBe(hex(older));
  });
});
