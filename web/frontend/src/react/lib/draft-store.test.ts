/**
 * Drafts that survive navigation (draft-store.ts): what a load gives back, and
 * every case in which it must give back nothing.
 */
import { describe, expect, it } from "vitest";
import {
  clearAllDrafts,
  defineDraft,
  draftStorageKey,
  DEFAULT_DRAFT_MAX_AGE_MS,
  DRAFT_PREFIX,
} from "./draft-store";

/** A Storage in memory, which can be told to refuse writes like a full one. */
class MemoryStorage implements Storage {
  private items = new Map<string, string>();
  full = false;
  get length() {
    return this.items.size;
  }
  clear() {
    this.items.clear();
  }
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  key(i: number) {
    return [...this.items.keys()][i] ?? null;
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
  setItem(key: string, value: string) {
    if (this.full) throw new DOMException("full", "QuotaExceededError");
    this.items.set(key, value);
  }
}

interface FileDraft {
  fileName: string;
  text: string;
}

function setup(version = 1, maxAgeMs?: number) {
  const storage = new MemoryStorage();
  let clock = 1_000_000;
  const store = defineDraft<FileDraft>({
    kind: "roster-import",
    version,
    maxAgeMs,
    isValid: (v): v is FileDraft =>
      typeof v === "object" &&
      v !== null &&
      typeof (v as FileDraft).fileName === "string" &&
      typeof (v as FileDraft).text === "string",
    now: () => clock,
    storage: () => storage,
  });
  return {
    storage,
    store,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

const FILE: FileDraft = { fileName: "roster.csv", text: "name,class\nAda,open" };

describe("defineDraft", () => {
  it("gives back what was saved, to the user who saved it", () => {
    const { store } = setup();
    expect(store.save(["c1"], "u1", FILE)).toBe(true);
    expect(store.load(["c1"], "u1")).toEqual(FILE);
  });

  it("keeps one draft per key", () => {
    const { store } = setup();
    store.save(["c1"], "u1", FILE);
    store.save(["c2"], "u1", { ...FILE, fileName: "other.csv" });
    expect(store.load(["c1"], "u1")?.fileName).toBe("roster.csv");
    expect(store.load(["c2"], "u1")?.fileName).toBe("other.csv");
    expect(store.load(["c3"], "u1")).toBeNull();
  });

  it("a later save replaces the draft", () => {
    const { store } = setup();
    store.save(["c1"], "u1", FILE);
    store.save(["c1"], "u1", { ...FILE, fileName: "again.csv" });
    expect(store.load(["c1"], "u1")?.fileName).toBe("again.csv");
  });

  it("clear forgets it", () => {
    const { store } = setup();
    store.save(["c1"], "u1", FILE);
    store.clear(["c1"]);
    expect(store.load(["c1"], "u1")).toBeNull();
  });

  it("never gives one account's draft to another, and does not keep it", () => {
    const { store, storage } = setup();
    store.save(["c1"], "u1", FILE);
    expect(store.load(["c1"], "u2")).toBeNull();
    expect(storage.length).toBe(0);
    expect(store.load(["c1"], "u1")).toBeNull();
  });

  it("throws away a draft saved in another shape", () => {
    const old = setup(1);
    old.store.save(["c1"], "u1", FILE);
    const next = defineDraft<FileDraft>({
      kind: "roster-import",
      version: 2,
      storage: () => old.storage,
    });
    expect(next.load(["c1"], "u1")).toBeNull();
    expect(old.storage.length).toBe(0);
  });

  it("throws away a value its own check refuses", () => {
    const { store, storage } = setup();
    storage.setItem(
      draftStorageKey("roster-import", ["c1"]),
      JSON.stringify({ v: 1, owner: "u1", at: 1_000_000, value: { fileName: 3 } })
    );
    expect(store.load(["c1"], "u1")).toBeNull();
    expect(storage.length).toBe(0);
  });

  it("throws away what is not a draft at all", () => {
    const { store, storage } = setup();
    storage.setItem(draftStorageKey("roster-import", ["c1"]), "{not json");
    expect(store.load(["c1"], "u1")).toBeNull();
    storage.setItem(draftStorageKey("roster-import", ["c1"]), JSON.stringify("text"));
    expect(store.load(["c1"], "u1")).toBeNull();
    expect(storage.length).toBe(0);
  });

  it("throws away a draft older than its age limit", () => {
    const { store, tick } = setup();
    store.save(["c1"], "u1", FILE);
    tick(DEFAULT_DRAFT_MAX_AGE_MS);
    expect(store.load(["c1"], "u1")).toEqual(FILE);
    tick(1);
    expect(store.load(["c1"], "u1")).toBeNull();
  });

  it("honours a shorter age limit", () => {
    const { store, tick } = setup(1, 1000);
    store.save(["c1"], "u1", FILE);
    tick(1001);
    expect(store.load(["c1"], "u1")).toBeNull();
  });

  it("says so when storage refuses the draft", () => {
    const { store, storage } = setup();
    storage.full = true;
    expect(store.save(["c1"], "u1", FILE)).toBe(false);
    expect(store.load(["c1"], "u1")).toBeNull();
  });

  it("does nothing, and fails nothing, where there is no storage", () => {
    const store = defineDraft<FileDraft>({ kind: "k", version: 1, storage: () => null });
    expect(store.save(["c1"], "u1", FILE)).toBe(false);
    expect(store.load(["c1"], "u1")).toBeNull();
    expect(() => store.clear(["c1"])).not.toThrow();
  });

  it("keeps kinds apart, and a key part cannot forge another key", () => {
    expect(draftStorageKey("a", ["c1", "t1"])).not.toBe(draftStorageKey("a", ["c1/t1"]));
    expect(draftStorageKey("a", ["c1"])).not.toBe(draftStorageKey("b", ["c1"]));
    expect(draftStorageKey("a", ["c1"]).startsWith(DRAFT_PREFIX)).toBe(true);
  });
});

describe("clearAllDrafts", () => {
  it("removes every draft and nothing else", () => {
    const { store, storage } = setup();
    store.save(["c1"], "u1", FILE);
    store.save(["c2"], "u1", FILE);
    storage.setItem("glidecomp:preview-role", "pilot");
    clearAllDrafts(storage);
    expect(storage.length).toBe(1);
    expect(storage.getItem("glidecomp:preview-role")).toBe("pilot");
  });
});
