/**
 * Mapbox, made deterministic — and reachable at all.
 *
 * Two separate problems live here, and it is worth keeping them apart.
 *
 * ## 1. The browser may have no route to Mapbox
 *
 * In a sandboxed container (Claude Code's web containers are the case that
 * forced this) Chromium's egress is closed: every external HTTPS request dies
 * with `net::ERR_CONNECTION_RESET` after ~13s, whatever the destination — a
 * bare IP fails the same way, so it is neither DNS nor TLS nor anything
 * Mapbox-specific. Pointing Chromium at the agent proxy does not help either.
 * The Node side of Playwright *can* reach the network, and `route.fetch()`
 * runs there — so every handler below fetches Node-side and fulfils into the
 * browser. That costs nothing on a normal runner, where the browser could have
 * fetched it itself, so it is unconditional rather than a special case.
 *
 * The failure this prevents is a nasty one. With no route to Mapbox the map
 * still *looks* alive: `.mapboxgl-canvas` mounts, the zoom/compass/fullscreen
 * controls and the Mapbox logo all render, and NOTHING is logged to the
 * console — the style request simply never returns. A test asserting the
 * canvas is visible passes against a blank map for ever.
 *
 * ## 2. Live tiles make a test suite non-deterministic
 *
 * A full analysis page pulls 7-27 MB over 100-350 requests, and the tile set
 * is a function of the camera: one zoom-in click asks for 48 tiles nobody
 * asked for before. Committing that is neither cheap nor stable, and running
 * it live burns the Mapbox quota on every CI run.
 *
 * So the APIs are split by what their URL is keyed by:
 *
 *  - RECORDED (`FIXTURED`) — keyed by something a test controls, so the same
 *    test always asks for the same bytes:
 *      * `/styles/v1/…`            the style JSON and its iconsets
 *      * `/fonts/v1/…`             glyph ranges
 *      * `/search/geocode/v6/…`    keyed by the query string
 *      * `/v4/mapbox.terrain-rgb/` `analysis/elevation.ts` pins zoom 13, so the
 *                                  tile is a pure function of lat/lon — camera,
 *                                  viewport and window size cannot shift it
 *  - STUBBED — keyed by the camera, so no recording survives a pan, a zoom or
 *    a different viewport size:
 *      * `/v4/<vector tilesets>/`  answered with an empty vector tile
 *      * `/raster/v1/…`            answered with flat synthetic Terrain-RGB
 *      * `/3dtiles/v1/…`           empty (Mapbox answers these empty anyway)
 *  - DROPPED — `events.mapbox.com` telemetry and `/map-sessions/` billing.
 *
 * Stubbing the render tiles costs less than it sounds. Everything worth
 * asserting on the analysis page — track geometry, turnpoint circles, glide
 * labels, hover/click picking, layer toggles — is drawn by US, in GeoJSON
 * layers on top of the basemap. Those need the style to load so the map fires
 * `load` and accepts layers; they do not need the imagery underneath.
 *
 * The exception is `queryTerrainElevation()`, which reads real DEM pixels
 * (mapbox-provider.ts:190, :433, :1592). Against the flat stub it reads 0 m
 * everywhere. A test that turns on that behaviour wants `MAPBOX_LIVE=1`, or
 * should asserted against `analysis/elevation.ts` instead, whose tiles ARE
 * recorded.
 *
 * ## Modes
 *
 *   (default)          replay: recordings from disk, stubs for the rest.
 *                      Offline, deterministic. A recording that is missing
 *                      FAILS the test rather than quietly reaching the
 *                      network — see `assertComplete()`.
 *   MAPBOX_RECORD=1    fetch the recorded families live and write them to
 *                      disk. Stubs still apply, so what you record is exactly
 *                      what replay will serve.
 *   MAPBOX_LIVE=1      everything live, nothing read from or written to disk.
 *                      For the live smoke test, and for checking whether a
 *                      replay failure is ours or Mapbox's.
 *
 * Recording needs a token: `VITE_MAPBOX_TOKEN` must be set (the same one the
 * app builds with). Replay does not — the token is stripped from the key, so
 * recordings are portable across tokens and a build with no token at all can
 * still replay them.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import type { BrowserContext, Route } from "@playwright/test";

/**
 * Where recordings live. One file per response, plus a readable index.
 *
 * `import.meta.dir` would be shorter, but it is a Bun extension and Playwright
 * loads this file through Node — where it is `undefined`, and `join()` then
 * fails at import time with a path error that names none of this.
 */
const RECORDINGS_DIR = join(dirname(fileURLToPath(import.meta.url)), "mapbox-recordings");
const INDEX_PATH = join(RECORDINGS_DIR, "index.json");

export type MapboxMode = "replay" | "record" | "live";

export function mapboxMode(): MapboxMode {
  if (process.env.MAPBOX_LIVE) return "live";
  if (process.env.MAPBOX_RECORD) return "record";
  return "replay";
}

/** How a given URL is handled. */
type Disposition = "record" | "stub-vector" | "stub-dem" | "stub-empty" | "drop";

/**
 * Params that change without the response changing in any way a test cares
 * about. Stripping them keeps recordings portable across tokens and survives a
 * mapbox-gl patch bump, which would otherwise invalidate every file at once.
 */
const VOLATILE_PARAMS = ["access_token", "sdk", "events", "language"];

/**
 * A URL with the volatile params taken out.
 *
 * This is a SECRETS boundary as much as a normalisation one: `access_token`
 * carries the live Mapbox token, and anything derived from a raw URL ends up
 * committed — GitHub's push protection rejected exactly that, from the `url`
 * field the index keeps for humans to read. Nothing that reaches disk may be
 * built from the unredacted URL.
 */
export function redactUrl(rawUrl: string): string {
  const u = new URL(rawUrl);
  for (const p of VOLATILE_PARAMS) u.searchParams.delete(p);
  u.searchParams.sort();
  return u.toString();
}

/** The stable identity of a request: method + URL minus the volatile params. */
export function cassetteKey(method: string, rawUrl: string): string {
  const u = new URL(redactUrl(rawUrl));
  return `${method} ${u.host}${u.pathname}${u.search}`;
}

export function dispositionFor(rawUrl: string): Disposition {
  const u = new URL(rawUrl);
  const p = u.pathname;

  if (u.host.includes("events.mapbox.com")) return "drop";
  if (p.startsWith("/map-sessions")) return "drop";

  if (p.startsWith("/styles/v1")) return "record";
  if (p.startsWith("/fonts/v1")) return "record";
  if (p.startsWith("/search/geocode")) return "record";
  // elevation.ts pins zoom 13 and derives x/y from lat/lon alone.
  if (p.startsWith("/v4/mapbox.terrain-rgb")) return "record";

  if (p.startsWith("/raster/v1")) return "stub-dem";
  if (p.startsWith("/3dtiles/v1")) return "stub-empty";
  if (p.startsWith("/v4/")) return "stub-vector";

  // Anything new Mapbox starts asking for: stub it empty rather than let it
  // reach the network, and say so, so the omission is visible instead of slow.
  return "stub-empty";
}

/** Readable half of a recording's filename, so the directory can be skimmed. */
function slugFor(rawUrl: string): string {
  const p = new URL(rawUrl).pathname;
  return (
    p
      .replace(/^\/+|\/+$/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .slice(0, 60) || "root"
  );
}

function extensionFor(contentType: string): string {
  if (contentType.includes("json")) return "json";
  if (contentType.includes("protobuf") || contentType.includes("pbf")) return "pbf";
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("jpeg")) return "jpg";
  return "bin";
}

interface IndexEntry {
  /**
   * The URL this came from, redacted — for a human reading the index. Never
   * the raw one: it carries the access token, and this file is committed.
   */
  url: string;
  status: number;
  contentType: string;
  file: string;
  bytes: number;
}

type CassetteIndex = Record<string, IndexEntry>;

function loadIndex(): CassetteIndex {
  if (!existsSync(INDEX_PATH)) return {};
  return JSON.parse(readFileSync(INDEX_PATH, "utf8")) as CassetteIndex;
}

function saveIndex(index: CassetteIndex): void {
  mkdirSync(RECORDINGS_DIR, { recursive: true });
  // Sorted, so re-recording one endpoint produces a one-line diff rather than
  // a reshuffled file.
  const sorted: CassetteIndex = {};
  for (const k of Object.keys(index).sort()) sorted[k] = index[k];
  writeFileSync(INDEX_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
}

// --- synthetic stub bodies ---------------------------------------------------

/**
 * An empty vector tile. A zero-length body is a valid empty protobuf, which
 * mapbox-gl reads as "this tile has no features" — exactly what we want the
 * basemap to be.
 */
const EMPTY_VECTOR_TILE = Buffer.alloc(0);

/** CRC32, for the PNG chunks below. Node's zlib.crc32 is too new to rely on. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

/**
 * A flat Terrain-RGB tile: every pixel encodes the same ground elevation.
 *
 * Mapbox's DEM encoding is `height = -10000 + (R*65536 + G*256 + B) * 0.1`, so
 * 0 m is the 24-bit value 100000 — RGB(1, 134, 160). Built rather than
 * committed because a solid 512x512 PNG deflates to well under a kilobyte and
 * a generated one can never drift from the comment explaining it.
 */
function flatTerrainRgbPng(metres = 0): Buffer {
  const size = 512;
  const v = Math.round((metres + 10000) / 0.1);
  const r = (v >> 16) & 0xff;
  const g = (v >> 8) & 0xff;
  const b = v & 0xff;

  // Each scanline is a filter byte (0 = none) followed by RGB triples.
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x++) {
    row[1 + x * 3] = r;
    row[2 + x * 3] = g;
    row[3 + x * 3] = b;
  }
  const raw = Buffer.concat(Array.from({ length: size }, () => row));

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Built once per process — it is the same bytes for every tile. */
let flatDemPng: Buffer | null = null;

// --- the handler -------------------------------------------------------------

export interface MapboxHandle {
  readonly mode: MapboxMode;
  /** Recording keys asked for in replay mode that are not on disk. */
  readonly missing: readonly string[];
  /** Counts by disposition, for a test that wants to assert traffic shape. */
  readonly counts: Readonly<Record<string, number>>;
  /** Fail the test if replay had to answer a request it had no recording for. */
  assertComplete(): void;
}

export interface InstallMapboxOptions {
  /**
   * Ground elevation the stubbed DEM reports, in metres. Only matters for a
   * test that reads `queryTerrainElevation()`; the default flat 0 m is right
   * for everything that just wants terrain to exist.
   */
  demElevationM?: number;
}

/**
 * Install the Mapbox handler on a browser context. Call before the navigation
 * that loads a map — `context.route` only applies to requests made after it is
 * registered.
 */
export async function installMapbox(
  context: BrowserContext,
  options: InstallMapboxOptions = {},
): Promise<MapboxHandle> {
  const mode = mapboxMode();
  const index = mode === "live" ? {} : loadIndex();
  const missing: string[] = [];
  const counts: Record<string, number> = {};
  const token = process.env.VITE_MAPBOX_TOKEN;

  if (mode === "record" && !token) {
    throw new Error(
      "MAPBOX_RECORD=1 needs VITE_MAPBOX_TOKEN set — recording talks to the real API.",
    );
  }

  const bump = (k: string) => {
    counts[k] = (counts[k] ?? 0) + 1;
  };

  await context.route(/https:\/\/[^/]*mapbox\.com\//, async (route: Route) => {
    const request = route.request();
    const url = request.url();
    const disposition = mode === "live" ? "record" : dispositionFor(url);

    if (disposition === "drop") {
      bump("dropped");
      return route.abort();
    }

    if (disposition === "stub-vector") {
      bump("stub-vector");
      return route.fulfill({
        status: 200,
        headers: { "content-type": "application/x-protobuf", "access-control-allow-origin": "*" },
        body: EMPTY_VECTOR_TILE,
      });
    }

    if (disposition === "stub-dem") {
      bump("stub-dem");
      flatDemPng ??= flatTerrainRgbPng(options.demElevationM ?? 0);
      return route.fulfill({
        status: 200,
        headers: { "content-type": "image/png", "access-control-allow-origin": "*" },
        body: flatDemPng,
      });
    }

    if (disposition === "stub-empty") {
      bump("stub-empty");
      return route.fulfill({
        status: 200,
        headers: { "content-type": "application/octet-stream", "access-control-allow-origin": "*" },
        body: Buffer.alloc(0),
      });
    }

    // --- a recorded family ---
    const key = cassetteKey(request.method(), url);

    if (mode === "replay") {
      const entry = index[key];
      if (!entry) {
        bump("missing");
        if (!missing.includes(key)) {
          missing.push(key);
          // Said HERE, not only in assertComplete(), because a missing
          // recording usually breaks a product assertion first — the geocoder
          // renders "Search is unavailable right now." and the test fails on
          // that, several lines before any fixture check runs. Without this
          // line the output would describe the symptom and never the cause.
          console.error(
            `[mapbox] no recording for ${key}\n` +
              `[mapbox] re-record with: MAPBOX_RECORD=1 VITE_MAPBOX_TOKEN=… bunx playwright test <spec>`,
          );
        }
        // Abort rather than fall through to the network: on a sandboxed
        // runner that would hang for 13s and then fail for the wrong reason.
        return route.abort();
      }
      bump("replayed");
      return route.fulfill({
        status: entry.status,
        headers: {
          "content-type": entry.contentType,
          "access-control-allow-origin": "*",
        },
        body: readFileSync(join(RECORDINGS_DIR, entry.file)),
      });
    }

    // record | live — go to the real API from the Node side.
    //
    // Retried once, because a single dropped tile is not an answer: in record
    // mode it would be written down as a failure and cached for ever, and in
    // live mode it fails a test for the network's reasons rather than ours.
    // `fetchElevations` asks for four tiles at once and needs all four, which
    // is where this first bit.
    let response: import("@playwright/test").APIResponse | null = null;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2 && !response; attempt++) {
      try {
        response = await route.fetch({ timeout: 30_000 });
      } catch (error) {
        lastError = error;
      }
    }
    if (!response) {
      bump("relay-failed");
      console.error(`[mapbox] relay failed for ${url.slice(0, 100)}: ${String(lastError)}`);
      return route.abort();
    }
    const body = await response.body();
    const contentType = response.headers()["content-type"] ?? "application/octet-stream";

    if (mode === "record" && response.ok()) {
      mkdirSync(RECORDINGS_DIR, { recursive: true });
      const hash = createHash("sha256").update(key).digest("hex").slice(0, 12);
      const file = `${slugFor(url)}_${hash}.${extensionFor(contentType)}`;
      writeFileSync(join(RECORDINGS_DIR, file), body);
      index[key] = {
        url: redactUrl(url),
        status: response.status(),
        contentType,
        file,
        bytes: body.length,
      };
      saveIndex(index);
      bump("recorded");
    } else {
      bump("live");
    }

    return route.fulfill({ response, body });
  });

  return {
    mode,
    missing,
    counts,
    assertComplete() {
      if (missing.length === 0) return;
      throw new Error(
        `Mapbox replay is missing ${missing.length} recording(s):\n` +
          missing.map((m) => `  ${m}`).join("\n") +
          `\n\nRe-record with:\n` +
          `  MAPBOX_RECORD=1 VITE_MAPBOX_TOKEN=… bunx playwright test <this spec>\n`,
      );
    },
  };
}

/** Total size on disk, for the guard test that keeps the recordings honest. */
export function recordingsSize(): { files: number; bytes: number } {
  if (!existsSync(RECORDINGS_DIR)) return { files: 0, bytes: 0 };
  const index = loadIndex();
  const bytes = Object.values(index).reduce((a, e) => a + e.bytes, 0);
  return { files: readdirSync(RECORDINGS_DIR).length, bytes };
}
