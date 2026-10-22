/**
 * The comp-level organiser's notes (migration 0037, mobile plan stage 7):
 * public to read, admin to write, audit-logged with an excerpt, and never
 * a score bump — the comp-level sibling of a task's weather notes.
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { authRequest, clearCompData, createComp, createTask, request } from "./helpers";

describe("organiser's notes", () => {
  let compId: string;

  beforeEach(async () => {
    await clearCompData();
    compId = await createComp();
    await createTask(compId);
  });

  test("default to empty, never null", async () => {
    const body = (await (await request("GET", `/api/comp/${compId}`)).json()) as { organiser_notes: string };
    expect(body.organiser_notes).toBe("");
  });

  test("an admin can set them and everyone can read them", async () => {
    const patch = await authRequest("PATCH", `/api/comp/${compId}`, {
      organiser_notes: "Briefing 9:30 at the launch shelter.",
    });
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { organiser_notes: string }).organiser_notes).toBe(
      "Briefing 9:30 at the launch shelter."
    );
    const anon = (await (await request("GET", `/api/comp/${compId}`)).json()) as { organiser_notes: string };
    expect(anon.organiser_notes).toBe("Briefing 9:30 at the launch shelter.");
  });

  test("a non-admin cannot write them", async () => {
    const res = await request("PATCH", `/api/comp/${compId}`, {
      body: { organiser_notes: "Not mine to say" },
      user: "user-3",
    });
    expect(res.status).toBe(403);
  });

  test("an edit is audit-logged with an excerpt, and a clear is its own line", async () => {
    await authRequest("PATCH", `/api/comp/${compId}`, { organiser_notes: `Retrieve ${"x".repeat(400)}` });
    await authRequest("PATCH", `/api/comp/${compId}`, { organiser_notes: "" });
    const rows = await env.DB.prepare(
      "SELECT description FROM audit_log WHERE comp_id = (SELECT MAX(comp_id) FROM comp) ORDER BY audit_id"
    ).all<{ description: string }>();
    const lines = rows.results.map((r) => r.description);
    const added = lines.find((d) => d.startsWith("Added the organiser's notes:"));
    expect(added).toBeTruthy();
    expect(added!.length).toBeLessThan(200);
    expect(lines).toContain("Cleared the organiser's notes");
  });

  test("writing them does NOT mark scores stale", async () => {
    const rev = () =>
      env.DB.prepare(
        "SELECT inputs_rev FROM task_scores WHERE task_id = (SELECT MAX(task_id) FROM task)"
      ).first<{ inputs_rev: number }>();
    const before = await rev();
    await authRequest("PATCH", `/api/comp/${compId}`, { organiser_notes: "Light and variable." });
    const after = await rev();
    expect(after?.inputs_rev ?? null).toBe(before?.inputs_rev ?? null);
  });

  test("rejects notes past the length cap", async () => {
    const res = await authRequest("PATCH", `/api/comp/${compId}`, { organiser_notes: "x".repeat(4001) });
    expect(res.status).toBe(400);
  });
});
