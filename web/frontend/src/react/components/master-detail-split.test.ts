import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MASTER_SHARE,
  MAX_MASTER_SHARE,
  MIN_MASTER_SHARE,
  clampMasterShare,
  collapseStorageKey,
  masterShareFromPointer,
  readStoredCollapsed,
  splitStorageKey,
  writeStoredCollapsed,
} from "./master-detail-split";

describe("clampMasterShare", () => {
  it("keeps the original 5/8 split inside the usable range", () => {
    expect(DEFAULT_MASTER_SHARE).toBeGreaterThan(MIN_MASTER_SHARE);
    expect(DEFAULT_MASTER_SHARE).toBeLessThan(MAX_MASTER_SHARE);
    expect(clampMasterShare(DEFAULT_MASTER_SHARE)).toBe(DEFAULT_MASTER_SHARE);
  });

  it("refuses a sliver of either pane, and junk", () => {
    expect(clampMasterShare(0)).toBe(MIN_MASTER_SHARE);
    expect(clampMasterShare(1)).toBe(MAX_MASTER_SHARE);
    expect(clampMasterShare(Number.NaN)).toBe(DEFAULT_MASTER_SHARE);
  });
});

describe("masterShareFromPointer", () => {
  const grid = { left: 100, width: 500 };
  const splitter = 24;

  it("reads the list share from the pointer, not including the handle", () => {
    // Midway along the leftover (500 − 24): list and detail even.
    const mid = 100 + 24 / 2 + (500 - 24) / 2;
    expect(masterShareFromPointer(mid, grid, splitter)).toBeCloseTo(0.5, 5);
  });

  it("clamps at the edges of the grid", () => {
    expect(masterShareFromPointer(grid.left, grid, splitter)).toBe(MIN_MASTER_SHARE);
    expect(masterShareFromPointer(grid.left + grid.width, grid, splitter)).toBe(
      MAX_MASTER_SHARE
    );
  });
});

describe("splitStorageKey", () => {
  it("is per detail noun, so a chart split cannot steal the map's", () => {
    expect(splitStorageKey("chart")).not.toBe(splitStorageKey("map"));
  });
});

describe("collapseStorageKey", () => {
  it("is per detail noun, so a folded chart does not fold the map", () => {
    expect(collapseStorageKey("chart")).not.toBe(collapseStorageKey("map"));
  });

  it("does not collide with the split share for the same noun", () => {
    expect(collapseStorageKey("map")).not.toBe(splitStorageKey("map"));
  });
});

describe("the remembered fold", () => {
  beforeEach(() => window.localStorage.clear());

  it("says nothing until the reader has folded or unfolded", () => {
    expect(readStoredCollapsed("map")).toBeNull();
  });

  it("round-trips both answers — unfolded is a real answer, not silence", () => {
    writeStoredCollapsed("map", true);
    expect(readStoredCollapsed("map")).toBe(true);
    writeStoredCollapsed("map", false);
    expect(readStoredCollapsed("map")).toBe(false);
  });

  it("keeps one pane's answer out of another's", () => {
    writeStoredCollapsed("map", true);
    expect(readStoredCollapsed("score-map")).toBeNull();
  });

  it("reads junk as no answer rather than as folded", () => {
    window.localStorage.setItem(collapseStorageKey("map"), "yes");
    expect(readStoredCollapsed("map")).toBeNull();
  });
});
