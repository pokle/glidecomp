// Copyright (c) 2026, Tushar Pokle.  All rights reserved.
import { describe, expect, test } from "bun:test";
import {
  classLabel,
  matchExisting,
  pilotKey,
  taskSeedName,
} from "./seed-identity";

describe("pilotKey", () => {
  test("keys on the federation id when there is one", () => {
    expect(pilotKey("open", "18239", "Jane Lamb")).toBe("open|id:18239");
  });

  test("falls back to the display name", () => {
    expect(pilotKey("open", null, "Jane Lamb")).toBe("open|name:Jane Lamb");
  });

  test("scopes by class, so one pilot flying two classes gets two rows", () => {
    expect(pilotKey("open", "18239", "Jane Lamb")).not.toBe(
      pilotKey("floater", "18239", "Jane Lamb"),
    );
  });

  test("a name containing the separator cannot shift the parse", () => {
    // The id/name field is last and self-describing, so a `|` inside it is
    // just data — the key still differs from any other pilot's.
    expect(pilotKey("open", null, "A|name:B")).toBe("open|name:A|name:B");
    expect(pilotKey("open", null, "A|name:B")).not.toBe(
      pilotKey("open", null, "B"),
    );
  });
});

describe("taskSeedName", () => {
  test("names a task by its class, so open and floater tasks stay distinct", () => {
    expect(taskSeedName("Task 1", "open")).toBe("Task 1 (Open)");
    expect(taskSeedName("Task 1", "floater")).toBe("Task 1 (Floater)");
  });

  test("classLabel capitalises without touching the rest", () => {
    expect(classLabel("open")).toBe("Open");
    expect(classLabel("")).toBe("");
  });
});

describe("matchExisting", () => {
  test("reuses the id of every row the source still describes", () => {
    const { reused, orphanIds } = matchExisting(
      ["Task 1 (Open)", "Task 2 (Open)"],
      [
        { id: 7, key: "Task 1 (Open)" },
        { id: 8, key: "Task 2 (Open)" },
      ],
    );
    expect(reused.get("Task 1 (Open)")).toBe(7);
    expect(reused.get("Task 2 (Open)")).toBe(8);
    expect(orphanIds).toEqual([]);
  });

  test("matches by key, not by position", () => {
    // The source reordered its tasks; the ids must follow the names.
    const { reused } = matchExisting(
      ["Task 2 (Open)", "Task 1 (Open)"],
      [
        { id: 7, key: "Task 1 (Open)" },
        { id: 8, key: "Task 2 (Open)" },
      ],
    );
    expect(reused.get("Task 1 (Open)")).toBe(7);
    expect(reused.get("Task 2 (Open)")).toBe(8);
  });

  test("a wanted key with no existing row is left for the caller to create", () => {
    const { reused, orphanIds } = matchExisting(
      ["Task 1 (Open)", "Task 3 (Open)"],
      [{ id: 7, key: "Task 1 (Open)" }],
    );
    expect(reused.has("Task 3 (Open)")).toBe(false);
    expect(orphanIds).toEqual([]);
  });

  test("an existing row the source dropped becomes an orphan", () => {
    const { reused, orphanIds } = matchExisting(
      ["Task 1 (Open)"],
      [
        { id: 7, key: "Task 1 (Open)" },
        { id: 8, key: "Task 2 (Open)" },
      ],
    );
    expect(reused.get("Task 1 (Open)")).toBe(7);
    expect(orphanIds).toEqual([8]);
  });

  test("duplicate existing rows keep the lowest id — the one older links use", () => {
    const { reused, orphanIds } = matchExisting(
      ["Task 1 (Open)"],
      [
        { id: 12, key: "Task 1 (Open)" },
        { id: 4, key: "Task 1 (Open)" },
      ],
    );
    expect(reused.get("Task 1 (Open)")).toBe(4);
    expect(orphanIds).toEqual([12]);
  });

  test("a repeated wanted key resolves to the same id", () => {
    const { reused, orphanIds } = matchExisting(
      ["open|id:1", "open|id:1"],
      [{ id: 5, key: "open|id:1" }],
    );
    expect(reused.get("open|id:1")).toBe(5);
    expect(orphanIds).toEqual([]);
  });

  test("nothing existing yet — a first seed reuses nothing and orphans nothing", () => {
    const { reused, orphanIds } = matchExisting(["a", "b"], []);
    expect(reused.size).toBe(0);
    expect(orphanIds).toEqual([]);
  });

  test("orphans are returned in ascending id order", () => {
    const { orphanIds } = matchExisting(
      [],
      [
        { id: 9, key: "c" },
        { id: 2, key: "a" },
        { id: 5, key: "b" },
      ],
    );
    expect(orphanIds).toEqual([2, 5, 9]);
  });
});
