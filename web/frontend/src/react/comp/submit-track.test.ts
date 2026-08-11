import { describe, expect, test } from "vitest";
import { DEFAULT_UNITS } from "@glidecomp/engine";
import {
  IDENTIFIER_KINDS,
  LAST_SUBMISSION_KEY,
  MAX_COMPRESSED_BYTES,
  MAX_DECOMPRESSED_BYTES,
  NEW_PILOT_SENTINEL,
  describeUploadOutcome,
  formatClockInZone,
  tooLargeReason,
  formatDuration,
  formatRetryAfter,
  formatTrackAltitude,
  formatTrackDistance,
  inferIdentifierKind,
  needsSignIn,
  pickDefaultTask,
  readLastSubmission,
  repairStepFor,
  taskLine,
  unnamedClasses,
  writeLastSubmission,
  type LastSubmission,
  type OpenComp,
} from "./submit-track";

function comp(
  compId: string,
  tasks: { id: string; date: string }[],
  suggested?: string
): OpenComp {
  return {
    comp_id: compId,
    name: `Comp ${compId}`,
    category: "hg",
    timezone: "Australia/Melbourne",
    close_date: null,
    suggested_task_id: suggested ?? tasks[0].id,
    tasks: tasks.map((t) => ({
      task_id: t.id,
      name: `Task ${t.id}`,
      task_date: t.date,
      pilot_classes: ["open"],
      has_xctsk: true,
    })),
  };
}

/** A localStorage stand-in that can also be made to fail. */
function fakeStorage(initial: Record<string, string> = {}, throws = false) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => {
      if (throws) throw new Error("denied");
      return map.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (throws) throw new Error("quota");
      map.set(k, v);
    },
    read: (k: string) => map.get(k) ?? null,
  };
}

describe("pickDefaultTask", () => {
  const comps = [
    comp("aaa", [{ id: "t1", date: "2026-08-02" }]),
    comp("bbb", [
      { id: "t2", date: "2026-08-01" },
      { id: "t3", date: "2026-08-02" },
    ], "t3"),
  ];

  test("a link or QR code wins over everything", () => {
    expect(
      pickDefaultTask(comps, { fromUrl: { compId: "bbb", taskId: "t2" } })
    ).toEqual({ compId: "bbb", taskId: "t2" });
  });

  test("a comp named without a task falls through to that comp's own pick", () => {
    expect(pickDefaultTask(comps, { fromUrl: { compId: "bbb" } })).toEqual({
      compId: "bbb",
      taskId: "t3",
    });
  });

  test("a URL naming a comp that is not open picks nothing rather than guessing", () => {
    // Silently substituting a different competition is how a track ends up
    // filed against the wrong event.
    expect(pickDefaultTask(comps, { fromUrl: { compId: "zzz" } })).toBeNull();
  });

  test("prefers where the pilot submitted last", () => {
    const last: LastSubmission = {
      compId: "bbb",
      taskId: "t2",
      identifierKind: "civl_id",
      identifierValue: "12345",
    };
    expect(pickDefaultTask(comps, { last })).toEqual({
      compId: "bbb",
      taskId: "t2",
    });
  });

  test("moves a returning pilot on to the comp's current task", () => {
    // Day two of a six-day comp: the remembered task is gone from the list,
    // so the comp's own suggestion takes over rather than the pilot being
    // dropped back to the top of the list.
    const last: LastSubmission = {
      compId: "bbb",
      taskId: "gone",
      identifierKind: "civl_id",
      identifierValue: "12345",
    };
    expect(pickDefaultTask(comps, { last })).toEqual({
      compId: "bbb",
      taskId: "t3",
    });
  });

  test("ignores a remembered comp that is no longer open", () => {
    const last: LastSubmission = {
      compId: "old",
      taskId: "t9",
      identifierKind: "email",
      identifierValue: "a@b.com",
    };
    expect(pickDefaultTask(comps, { last })).toEqual({
      compId: "aaa",
      taskId: "t1",
    });
  });

  test("falls back to the nearest comp, which the endpoint listed first", () => {
    expect(pickDefaultTask(comps)).toEqual({ compId: "aaa", taskId: "t1" });
  });

  test("picks nothing when nothing is open", () => {
    expect(pickDefaultTask([])).toBeNull();
  });
});

describe("inferIdentifierKind", () => {
  test("an @ means an email address", () => {
    expect(inferIdentifierKind("jane@example.com", "civl_id")).toBe("email");
  });

  test("digits typed into the email field mean a CIVL ID", () => {
    expect(inferIdentifierKind("12345", "email")).toBe("civl_id");
  });

  test("leaves a deliberate choice alone", () => {
    // Somebody who picked SAFA and typed a SAFA number must not be overridden.
    expect(inferIdentifierKind("12345", "safa_id")).toBe("safa_id");
  });

  test("does not guess between national bodies", () => {
    // "A-4821" could be any of six. A coin toss dressed up as help is worse
    // than leaving the pilot's own choice in place.
    expect(inferIdentifierKind("A-4821", "ffvl_id")).toBe("ffvl_id");
    expect(inferIdentifierKind("A-4821", "email")).toBe("email");
  });

  test("an empty field changes nothing", () => {
    expect(inferIdentifierKind("   ", "bhpa_id")).toBe("bhpa_id");
  });

  test("offers email first, because it is the only kind not on the public roster", () => {
    expect(IDENTIFIER_KINDS[0].value).toBe("email");
  });
});

describe("unnamedClasses", () => {
  test("says nothing when the task name already names the class", () => {
    // "Task 1 (Open) · open" is noise, and noise is what stops the useful
    // half being read.
    expect(unnamedClasses("Task 1 (Open)", ["open"])).toBeNull();
    expect(unnamedClasses("Task 2 (Floater)", ["floater"])).toBeNull();
  });

  test("names the class when the task name does not", () => {
    // A task called "Boosfy" gives the pilot no way to see which field they
    // are filing into.
    expect(unnamedClasses("Boosfy", ["sport"])).toBe("sport");
  });

  test("matches case-insensitively, as organisers type it", () => {
    expect(unnamedClasses("TASK 1 (OPEN)", ["open"])).toBeNull();
    expect(unnamedClasses("Task 1 (open)", ["Open"])).toBeNull();
  });

  test("names only the classes the title left out", () => {
    expect(unnamedClasses("Task 3 (Open)", ["open", "sport"])).toBe("sport");
  });

  test("says nothing when there are no classes to say", () => {
    expect(unnamedClasses("Task 1", [])).toBeNull();
    expect(unnamedClasses("Task 1", undefined)).toBeNull();
  });

  test("does not mistake a substring for the class being named", () => {
    // "Sportsmans Trophy" contains "sport", so this is the honest limit of a
    // substring rule — documented rather than pretended away.
    expect(unnamedClasses("Sportsmans Trophy", ["sport"])).toBeNull();
  });
});

describe("repairStepFor", () => {
  test("sends a wrong identifier back to the identity step", () => {
    expect(repairStepFor("no_pilot_match")).toBe("identity");
    expect(repairStepFor("bad_identifier")).toBe("identity");
  });

  test("sends a bad file back to the file step", () => {
    expect(repairStepFor("invalid_file")).toBe("file");
  });

  test("sends a missing task back to the task step", () => {
    expect(repairStepFor("task_not_found")).toBe("task");
    expect(repairStepFor("comp_not_found")).toBe("task");
  });

  test("admits when no amount of retrying will help", () => {
    // A duplicated roster row, a closed comp and a spent budget are all
    // somebody else's to fix. Offering a retry would be a lie.
    for (const code of [
      "ambiguous_pilot_match",
      "comp_closed",
      "task_pilot_limit",
      "rate_limited",
      "anonymous_not_permitted",
    ] as const) {
      expect(repairStepFor(code)).toBeNull();
    }
  });

  test("knows which failure a sign-in answers", () => {
    expect(needsSignIn("anonymous_not_permitted")).toBe(true);
    expect(needsSignIn("no_pilot_match")).toBe(false);
  });
});

describe("remembering the last submission", () => {
  test("round-trips", () => {
    const storage = fakeStorage();
    const value: LastSubmission = {
      compId: "aaa",
      taskId: "t1",
      identifierKind: "civl_id",
      identifierValue: "12345",
    };
    writeLastSubmission(storage, value);
    expect(storage.read(LAST_SUBMISSION_KEY)).toBeTruthy();
    expect(readLastSubmission(storage)).toEqual(value);
  });

  test("treats anything malformed as nothing remembered", () => {
    expect(readLastSubmission(fakeStorage({ [LAST_SUBMISSION_KEY]: "{" }))).toBeNull();
    expect(
      readLastSubmission(fakeStorage({ [LAST_SUBMISSION_KEY]: '{"compId":1}' }))
    ).toBeNull();
    expect(
      readLastSubmission(
        fakeStorage({
          [LAST_SUBMISSION_KEY]: JSON.stringify({
            compId: "a",
            taskId: "b",
            identifierKind: "passport",
            identifierValue: "x",
          }),
        })
      )
    ).toBeNull();
  });

  test("survives storage being unavailable", () => {
    // Private browsing throws on both reads and writes. Neither is worth
    // failing an upload over.
    expect(readLastSubmission(fakeStorage({}, true))).toBeNull();
    expect(() => writeLastSubmission(fakeStorage({}, true), {
      compId: "a",
      taskId: "b",
      identifierKind: "email",
      identifierValue: "x@y.com",
    })).not.toThrow();
    expect(readLastSubmission(undefined)).toBeNull();
  });
});

describe("the size limits are the server's own", () => {
  const MB = 1024 * 1024;

  test("both caps match igc-validation.ts exactly", () => {
    // web/workers/competition-api/src/igc-validation.ts:37-38. A client limit
    // that is merely near the server's is not a stricter rule, it is a
    // different one — which is the bug this replaced.
    expect(MAX_COMPRESSED_BYTES).toBe(1 * MB);
    expect(MAX_DECOMPRESSED_BYTES).toBe(2 * MB);
  });

  test("an ordinary all-day tracklog is refused HERE, not by a bare 400", () => {
    // 3 MB of raw IGC gzips to roughly 350 KB, so a compressed-only check
    // waves it through and the server then refuses it on the decompressed cap.
    // This is the case that actually happens, and the case both clients
    // silently missed.
    const reason = tooLargeReason(3 * MB, 350 * 1024);
    expect(reason).not.toBeNull();
    // It has to name the limit and say what to do — "too large" alone is the
    // same dead end as the 400.
    expect(reason).toContain("2 MB");
    expect(reason).toMatch(/trim/i);
  });

  test("the old 5 MB rule would have passed exactly that file", () => {
    // Pins WHY this changed: under the previous check a 3 MB IGC was fine.
    expect(3 * MB > 5 * MB).toBe(false);
  });

  test("a file that only breaches the compressed cap is still caught", () => {
    expect(tooLargeReason(1.5 * MB, 1.2 * MB)).toContain("even compressed");
  });

  test("an ordinary flight passes", () => {
    expect(tooLargeReason(600 * 1024, 80 * 1024)).toBeNull();
  });

  test("the boundaries are inclusive, as the server's are", () => {
    // The server rejects on `>`, so a file exactly at the cap is accepted and
    // the client must not refuse what the server would take.
    expect(tooLargeReason(2 * MB, 1 * MB)).toBeNull();
    expect(tooLargeReason(2 * MB + 1, 1 * MB)).not.toBeNull();
    expect(tooLargeReason(1024, 1 * MB + 1)).not.toBeNull();
  });
});

describe("what an upload is announced as", () => {
  const finding = (title: string) => ({
    id: "wrong-day",
    severity: "hard",
    title,
    detail: "The tracklog is dated 3 January; the task was flown on 5 January.",
  });

  test("a clean track is a plain success", () => {
    expect(describeUploadOutcome("Jane Smith", false, { hard_failed: false, findings: [] }))
      .toEqual({ tone: "success", message: "Track uploaded for Jane Smith" });
  });

  test("a replacement says so", () => {
    expect(describeUploadOutcome("Jane Smith", true, { hard_failed: false, findings: [] }))
      .toEqual({ tone: "success", message: "Track replaced for Jane Smith" });
  });

  test("a withheld track is never announced as a success", () => {
    // The whole point: the file IS stored, so the naive reading is "it worked".
    // But it will not be scored, and on the admin grid the pilot it belongs to
    // is not present to notice — so the tone has to carry the warning.
    const outcome = describeUploadOutcome("Jane Smith", false, {
      hard_failed: true,
      findings: [finding("Wrong day")],
    });
    expect(outcome.tone).toBe("warning");
    expect(outcome.message).toBe(
      "Track uploaded for Jane Smith, but it will not be scored: wrong day"
    );
  });

  test("a soft finding still asks to be looked at", () => {
    const outcome = describeUploadOutcome("Jane Smith", false, {
      hard_failed: false,
      findings: [finding("Never left take off")],
    });
    expect(outcome.tone).toBe("warning");
    expect(outcome.message).toContain("needs checking: never left take off");
  });

  test("a hard fail with no findings still warns", () => {
    // Defensive: hard_failed is the verdict, findings are the explanation, and
    // an older cached body can carry the first without the second.
    const outcome = describeUploadOutcome("Jane Smith", true, {
      hard_failed: true,
      findings: [],
    });
    expect(outcome.tone).toBe("warning");
    expect(outcome.message).toBe("Track replaced for Jane Smith, but it will not be scored");
  });

  test("a response with no quality block at all is a success", () => {
    // A route that has not been taught to return track_quality must not turn
    // every upload into a warning.
    expect(describeUploadOutcome("Jane Smith", false, null).tone).toBe("success");
    expect(describeUploadOutcome("Jane Smith", false, undefined).tone).toBe("success");
  });
});

describe("the line a collapsed task step shows", () => {
  const comp: OpenComp = {
    comp_id: "c1",
    name: "Corryong Cup",
    category: "hg",
    timezone: null,
    close_date: null,
    suggested_task_id: "t1",
    tasks: [],
  };
  const task = { name: "Task 3", task_date: "2026-01-05", pilot_classes: ["open"] };

  test("prefers what the pilot actually picked", () => {
    expect(taskLine(comp, task, undefined)).toBe("Task 3 (open) — Corryong Cup");
  });

  test("uses the names a caller passed in", () => {
    // The dialog on a task page knows both without asking anything.
    expect(
      taskLine(null, null, { compName: "Corryong Cup", taskName: "Task 3" })
    ).toBe("Task 3 — Corryong Cup");
  });

  test("uses names looked up for a task given as a bare id", () => {
    // /submit?comp=…&task=… off a poster: two sqids and nothing readable.
    // Saying "Selected task" there is exactly the failure this step exists to
    // prevent — filing against yesterday's task without being shown which.
    expect(
      taskLine(null, null, undefined, {
        compName: "Corryong Cup",
        taskName: "Task 3",
        pilotClasses: ["sports"],
      })
    ).toBe("Task 3 (sports) — Corryong Cup");
  });

  test("still names the class when the looked-up title does not", () => {
    expect(
      taskLine(null, null, undefined, {
        compName: "C",
        taskName: "Boosfy",
        pilotClasses: ["open"],
      })
    ).toBe("Boosfy (open) — C");
  });

  test("does not repeat a class the title already carries", () => {
    expect(
      taskLine(null, null, undefined, {
        compName: "C",
        taskName: "Task 1 (Open)",
        pilotClasses: ["open"],
      })
    ).toBe("Task 1 (Open) — C");
  });

  test("falls back only when nothing at all resolved", () => {
    // Still reachable — a lookup can fail — but it must be the last resort,
    // not the ordinary answer for every linked URL.
    expect(taskLine(null, null, undefined, null)).toBe("Selected task");
    expect(taskLine(null, null, {}, { compName: null, taskName: null })).toBe(
      "Selected task"
    );
  });

  test("shows whichever half it has", () => {
    expect(
      taskLine(null, null, undefined, { compName: "Corryong Cup", taskName: null })
    ).toBe("Corryong Cup");
  });
});

describe("which step can fix a failure", () => {
  test("an unanswered identity question sends the pilot to the identity step", () => {
    // The 409 the server answers when it will not guess which registration a
    // signed-in pilot is. Sending them to the file step, or nowhere, would
    // leave the one control that can fix it unhighlighted.
    expect(repairStepFor("identity_ambiguous")).toBe("identity");
    expect(repairStepFor("claim_rejected")).toBe("identity");
  });

  test("a closed task sends them back to the task list", () => {
    // A real repair, not a shrug: they may well have meant yesterday's task,
    // which is probably still open.
    expect(repairStepFor("submissions_closed")).toBe("task");
  });

  test("the sentinel cannot collide with a real registration id", () => {
    // Sqids use a-z only, so a hyphen makes this unambiguous. Same trick as
    // the open-submit and open-now route segments.
    expect(NEW_PILOT_SENTINEL).toContain("-");
    expect(/^[a-z]+$/.test(NEW_PILOT_SENTINEL)).toBe(false);
  });
});

describe("formatting the summary", () => {
  test("durations read as a pilot would say them", () => {
    expect(formatDuration(16291)).toBe("4h 32m"); // 4h 31m 31s, to the minute
    expect(formatDuration(1080)).toBe("18m");
    expect(formatDuration(3600)).toBe("1h 00m");
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(0)).toBe("—");
  });

  test("times are shown in the competition's own zone", () => {
    // 02:41 UTC is 13:41 in Melbourne in January — the clock the pilot flew by.
    expect(
      formatClockInZone("2026-01-05T02:41:13.000Z", "Australia/Melbourne")
    ).toBe("13:41");
  });

  test("a missing time is a dash, never a fake zero", () => {
    expect(formatClockInZone(null, "Australia/Melbourne")).toBe("—");
    expect(formatClockInZone("not a date", null)).toBe("—");
  });

  // The receipt is the one screen that confirms what was just filed for a
  // pilot, so it reads in the units they chose — it used to hard-code km and m
  // whatever the account said.
  test("the receipt reads in the pilot's own units", () => {
    const metric = { ...DEFAULT_UNITS, distance: "km", altitude: "m" } as const;
    const imperial = { ...DEFAULT_UNITS, distance: "mi", altitude: "ft" } as const;

    // The engine joins value and unit with a non-breaking space, so a
    // figure never wraps away from its unit. Written as an escape here:
    // an invisible character in a test literal is a trap for the next
    // reader, who cannot tell it from a plain space.
    expect(formatTrackDistance(143820, metric)).toBe("143.8\u00a0km");
    expect(formatTrackDistance(143820, imperial)).toBe("89.4\u00a0mi");

    expect(formatTrackAltitude(2130, metric)).toBe("2130\u00a0m");
    expect(formatTrackAltitude(2130, imperial)).toBe("6988\u00a0ft");
  });

  test("a figure the file did not carry is a dash, never a fake zero", () => {
    expect(formatTrackDistance(null, DEFAULT_UNITS)).toBe("—");
    expect(formatTrackAltitude(null, DEFAULT_UNITS)).toBe("—");
  });

  test("a daily budget does not tell the pilot to wait 1440 minutes", () => {
    // The budgets are per day, so the naive minutes rendering reads as a bug
    // rather than an answer.
    // The whole phrase, preposition included: the units change the grammar,
    // and "Try again in tomorrow" is what happens when they don't.
    expect(`Try again ${formatRetryAfter(86372)}.`).toBe("Try again tomorrow.");
    expect(formatRetryAfter(7200)).toBe("in about 2 hours");
    expect(formatRetryAfter(600)).toBe("in about 10 minutes");
    expect(formatRetryAfter(30)).toBe("in a moment");
  });
});
