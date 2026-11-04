/**
 * The waypoints editor's draft (#811): what makes it the same file on every
 * page of the editor, after a reload, and against a saved set that moved.
 *
 * The parts asserted here are the ones a page could not show going wrong
 * until much later — a row id that meant a different waypoint after a
 * reload, a review list that re-sorted itself under the reader's thumb, a
 * terrain reading left beside coordinates it was not taken at.
 */
import { describe, expect, it } from "vitest";
import type { WaypointFileRecord } from "@glidecomp/engine";
import {
  acceptMapAltitudes,
  addRecord,
  baselineJson,
  cleanCodes,
  convertFromFeet,
  deleteRow,
  endReview,
  freshDraft,
  isDirty,
  isWaypointsDraft,
  readingFor,
  replaceAll,
  resolveDraft,
  reviewEntry,
  startReview,
  updateRow,
  validRecords,
  waypointsDraft,
} from "./waypoints-draft";
import { newWaypointSearch, readNewWaypointSeed } from "./AddWaypointForm";

const wp = (code: string, altitude?: number, lat = -36.2): WaypointFileRecord => ({
  code,
  name: `${code} name`,
  latitude: lat,
  longitude: 147.9,
  ...(altitude === undefined ? {} : { altitude }),
  radius: 400,
});

const SAVED = [wp("ALPHA", 300), wp("BRAVO", 0, -36.3), wp("CHARLIE", undefined, -36.4)];

describe("a fresh draft", () => {
  it("numbers the saved set 1..N in file order, every time", () => {
    const d = freshDraft(SAVED);
    expect(d.rows.map((r) => [r.id, r.code])).toEqual([
      [1, "ALPHA"],
      [2, "BRAVO"],
      [3, "CHARLIE"],
    ]);
    expect(d.nextId).toBe(4);
    // The same numbers on another page, or after a reload with no draft.
    expect(freshDraft(SAVED)).toEqual(d);
  });

  it("is not dirty, and keeps a zero altitude apart from an absent one", () => {
    const d = freshDraft(SAVED);
    expect(isDirty(d.rows, baselineJson(SAVED))).toBe(false);
    expect(d.rows[1].altitude).toBe("0");
    expect(d.rows[2].altitude).toBe("");
    expect(validRecords(d.rows)[2]).not.toHaveProperty("altitude");
  });
});

describe("resolveDraft", () => {
  it("reads the saved set when nothing is stored", () => {
    const r = resolveDraft(null, SAVED);
    expect(r.fromStorage).toBe(false);
    expect(r.draft.rows).toHaveLength(3);
  });

  it("keeps a stored draft of the set that is still saved", () => {
    const edited = updateRow(freshDraft(SAVED), 1, { name: "Edited" });
    const r = resolveDraft(edited, SAVED);
    expect(r).toEqual({ draft: edited, fromStorage: true, serverChanged: false });
  });

  it("drops an unedited copy of an older save for the new one", () => {
    const old = freshDraft(SAVED);
    const now = [...SAVED, wp("DELTA", 100)];
    const r = resolveDraft(old, now);
    expect(r.fromStorage).toBe(false);
    expect(r.draft.rows.map((x) => x.code)).toContain("DELTA");
  });

  it("keeps edits made against an older save, and says the save moved", () => {
    const edited = updateRow(freshDraft(SAVED), 1, { name: "Edited" });
    const r = resolveDraft(edited, [...SAVED, wp("DELTA", 100)]);
    expect(r.fromStorage).toBe(true);
    expect(r.serverChanged).toBe(true);
    expect(r.draft).toBe(edited);
  });

  it("rebases edits the server now holds, with nothing to warn about", () => {
    // A save whose answer was lost: the draft was kept, and the save landed.
    const edited = updateRow(freshDraft(SAVED), 1, { name: "Edited" });
    const nowSaved = validRecords(edited.rows);
    const flat = new Map([[2, 0]]);
    const reviewing = startReview(edited, flat);
    const r = resolveDraft(reviewing, nowSaved);
    expect(r).toMatchObject({ fromStorage: true, serverChanged: false });
    expect(r.draft.base).toBe(baselineJson(nowSaved));
    expect(isDirty(r.draft.rows, baselineJson(nowSaved))).toBe(false);
    // Its ids and the review in progress are the organiser's, and stay.
    expect(r.draft.rows.map((x) => x.id)).toEqual(reviewing.rows.map((x) => x.id));
    expect(r.draft.review).toEqual(reviewing.review);
  });
});

describe("row ids", () => {
  it("stay with their waypoint through a rename, a removal and an addition", () => {
    let d = freshDraft(SAVED);
    d = updateRow(d, 2, { code: "RENAMED" });
    d = deleteRow(d, 1);
    const added = addRecord(d, wp("NEW", 50));
    expect(added.id).toBe(4);
    expect(added.draft.rows.map((r) => [r.id, r.code])).toEqual([
      [2, "RENAMED"],
      [3, "CHARLIE"],
      [4, "NEW"],
    ]);
  });

  it("never reuse an old waypoint's id for a new file", () => {
    const d = replaceAll(freshDraft(SAVED), [wp("ONE"), wp("TWO")]);
    expect(d.rows.map((r) => r.id)).toEqual([4, 5]);
    expect(d.nextId).toBe(6);
  });

  it("survive cleaning the codes for a save", () => {
    let d = freshDraft(SAVED);
    d = updateRow(d, 1, { code: "BRAVO" }); // a duplicate
    d = updateRow(d, 3, { code: "HAS SPACE" });
    const { draft, changes } = cleanCodes(d);
    expect(changes.length).toBeGreaterThan(0);
    expect(draft.rows.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(new Set(draft.rows.map((r) => r.code)).size).toBe(3);
    expect(draft.rows[2].code).not.toContain(" ");
  });
});

describe("the altitude review", () => {
  // The terrain, flat at 1000 m: ALPHA (300) is 700 out, BRAVO (0) 1000 out,
  // CHARLIE has no altitude at all.
  const flat = new Map([
    [1, 1000],
    [2, 1000],
    [3, 1000],
  ]);

  it("snapshots membership and order when it starts", () => {
    const d = startReview(freshDraft(SAVED), flat);
    expect(d.review?.listed.sort()).toEqual([1, 2, 3]);
    // Biggest disagreement first: BRAVO, then ALPHA.
    expect(d.review?.order.slice(0, 2)).toEqual([2, 1]);
  });

  it("holds the order still when a row is accepted", () => {
    const d = startReview(freshDraft(SAVED), flat);
    const { draft, accepted } = acceptMapAltitudes(d, [2]);
    expect(accepted).toBe(1);
    expect(draft.rows[1].altitude).toBe("1000");
    // BRAVO now agrees, and is still first and still listed.
    expect(draft.review?.order).toEqual(d.review?.order);
    expect(draft.review?.listed).toEqual(d.review?.listed);
  });

  it("forgets a reading once its waypoint moves", () => {
    let d = startReview(freshDraft(SAVED), flat);
    expect(readingFor(d, d.rows[0])).toBe(1000);
    d = updateRow(d, 1, { coords: "-36.5, 148" });
    expect(readingFor(d, d.rows[0])).toBeUndefined();
    expect(reviewEntry(d, d.rows[0]).mapAlt).toBeUndefined();
    // And so there is nothing to accept for it.
    expect(acceptMapAltitudes(d, [1]).accepted).toBe(0);
  });

  it("closes with its readings", () => {
    const d = endReview(startReview(freshDraft(SAVED), flat));
    expect(d.review).toBeNull();
  });
});

describe("convertFromFeet", () => {
  it("converts the altitudes there are and leaves a blank blank", () => {
    const { draft, converted } = convertFromFeet(freshDraft(SAVED));
    expect(converted).toBe(2);
    expect(draft.rows[0].altitude).toBe(String(Math.round(300 * 0.3048)));
    expect(draft.rows[2].altitude).toBe("");
  });
});

describe("the stored draft", () => {
  it("passes its own check, and a stranger does not", () => {
    const d = startReview(freshDraft(SAVED), new Map([[1, 500]]));
    expect(isWaypointsDraft(JSON.parse(JSON.stringify(d)))).toBe(true);
    expect(isWaypointsDraft({ ...d, rows: [{ id: "1" }] })).toBe(false);
    expect(isWaypointsDraft({ ...d, review: { listed: [], order: [] } })).toBe(false);
  });

  it("round-trips through storage for its owner only", () => {
    const store: Record<string, string> = {};
    const storage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => void (store[k] = v),
      removeItem: (k: string) => void delete store[k],
    } as unknown as Storage;
    // The real store, pointed at this fake storage.
    const original = Object.getOwnPropertyDescriptor(window, "sessionStorage");
    Object.defineProperty(window, "sessionStorage", { value: storage, configurable: true });
    try {
      const d = updateRow(freshDraft(SAVED), 1, { name: "Kept" });
      expect(waypointsDraft.save(["abcd"], "user-1", d)).toBe(true);
      expect(waypointsDraft.load(["abcd"], "user-1")).toEqual(d);
      expect(waypointsDraft.load(["abcd"], "user-2")).toBeNull();
    } finally {
      if (original) Object.defineProperty(window, "sessionStorage", original);
    }
  });
});

describe("Add waypoint's URL", () => {
  it("carries a map tap and what the map said, and reads it back", () => {
    const details = {
      elevation: 1234.5,
      placeName: "Mount Elliot",
      peak: { name: "Mount Elliot", lat: -36.18, lon: 147.97, distanceM: 120, withinTapPx: true },
    };
    const search = newWaypointSearch(-36.181, 147.969, details);
    const seed = readNewWaypointSeed(new URLSearchParams(search));
    expect(seed.coords).toBe("-36.181000, 147.969000");
    expect(seed.details).toEqual(details);
  });

  it("trusts nothing in it that does not read", () => {
    const seed = readNewWaypointSeed(
      new URLSearchParams("?at=nowhere&pick=" + encodeURIComponent('{"elevation":"high","peak":{"name":1}}'))
    );
    expect(seed.coords).toBe("");
    expect(seed.details).toEqual({});
  });
});
