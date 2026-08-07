/**
 * Keeps the Mapbox recordings honest.
 *
 * The whole arrangement in mapbox.ts rests on one line being drawn correctly:
 * record what a test's own inputs determine, synthesise what the camera
 * determines. Move a vector-tile or DEM prefix to the recorded side and
 * everything still passes — locally, that day, at that window size — while the
 * directory quietly grows by megabytes and the suite starts failing for anyone
 * whose camera lands a pixel differently.
 *
 * Nothing about that is visible in a diff of mapbox.ts alone, so it is checked
 * here instead. Run by `bun run test` (which sweeps ./e2e/fixtures), not by
 * Playwright.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cassetteKey, dispositionFor } from "./mapbox";

const RECORDINGS_DIR = join(import.meta.dir, "mapbox-recordings");
const INDEX_PATH = join(RECORDINGS_DIR, "index.json");

interface IndexEntry {
  url: string;
  status: number;
  contentType: string;
  file: string;
  bytes: number;
}

/**
 * A ceiling, not a target. Sized to leave room for a second style and a few
 * more elevation tiles; a change that needs it raised is exactly the change
 * that should be argued for in review.
 */
const SIZE_BUDGET_BYTES = 4 * 1024 * 1024;

describe("mapbox recordings", () => {
  const index: Record<string, IndexEntry> = existsSync(INDEX_PATH)
    ? JSON.parse(readFileSync(INDEX_PATH, "utf8"))
    : {};
  const entries = Object.entries(index);

  test("the index is populated", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  test("every indexed recording has its file on disk", () => {
    for (const [key, entry] of entries) {
      expect(existsSync(join(RECORDINGS_DIR, entry.file)), `${key} → ${entry.file}`).toBe(true);
    }
  });

  test("only camera-independent responses are recorded", () => {
    for (const [key, entry] of entries) {
      expect(dispositionFor(entry.url), `${key} should not be recorded`).toBe("record");
    }
  });

  test("each entry is filed under the key its URL derives", () => {
    for (const [key, entry] of entries) {
      expect(cassetteKey("GET", entry.url)).toBe(key);
    }
  });

  /**
   * The index is committed, and `access_token` carries the live Mapbox token.
   * An earlier version of this checked only the key and the filename, kept the
   * raw URL in `url` for readability, and was stopped by GitHub's push
   * protection — so check every field of every entry, not the ones that seemed
   * likely at the time. The raw bodies are covered too: a style JSON that came
   * back with a tokenised tile URL would be just as committed.
   */
  test("no access token reaches disk, in any field or any body", () => {
    for (const [key, entry] of entries) {
      const serialised = `${key} ${JSON.stringify(entry)}`;
      expect(serialised).not.toContain("access_token");
      expect(serialised).not.toMatch(/\bpk\.ey/);
    }
    for (const [, entry] of entries) {
      const body = readFileSync(join(RECORDINGS_DIR, entry.file));
      expect(body.includes("pk.ey"), `${entry.file} embeds a token`).toBe(false);
    }
  });

  test(`the recordings stay under ${SIZE_BUDGET_BYTES / 1024 / 1024} MB`, () => {
    const total = entries.reduce((sum, [, e]) => sum + e.bytes, 0);
    expect(total).toBeLessThan(SIZE_BUDGET_BYTES);
  });

  test("recordings live beside the fixtures that serve them", () => {
    expect(dirname(RECORDINGS_DIR)).toBe(import.meta.dir);
  });
});
