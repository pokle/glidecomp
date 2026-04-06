import { env } from "cloudflare:test";
import { describe, expect, test, beforeEach } from "vitest";
import {
  authRequest,
  uploadRequest,
  createComp,
  createTask,
  clearCompData,
} from "./helpers";

/** Compress a string to gzip for upload. */
async function compressText(text: string): Promise<Uint8Array> {
  const stream = new Response(text).body!.pipeThrough(
    new CompressionStream("gzip")
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

beforeEach(async () => {
  await clearCompData();
  const listed = await env.R2.list();
  if (listed.objects.length > 0) {
    await Promise.all(listed.objects.map((o) => env.R2.delete(o.key)));
  }
});

/** Get a sample IGC file's text content from the injected binding. */
function getSampleIgc(filename: string): string {
  const files = JSON.parse(env.SAMPLE_IGC_FILES) as Record<string, string>;
  const content = files[filename];
  if (!content) throw new Error(`Sample IGC not found: ${filename}`);
  return content;
}

describe("IGC Upload", () => {
  test("upload succeeds and stores metadata in D1", async () => {
    const taskXctsk = JSON.parse(env.SAMPLE_TASK_XCTSK);
    const compId = await createComp();
    const taskId = await createTask(compId, { xctsk: taskXctsk });

    const payload = await compressText(getSampleIgc("bissett-amess_206778_050126.igc"));
    const res = await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      payload,
      { user: "user-1" }
    );

    expect(res.status).toBe(201);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.replaced).toBe(false);
    expect(typeof data.task_track_id).toBe("string");
    expect(typeof data.igc_filename).toBe("string");
    expect(data.file_size).toBeGreaterThan(0);

    // Verify D1 row exists with expected metadata
    const tt = await env.DB.prepare(
      "SELECT igc_filename, file_size, uploaded_at FROM task_track"
    ).first<{ igc_filename: string; file_size: number; uploaded_at: string }>();

    expect(tt).not.toBeNull();
    expect(tt!.file_size).toBe(payload.byteLength);
    expect(tt!.igc_filename).toMatch(/^c\/\d+\/t\/\d+\/\d+\.igc$/);
    expect(tt!.uploaded_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Confirm flight_data column no longer exists (migration applied)
    const cols = await env.DB.prepare(
      "PRAGMA table_info(task_track)"
    ).all<{ name: string }>();
    const colNames = cols.results.map((c) => c.name);
    expect(colNames).not.toContain("flight_data");
  });

  test("re-upload replaces track and preserves penalty", async () => {
    const taskXctsk = JSON.parse(env.SAMPLE_TASK_XCTSK);
    const compId = await createComp();
    const taskId = await createTask(compId, { xctsk: taskXctsk });

    // First upload
    const res1 = await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      await compressText(getSampleIgc("bissett-amess_206778_050126.igc")),
      { user: "user-1" }
    );
    expect(res1.status).toBe(201);

    // Set a penalty
    const trackData = (await res1.json()) as { comp_pilot_id: string };
    await authRequest(
      "PATCH",
      `/api/comp/${compId}/task/${taskId}/igc/${trackData.comp_pilot_id}`,
      { penalty_points: 50, penalty_reason: "Safety violation" }
    );

    // Re-upload (different file, same pilot)
    const res2 = await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      await compressText(getSampleIgc("herman_202523_050126.igc")),
      { user: "user-1" }
    );
    expect(res2.status).toBe(200);
    const data2 = (await res2.json()) as Record<string, unknown>;
    expect(data2.replaced).toBe(true);

    // Penalty preserved
    const tt = await env.DB.prepare(
      "SELECT penalty_points, penalty_reason FROM task_track"
    ).first<{ penalty_points: number; penalty_reason: string }>();
    expect(tt!.penalty_points).toBe(50);
    expect(tt!.penalty_reason).toBe("Safety violation");
  });

  test("upload to task without xctsk succeeds", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId); // no xctsk

    const payload = await compressText(getSampleIgc("bissett-amess_206778_050126.igc"));
    const res = await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      payload,
      { user: "user-1" }
    );
    expect(res.status).toBe(201);

    const tt = await env.DB.prepare(
      "SELECT igc_filename FROM task_track"
    ).first();
    expect(tt).not.toBeNull();
  });

  test("two different pilots upload to same task", async () => {
    const taskXctsk = JSON.parse(env.SAMPLE_TASK_XCTSK);
    const compId = await createComp();
    const taskId = await createTask(compId, { xctsk: taskXctsk });

    const res1 = await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      await compressText(getSampleIgc("bissett-amess_206778_050126.igc")),
      { user: "user-1" }
    );
    expect(res1.status).toBe(201);

    const res2 = await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      await compressText(getSampleIgc("herman_202523_050126.igc")),
      { user: "user-2" }
    );
    expect(res2.status).toBe(201);

    const count = await env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM task_track"
    ).first<{ cnt: number }>();
    expect(count!.cnt).toBe(2);
  });

  test("empty file is rejected", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);

    const res = await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      new Uint8Array(0),
      { user: "user-1" }
    );
    expect(res.status).toBe(400);
  });
});
