// Copyright (c) 2026, Tushar Pokle.  All rights reserved.
import { describe, expect, test } from "bun:test";
import { orphanedTrackKeys, trackSyncDecision } from "./seed-track-sync";

const SHA = "a".repeat(64);

describe("trackSyncDecision", () => {
  test("skips the upload when the stored hash matches, keeping the stored size", () => {
    expect(trackSyncDecision({ hash: SHA, size: 41000 }, SHA, 41003)).toEqual({
      upload: false,
      fileSize: 41000,
    });
  });

  test("a NULL stored hash never skips — content unknown means re-upload", () => {
    expect(trackSyncDecision({ hash: null, size: 41000 }, SHA, 41003)).toEqual({
      upload: true,
      fileSize: 41003,
    });
  });

  test("a different hash re-uploads (a user-replaced track gets fixed back up)", () => {
    expect(
      trackSyncDecision({ hash: "b".repeat(64), size: 41000 }, SHA, 41003),
    ).toEqual({ upload: true, fileSize: 41003 });
  });

  test("no previous row uploads", () => {
    expect(trackSyncDecision(undefined, SHA, 41003)).toEqual({
      upload: true,
      fileSize: 41003,
    });
  });
});

describe("orphanedTrackKeys", () => {
  test("returns only the previous seed's keys nothing claimed this time", () => {
    const old = ["c/1/t/1/10.igc", "c/1/t/1/11.igc", "c/1/t/2/10.igc"];
    const live = new Set(["c/1/t/1/10.igc", "c/1/t/2/10.igc", "c/1/t/2/12.igc"]);
    expect(orphanedTrackKeys(old, live)).toEqual(["c/1/t/1/11.igc"]);
  });
});
