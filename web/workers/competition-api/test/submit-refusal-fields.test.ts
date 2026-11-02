/**
 * Which form field an upload refusal names (`field`), across the three upload
 * routes: the self upload, the on-behalf upload and the anonymous submit.
 *
 * The submit form is the kit form (`rac/form.tsx`), and a refusal that names a
 * field is shown UNDER that field, which is focused. So a refusal that one step
 * of the form can fix names that step's field, and a refusal that no field can
 * fix — a sign-in, a closed comp, a duplicated roster row — names none, and is
 * shown beside Submit with who to ask. `SUBMIT_FIELD` in submission-gate.ts;
 * docs/track-submission.md, "Errors are repairable".
 */
import { beforeEach, describe, expect, test } from "vitest";
import {
  AS_NEW_PILOT,
  anonUploadRequest,
  authRequest,
  clearCompData,
  createComp,
  createTask,
  uploadRequest,
} from "./helpers";

/** Minimal gzip-compressed IGC (manufacturer record + HFDTE), as in igc-routes. */
function fakeIgcPayload(): Uint8Array {
  return new Uint8Array([
    0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x73, 0x8c,
    0x70, 0x0e, 0x31, 0x30, 0x30, 0x0c, 0x49, 0x2d, 0x2e, 0xe1, 0xe5, 0xf2,
    0x70, 0x73, 0x09, 0x71, 0x35, 0x30, 0x34, 0x30, 0x34, 0x32, 0xe3, 0xe5,
    0x02, 0x00, 0x19, 0xac, 0x90, 0xbb, 0x1a, 0x00, 0x00, 0x00,
  ]);
}

const NOT_AN_IGC = new Uint8Array([1, 2, 3, 4]);

type Body = Record<string, unknown>;

async function bodyOf(res: Response): Promise<Body> {
  return (await res.json()) as Body;
}

/** A comp (owned by user-1) with one task and one pre-registered pilot. */
async function compWithPilot(
  compOverrides: Record<string, unknown> = {}
): Promise<{ compId: string; taskId: string; compPilotId: string }> {
  const compId = await createComp(compOverrides);
  const taskId = await createTask(compId);
  const res = await authRequest("POST", `/api/comp/${compId}/pilot`, {
    registered_pilot_name: "Jane Smith",
    pilot_class: "open",
    registered_pilot_civl_id: "12345",
  });
  const { comp_pilot_id: compPilotId } = (await res.json()) as {
    comp_pilot_id: string;
  };
  return { compId, taskId, compPilotId };
}

async function closeTask(compId: string, taskId: string): Promise<void> {
  const res = await authRequest("PATCH", `/api/comp/${compId}/task/${taskId}`, {
    submissions_closed: true,
  });
  expect(res.status).toBe(200);
}

beforeEach(async () => {
  await clearCompData();
});

describe("the anonymous submit names the field that can fix it", () => {
  const submit = (compId: string, taskId: string, value = "12345", body = fakeIgcPayload()) =>
    anonUploadRequest(compId, taskId, body, { kind: "civl_id", value });

  test("an identifier nobody answers to: the identifier", async () => {
    const { compId, taskId } = await compWithPilot();
    const data = await bodyOf(await submit(compId, taskId, "99999"));
    expect(data).toMatchObject({ code: "no_pilot_match", field: "identifier" });
  });

  test("an identifier we cannot look up: the identifier", async () => {
    const { compId, taskId } = await compWithPilot();
    const res = await anonUploadRequest(compId, taskId, fakeIgcPayload(), {
      kind: "name",
      value: "Jane Smith",
    });
    expect(await bodyOf(res)).toMatchObject({ code: "bad_identifier", field: "identifier" });
  });

  test("a file that is not an IGC: the file", async () => {
    const { compId, taskId } = await compWithPilot();
    const data = await bodyOf(await submit(compId, taskId, "12345", NOT_AN_IGC));
    expect(data).toMatchObject({ code: "invalid_file", field: "file" });
  });

  test("a task from another competition: the task", async () => {
    const { compId } = await compWithPilot();
    const strayTask = await createTask(await createComp());
    const data = await bodyOf(await submit(compId, strayTask));
    expect(data).toMatchObject({ code: "task_not_found", field: "task" });
  });

  test("a task closed for submissions: the task", async () => {
    const { compId, taskId } = await compWithPilot();
    await closeTask(compId, taskId);
    const data = await bodyOf(await submit(compId, taskId));
    expect(data).toMatchObject({ code: "submissions_closed", field: "task" });
  });

  test("a hidden comp answers exactly as a missing one, field and all", async () => {
    const hidden = await compWithPilot({ test: true });
    const data = await bodyOf(await submit(hidden.compId, hidden.taskId));
    expect(data).toEqual({ error: "We could not find that competition.", code: "comp_not_found", field: "task" });
  });

  test("refusals no field can fix name none", async () => {
    // Asks for a sign-in.
    const closedToAnon = await compWithPilot();
    await authRequest("PATCH", `/api/comp/${closedToAnon.compId}`, { open_igc_upload: false });
    const signIn = await bodyOf(await submit(closedToAnon.compId, closedToAnon.taskId));
    expect(signIn.code).toBe("anonymous_not_permitted");
    expect(signIn).not.toHaveProperty("field");

    // A closed competition.
    const closed = await compWithPilot({ close_date: "2020-01-01" });
    const shut = await bodyOf(await submit(closed.compId, closed.taskId));
    expect(shut.code).toBe("comp_closed");
    expect(shut).not.toHaveProperty("field");

    // Two roster rows on one identifier: the organiser's to fix.
    const dup = await compWithPilot();
    await authRequest("POST", `/api/comp/${dup.compId}/pilot`, {
      registered_pilot_name: "Jane Smyth",
      pilot_class: "open",
      registered_pilot_civl_id: "12345",
    });
    const twice = await bodyOf(await submit(dup.compId, dup.taskId));
    expect(twice.code).toBe("ambiguous_pilot_match");
    expect(twice).not.toHaveProperty("field");
  });
});

describe("the signed-in upload names the field that can fix it", () => {
  const upload = (
    compId: string,
    taskId: string,
    headers: Record<string, string> = {},
    body = fakeIgcPayload()
  ) =>
    uploadRequest(`/api/comp/${compId}/task/${taskId}/igc`, body, {
      user: "user-2",
      headers,
    });

  test("a registration the server will not guess: the registration", async () => {
    const { compId, taskId } = await compWithPilot();
    const data = await bodyOf(await upload(compId, taskId));
    expect(data).toMatchObject({ code: "identity_ambiguous", field: "registration" });
  });

  test("a registration that cannot be theirs: the registration", async () => {
    const { compId, taskId } = await compWithPilot();
    const stranger = await compWithPilot();
    const data = await bodyOf(
      await upload(compId, taskId, { "x-comp-pilot": stranger.compPilotId })
    );
    expect(data).toMatchObject({ code: "claim_rejected", field: "registration" });
  });

  test("a registration header we cannot read: the registration", async () => {
    const { compId, taskId } = await compWithPilot();
    const res = await upload(compId, taskId, { "x-comp-pilot": "!!!not-an-id" });
    expect(res.status).toBe(400);
    expect((await bodyOf(res)).field).toBe("registration");
  });

  test("a file that is not an IGC: the file", async () => {
    const { compId, taskId } = await compWithPilot();
    const res = await upload(compId, taskId, AS_NEW_PILOT, NOT_AN_IGC);
    expect(res.status).toBe(400);
    expect((await bodyOf(res)).field).toBe("file");
  });

  test("a missing task, and a closed one: the task", async () => {
    const { compId, taskId } = await compWithPilot();
    const strayTask = await createTask(await createComp());
    expect((await bodyOf(await upload(compId, strayTask, AS_NEW_PILOT))).field).toBe("task");

    await closeTask(compId, taskId);
    const closed = await bodyOf(await upload(compId, taskId, AS_NEW_PILOT));
    expect(closed).toMatchObject({ code: "submissions_closed", field: "task" });
  });

  test("a hidden comp answers exactly as a missing one", async () => {
    const hidden = await compWithPilot({ test: true });
    const data = await bodyOf(await upload(hidden.compId, hidden.taskId, AS_NEW_PILOT));
    expect(data).toEqual({ error: "Competition not found", field: "task" });
  });

  test("a comp that does not take self-registration names no field", async () => {
    const { compId, taskId } = await compWithPilot();
    await authRequest("PATCH", `/api/comp/${compId}`, { open_registration: false });
    const data = await bodyOf(await upload(compId, taskId, AS_NEW_PILOT));
    expect(data.code).toBe("registration_closed");
    expect(data).not.toHaveProperty("field");
  });
});

describe("the on-behalf upload names the field that can fix it", () => {
  const onBehalf = (compId: string, taskId: string, compPilotId: string, body = fakeIgcPayload()) =>
    uploadRequest(`/api/comp/${compId}/task/${taskId}/igc/${compPilotId}`, body, {
      user: "user-1",
    });

  test("a file that is not an IGC: the file", async () => {
    const { compId, taskId, compPilotId } = await compWithPilot();
    const res = await onBehalf(compId, taskId, compPilotId, NOT_AN_IGC);
    expect(res.status).toBe(400);
    expect((await bodyOf(res)).field).toBe("file");
  });

  test("a task from another competition: the task", async () => {
    const { compId, compPilotId } = await compWithPilot();
    const strayTask = await createTask(await createComp());
    const res = await onBehalf(compId, strayTask, compPilotId);
    expect(res.status).toBe(404);
    expect((await bodyOf(res)).field).toBe("task");
  });

  test("a closed competition names no field", async () => {
    const { compId, taskId, compPilotId } = await compWithPilot({ close_date: "2020-01-01" });
    const res = await onBehalf(compId, taskId, compPilotId);
    expect(res.status).toBe(400);
    expect(await bodyOf(res)).not.toHaveProperty("field");
  });
});
