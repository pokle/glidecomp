/**
 * Content identity on uploaded tracks (migration 0032).
 *
 * Every task_track row written by the live upload path must carry the
 * SHA-256 of the raw IGC text — on first upload AND on replacement — so a
 * re-seed can trust the hash to decide whether the object in R2 already
 * holds the content it is about to upload. A replacement inheriting the
 * previous row's hash would be the dangerous failure: the next re-seed
 * would skip the overwrite and the user's replaced track would silently
 * survive it.
 */
import { env } from "cloudflare:test";
import { describe, expect, test, beforeEach } from "vitest";
import {
  uploadRequest,
  createComp,
  createTask,
  clearCompData,
  SAMPLE_TASK_DATE,
} from "./helpers";
import { igcSha256Hex } from "../src/track-upload";

async function compressText(text: string): Promise<Uint8Array> {
  const stream = new Response(text).body!.pipeThrough(
    new CompressionStream("gzip")
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** First sample IGC (filename, content) — a real track for the sample task. */
function sampleIgc(): [string, string] {
  const files = JSON.parse(env.SAMPLE_IGC_FILES) as Record<string, string>;
  const [name, content] = Object.entries(files).sort(([a], [b]) =>
    a.localeCompare(b)
  )[0];
  return [name, content];
}

beforeEach(async () => {
  await clearCompData();
});

describe("igc_sha256 on upload", () => {
  test("stamped on first upload and restamped on replacement", async () => {
    const compId = await createComp({ category: "hg" });
    const taskId = await createTask(compId, {
      xctsk: JSON.parse(env.SAMPLE_TASK_XCTSK),
      task_date: SAMPLE_TASK_DATE,
    });
    const [, content] = sampleIgc();

    const res = await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      await compressText(content),
      { user: "user-1" }
    );
    expect(res.status).toBe(201);

    const row = await env.DB.prepare(
      "SELECT igc_sha256 FROM task_track"
    ).first<{ igc_sha256: string | null }>();
    expect(row!.igc_sha256).toBe(await igcSha256Hex(content));

    // Replace with different content: the hash must follow the content —
    // an extra pilot-event record changes the text without breaking the file.
    const changed = content.replace(/\r?\n/, "\nLGLIDECOMP TEST REPLACEMENT\n");
    expect(changed).not.toBe(content);
    const res2 = await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      await compressText(changed),
      { user: "user-1" }
    );
    expect(res2.status).toBe(200);

    const rows = await env.DB.prepare(
      "SELECT igc_sha256 FROM task_track"
    ).all<{ igc_sha256: string | null }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].igc_sha256).toBe(await igcSha256Hex(changed));
    expect(rows.results[0].igc_sha256).not.toBe(await igcSha256Hex(content));
  });
});
