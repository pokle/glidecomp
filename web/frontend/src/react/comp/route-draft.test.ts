/**
 * The route editor's draft (#812): what makes it the same route on every page
 * of the editor, after a reload, and against a saved route that moved.
 *
 * The parts asserted here are the ones a page could not show going wrong
 * until much later — a row id that meant a different turnpoint after a
 * reorder, an Add left empty that still demoted the goal, a Quick entry that
 * forgot what the line cannot say.
 */
import { describe, expect, it } from "vitest";
import type { WaypointFileRecord, XCTask } from "@glidecomp/engine";
import {
  addNewWaypoint,
  appendBlank,
  applyQuickEntry,
  editTurnpoint,
  freshDraft,
  isDirty,
  isRouteDraft,
  loadTask,
  moveTurnpoint,
  pruneBlankRows,
  removeTurnpoint,
  resolveDraft,
  savedKey,
} from "./route-draft";

const ctx = { toDisplayTime: (hhmm: string) => hhmm };

const tp = (name: string, lat: number, type?: "TAKEOFF" | "SSS" | "ESS") => ({
  ...(type ? { type } : {}),
  radius: 400,
  waypoint: { name, description: `${name} long`, lat, lon: 147.9, altSmoothed: 800 },
});

const saved: XCTask = {
  taskType: "CLASSIC",
  version: 1,
  turnpoints: [tp("ALPHA", -36.5, "TAKEOFF"), tp("BRAVO", -36.6, "SSS"), tp("CHARL", -36.7)],
  sss: { type: "RACE", direction: "EXIT", timeGates: ["02:00:00Z"] },
  goal: { type: "CYLINDER" },
};

const names = (d: { rows: { name: string }[] }) => d.rows.map((r) => r.name);

describe("freshDraft", () => {
  it("numbers the saved route 1..N and marks the untyped last as the goal", () => {
    const d = freshDraft(saved, ctx);
    expect(d.rows.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(d.nextId).toBe(4);
    expect(d.rows.map((r) => r.type)).toEqual(["TAKEOFF", "SSS", "GOAL"]);
    expect(d.gates).toEqual(["02:00"]);
    expect(isDirty(d, savedKey(saved, ctx))).toBe(false);
  });

  it("starts empty for a task with no route", () => {
    const d = freshDraft(null, ctx);
    expect(d.rows).toEqual([]);
    expect(d.nextId).toBe(1);
  });
});

describe("row ids", () => {
  it("follow a turnpoint through a reorder", () => {
    const d = freshDraft(saved, ctx);
    const { draft, to } = moveTurnpoint(d, 3, -1);
    expect(to).toBe(1);
    expect(names(draft)).toEqual(["ALPHA", "CHARL", "BRAVO"]);
    expect(draft.rows.find((r) => r.id === 3)?.name).toBe("CHARL");
  });

  it("are never reused, even after a delete", () => {
    const d = removeTurnpoint(freshDraft(saved, ctx), 3);
    const { id } = appendBlank(d, "");
    expect(id).toBe(4);
  });

  it("are new for a loaded task, so an old link names nothing", () => {
    const d = loadTask(freshDraft(saved, ctx), { ...saved, turnpoints: [tp("ZULU", -36)] }, ctx);
    expect(d.rows.map((r) => r.id)).toEqual([4]);
    expect(d.nextId).toBe(5);
  });
});

describe("Add turnpoint", () => {
  it("is not an edit while it is empty, and demotes nothing", () => {
    const d = freshDraft(saved, ctx);
    const { draft, id } = appendBlank(d, "GOAL");
    expect(isDirty(draft, d.base)).toBe(false);
    expect(draft.rows.find((r) => r.id === 3)?.type).toBe("GOAL");
    // Left empty, the route page drops it, and the route is as it was.
    expect(pruneBlankRows(draft).rows).toEqual(d.rows);
    expect(draft.rows.some((r) => r.id === id)).toBe(true);
  });

  it("makes the new turnpoint the only goal once it is filled in", () => {
    const { draft, id } = appendBlank(freshDraft(saved, ctx), "GOAL");
    const filled = editTurnpoint(draft, id, { name: "DELTA" }).draft;
    expect(filled.rows.map((r) => r.type)).toEqual(["TAKEOFF", "SSS", "", "GOAL"]);
    expect(isDirty(filled, savedKey(saved, ctx))).toBe(true);
  });
});

describe("editTurnpoint", () => {
  it("sends a turnpoint made the goal to the end, and says so", () => {
    const d = freshDraft(saved, ctx);
    const { draft, movedToEnd } = editTurnpoint(d, 2, { type: "GOAL" });
    expect(movedToEnd).toBe(true);
    expect(names(draft)).toEqual(["ALPHA", "CHARL", "BRAVO"]);
    expect(draft.rows.map((r) => r.type)).toEqual(["TAKEOFF", "", "GOAL"]);
  });

  it("leaves everything else where it is", () => {
    const { draft, movedToEnd } = editTurnpoint(freshDraft(saved, ctx), 2, { radius: 2000 });
    expect(movedToEnd).toBe(false);
    expect(draft.rows[1]).toMatchObject({ id: 2, name: "BRAVO", radius: 2000 });
  });
});

describe("applyQuickEntry", () => {
  it("keeps what the line cannot say for a turnpoint it still names", () => {
    const d = editTurnpoint(freshDraft(saved, ctx), 1, { radius: 3000 }).draft;
    const alpha: WaypointFileRecord = {
      code: "ALPHA",
      name: "Alpha",
      latitude: -30,
      longitude: 140,
      radius: 400,
    };
    const next = applyQuickEntry(
      d,
      {
        picks: [
          { query: "ALPHA", record: alpha, radius: 400, radiusStated: false, type: "" },
          { query: "BRAVO", record: null, radius: 400, radiusStated: false, type: "" },
        ],
        start: null,
      },
      { openDistance: false }
    );
    expect(names(next)).toEqual(["ALPHA", "BRAVO"]);
    expect(next.rows[0]).toMatchObject({ id: 1, radius: 3000, coords: d.rows[0].coords });
  });
});

describe("addNewWaypoint", () => {
  it("holds the waypoint for the competition and adds it as the next turnpoint", () => {
    const rec: WaypointFileRecord = {
      code: "NEW",
      name: "New point",
      latitude: -36.9,
      longitude: 148,
      radius: 400,
    };
    const d = addNewWaypoint(freshDraft(saved, ctx), rec, { openDistance: false });
    expect(d.pendingWaypoints).toEqual([rec]);
    expect(names(d)).toEqual(["ALPHA", "BRAVO", "CHARL", "NEW"]);
    expect(d.rows[3].id).toBe(4);
  });
});

describe("resolveDraft", () => {
  it("uses the stored draft while the saved route is the one it started from", () => {
    const stored = editTurnpoint(freshDraft(saved, ctx), 2, { radius: 2000 }).draft;
    const r = resolveDraft(stored, saved, ctx);
    expect(r).toMatchObject({ fromStorage: true, serverChanged: false });
    expect(r.draft).toBe(stored);
  });

  it("drops an unedited copy of an older save for the saved route", () => {
    const stored = freshDraft(saved, ctx);
    const moved: XCTask = { ...saved, turnpoints: saved.turnpoints.slice(0, 2) };
    const r = resolveDraft(stored, moved, ctx);
    expect(r).toMatchObject({ fromStorage: false, serverChanged: false });
    expect(names(r.draft)).toEqual(["ALPHA", "BRAVO"]);
  });

  it("keeps edits made against an older save, and says the saved route moved", () => {
    const stored = editTurnpoint(freshDraft(saved, ctx), 2, { radius: 2000 }).draft;
    const moved: XCTask = { ...saved, turnpoints: saved.turnpoints.slice(0, 2) };
    const r = resolveDraft(stored, moved, ctx);
    expect(r).toMatchObject({ fromStorage: true, serverChanged: true });
    expect(r.draft).toBe(stored);
  });

  it("rebases edits the server now holds, with nothing to warn about", () => {
    // Another tab saved the same edit, or this one's save answered nothing.
    const stored = editTurnpoint(freshDraft(saved, ctx), 2, { radius: 2000 }).draft;
    const nowSaved: XCTask = {
      ...saved,
      turnpoints: saved.turnpoints.map((t, i) => (i === 1 ? { ...t, radius: 2000 } : t)),
    };
    const r = resolveDraft(stored, nowSaved, ctx);
    expect(r).toMatchObject({ fromStorage: true, serverChanged: false });
    expect(r.draft.base).toBe(savedKey(nowSaved, ctx));
    expect(isDirty(r.draft, savedKey(nowSaved, ctx))).toBe(false);
    expect(r.draft.rows.map((x) => x.id)).toEqual(stored.rows.map((x) => x.id));
  });
});

describe("isRouteDraft", () => {
  it("accepts a draft through a JSON round trip, and refuses a stranger", () => {
    const d = freshDraft(saved, ctx);
    expect(isRouteDraft(JSON.parse(JSON.stringify(d)))).toBe(true);
    expect(isRouteDraft({ ...d, rows: [{ id: "1" }] })).toBe(false);
    expect(isRouteDraft(null)).toBe(false);
  });

  it("round-trips to the same content, so a reload is not an edit", () => {
    const d = freshDraft(saved, ctx);
    const back = JSON.parse(JSON.stringify(d));
    expect(isDirty(back, savedKey(saved, ctx))).toBe(false);
  });
});
