import { env } from "cloudflare:test";
import { describe, expect, test, beforeEach } from "vitest";
import {
  authRequest,
  uploadRequest,
  createComp,
  createTask,
  clearCompData,
} from "./helpers";

const bissettAmessIgc = "HFDTE050126\nB1200004728234N01152432EA0100001000\nB1200014728234N01152432EA0100001000\n";
const hermanIgc = "HFDTE050126\nB1200004728234N01152432EA0100001000\nB1200024728234N01152432EA0100001000\n";
const drabbleIgc = "HFDTE050126\nB1200004728234N01152432EA0100001000\nB1200034728234N01152432EA0100001000\n";
// @ts-ignore
import taskXctskRaw from "./samples/task.xctsk?raw";

const taskXctsk = JSON.parse(taskXctskRaw);

/** Helper to compress a string to gzip */
async function compressToGzip(text: string): Promise<Uint8Array> {
  if (!text) throw new Error("Sample text is empty");
  const stream = new Response(text).body!.pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

beforeEach(async () => {
  await clearCompData();
  // Clean up R2
  const listed = await env.R2.list();
  if (listed.objects.length > 0) {
    await Promise.all(listed.objects.map((o) => env.R2.delete(o.key)));
  }
});

describe("Preprocessing Pipeline", () => {
  test("preprocesses IGC on upload when task has xctsk", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId, { xctsk: taskXctsk });

    // Use a real IGC from samples
    const payload = await compressToGzip("HFDTE050126\nB1200004728234N01152432EA0100001000\n");

    const res = await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      payload,
      { user: "user-1" }
    );
    expect(res.status).toBe(201);

    // Verify flight_data was populated in D1
    const tt = await env.DB.prepare("SELECT flight_data FROM task_track").first<{ flight_data: string }>();
    expect(tt!.flight_data).not.toBeNull();

    const flightData = JSON.parse(tt!.flight_data);
    expect(flightData.flownDistance).toBeGreaterThan(0);
    // Hardcoded IGC won't make goal
    expect(flightData.madeGoal).toBe(false);
  });

  test("re-upload updates flight_data", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId, { xctsk: taskXctsk });

    // Upload first track (made goal)
    const payload1 = await compressToGzip(bissettAmessIgc);
    const res1 = await uploadRequest(`/api/comp/${compId}/task/${taskId}/igc`, payload1, { user: "user-1" });
    expect(res1.status).toBe(201);

    const tt1 = await env.DB.prepare("SELECT flight_data FROM task_track").first<{ flight_data: string }>();
    expect(tt1).not.toBeNull();
    expect(tt1!.flight_data).not.toBeNull();
    const fd1 = JSON.parse(tt1!.flight_data);
    expect(fd1.madeGoal).toBe(true);

    // Upload second track (replacement)
    const payload2 = await compressToGzip(hermanIgc);
    const res2 = await uploadRequest(`/api/comp/${compId}/task/${taskId}/igc`, payload2, { user: "user-1" });
    expect(res2.status).toBe(200);

    const tt2 = await env.DB.prepare("SELECT flight_data FROM task_track").first<{ flight_data: string }>();
    expect(tt2).not.toBeNull();
    expect(tt2!.flight_data).not.toBeNull();
    const fd2 = JSON.parse(tt2!.flight_data);
    expect(fd2.flownDistance).not.toBe(fd1.flownDistance);
  });

  test("preprocessing handles task without xctsk (flight_data stays NULL)", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId); // no xctsk

    const payload = await compressToGzip(bissettAmessIgc);
    const res = await uploadRequest(`/api/comp/${compId}/task/${taskId}/igc`, payload, { user: "user-1" });
    expect(res.status).toBe(201);

    const tt = await env.DB.prepare("SELECT flight_data FROM task_track").first<{ flight_data: string }>();
    expect(tt!.flight_data).toBeNull();
  });

  test("POST .../reprocess enqueues messages", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);

    // Upload 3 tracks from DIFFERENT users (to have 3 tracks)
    const r1 = await uploadRequest(`/api/comp/${compId}/task/${taskId}/igc`, await compressToGzip(bissettAmessIgc), { user: "user-1" });
    expect(r1.status).toBe(201);
    const r2 = await uploadRequest(`/api/comp/${compId}/task/${taskId}/igc`, await compressToGzip(hermanIgc), { user: "user-2" });
    expect(r2.status).toBe(201);
    const r3 = await uploadRequest(`/api/comp/${compId}/task/${taskId}/igc`, await compressToGzip(drabbleIgc), { user: "user-1" });
    expect(r3.status).toBe(200); // Replacement

    // Update task with xctsk
    await env.DB.prepare("UPDATE task SET xctsk = ? WHERE task_id = ?")
      .bind(JSON.stringify(taskXctsk), taskId)
      .run();

    // Trigger reprocess
    const res = await authRequest("POST", `/api/comp/${compId}/task/${taskId}/reprocess`);
    expect(res.status).toBe(200);
    const data = await res.json() as { count: number };
    expect(data.count).toBe(2); // user-1 and user-2

    // Verify messages in Queue
    const messages = await env.REPROCESS_QUEUE.list();
    expect(messages.messages.length).toBe(2);
    expect(messages.messages[0].body.type).toBe("reprocess_track");
  });
});
