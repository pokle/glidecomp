/**
 * Deleting a competition, task or pilot removes their track FILES from R2,
 * not just the rows that name them (src/track-files.ts). The privacy policy
 * promises this, and before it the files outlived every delete.
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import {
  authRequest,
  clearCompData,
  createComp,
  createTask,
  uploadRequest,
} from "./helpers";

/** A minimal gzip IGC payload (same as igc-routes.test.ts). */
function fakeIgcPayload(): Uint8Array {
  return new Uint8Array([
    0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x73, 0x8c,
    0x70, 0x0e, 0x31, 0x30, 0x30, 0x0c, 0x49, 0x2d, 0x2e, 0xe1, 0xe5, 0xf2,
    0x70, 0x73, 0x09, 0x71, 0x35, 0x30, 0x34, 0x30, 0x34, 0x32, 0xe3, 0xe5,
    0x02, 0x00, 0x19, 0xac, 0x90, 0xbb, 0x1a, 0x00, 0x00, 0x00,
  ]);
}

async function upload(compId: string, taskId: string): Promise<void> {
  const res = await uploadRequest(
    `/api/comp/${compId}/task/${taskId}/igc`,
    fakeIgcPayload(),
    { user: "user-1" }
  );
  expect(res.status).toBeLessThan(300);
}

async function r2Keys(): Promise<string[]> {
  return (await env.R2.list()).objects.map((o) => o.key).sort();
}

async function onlyPilotId(compId: string): Promise<string> {
  const res = await authRequest("GET", `/api/comp/${compId}/pilot`);
  const { pilots } = (await res.json()) as { pilots: { comp_pilot_id: string }[] };
  expect(pilots).toHaveLength(1);
  return pilots[0].comp_pilot_id;
}

beforeEach(async () => {
  await clearCompData();
  const listed = await env.R2.list();
  await Promise.all(listed.objects.map((o) => env.R2.delete(o.key)));
});

describe("track files go with their rows", () => {
  test("deleting a competition deletes its tracks, and only its tracks", async () => {
    const doomed = await createComp({ name: "Doomed" });
    await upload(doomed, await createTask(doomed));
    await upload(doomed, await createTask(doomed, { name: "Task 2" }));
    const kept = await createComp({ name: "Kept" });
    await upload(kept, await createTask(kept));
    const before = await r2Keys();
    expect(before).toHaveLength(3);

    expect((await authRequest("DELETE", `/api/comp/${doomed}`)).status).toBe(200);

    const after = await r2Keys();
    expect(after).toHaveLength(1);
    expect(before).toContain(after[0]);
  });

  test("deleting a task deletes its tracks, and not its siblings'", async () => {
    const compId = await createComp();
    const doomed = await createTask(compId);
    const kept = await createTask(compId, { name: "Task 2" });
    await upload(compId, doomed);
    await upload(compId, kept);
    expect(await r2Keys()).toHaveLength(2);

    expect((await authRequest("DELETE", `/api/comp/${compId}/task/${doomed}`)).status).toBe(200);

    expect(await r2Keys()).toHaveLength(1);
  });

  test("removing a pilot deletes their tracks", async () => {
    const compId = await createComp();
    await upload(compId, await createTask(compId));
    const pilotId = await onlyPilotId(compId);
    expect(await r2Keys()).toHaveLength(1);

    expect((await authRequest("DELETE", `/api/comp/${compId}/pilot/${pilotId}`)).status).toBe(200);

    expect(await r2Keys()).toEqual([]);
  });

  test("a bulk roster edit that drops a pilot deletes their tracks", async () => {
    const compId = await createComp();
    await upload(compId, await createTask(compId));
    await onlyPilotId(compId);
    expect(await r2Keys()).toHaveLength(1);

    // The bulk payload is the whole roster: leaving the uploader out removes them.
    const res = await authRequest("POST", `/api/comp/${compId}/pilot/bulk`, {
      pilots: [{ registered_pilot_name: "Someone Else", pilot_class: "open" }],
    });
    expect(res.status).toBe(200);

    expect(await r2Keys()).toEqual([]);
  });
});
