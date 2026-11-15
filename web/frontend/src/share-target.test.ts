// @vitest-environment node
/**
 * The share target's two halves must agree (issue #800): what public/sw.js
 * writes into Cache Storage is what /submit and the analysis page read back,
 * and the manifest keeps the identity existing installs were made under.
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SHARE_CACHE,
  clearSharedFiles,
  readSharedFiles,
  sharedFileName,
} from "./share-target";

/** Just enough CacheStorage for the reader, holding what sw.js would put. */
function fakeStorage(entries: Array<[string, Response]> | null) {
  const buckets = new Map<string, Map<string, Response>>();
  if (entries) buckets.set(SHARE_CACHE, new Map(entries));
  const storage = {
    has: async (name: string) => buckets.has(name),
    open: async (name: string) => {
      const bucket = buckets.get(name) ?? new Map<string, Response>();
      buckets.set(name, bucket);
      return {
        keys: async () => [...bucket.keys()].map((url) => new Request(url)),
        match: async (req: Request) => bucket.get(req.url)?.clone(),
      };
    },
    delete: async (name: string) => buckets.delete(name),
  };
  return { storage: storage as unknown as CacheStorage, buckets };
}

/** An entry exactly as sw.js writes it. */
function asSwStores(name: string, body: string, type = "application/octet-stream") {
  return [
    `https://glidecomp.com/shared-file/${encodeURIComponent(name)}`,
    new Response(body, { headers: { "Content-Type": type, "X-File-Name": name } }),
  ] as [string, Response];
}

describe("readSharedFiles", () => {
  test("returns the shared file with its own name and contents", async () => {
    const { storage } = fakeStorage([asSwStores("2026-01-07-XCT-MCG-01.igc", "AXCT\nB123\n")]);
    const files = await readSharedFiles(storage);
    expect(files.map((f) => f.name)).toEqual(["2026-01-07-XCT-MCG-01.igc"]);
    expect(await files[0].text()).toBe("AXCT\nB123\n");
  });

  test("keeps the order the files were shared in", async () => {
    const { storage } = fakeStorage([asSwStores("task.xctsk", "{}"), asSwStores("a.igc", "A")]);
    expect((await readSharedFiles(storage)).map((f) => f.name)).toEqual(["task.xctsk", "a.igc"]);
  });

  test("is empty, not an error, when nothing was shared", async () => {
    expect(await readSharedFiles(fakeStorage(null).storage)).toEqual([]);
    expect(await readSharedFiles(undefined)).toEqual([]);
  });

  test("is empty when Cache Storage refuses", async () => {
    const broken = {
      has: async () => {
        throw new Error("SecurityError");
      },
    } as unknown as CacheStorage;
    expect(await readSharedFiles(broken)).toEqual([]);
  });

  test("clearSharedFiles forgets the share", async () => {
    const { storage, buckets } = fakeStorage([asSwStores("a.igc", "A")]);
    await clearSharedFiles(storage);
    expect(buckets.has(SHARE_CACHE)).toBe(false);
    expect(await readSharedFiles(storage)).toEqual([]);
  });
});

describe("sharedFileName", () => {
  test("prefers X-File-Name", () => {
    const headers = new Headers({ "X-File-Name": "flight #2?.igc" });
    expect(sharedFileName("https://x/shared-file/whatever", headers)).toBe("flight #2?.igc");
  });

  test("falls back to the decoded cache key (SEC-13 encodes it)", () => {
    const url = `https://x/shared-file/${encodeURIComponent("flight #2?.igc")}`;
    expect(sharedFileName(url, new Headers())).toBe("flight #2?.igc");
  });

  test("survives a key that is not valid percent-encoding", () => {
    expect(sharedFileName("https://x/shared-file/100%.igc", new Headers())).toBe("100%.igc");
  });
});

describe("manifest.webmanifest", () => {
  const manifest = JSON.parse(
    readFileSync(join(__dirname, "../public/manifest.webmanifest"), "utf8")
  ) as {
    id?: string;
    start_url: string;
    share_target: { action: string; params: { files: Array<{ accept: string[] }> } };
  };

  test("keeps the id existing installs were made under", () => {
    // Without an `id`, Chrome derives the app's identity from start_url, and
    // every install before #800 was made when that was /analysis.html. Moving
    // start_url without pinning the id would make those installs a different
    // app that never receives this manifest's updates — including the
    // share-target fix itself.
    expect(manifest.id).toBe("/analysis.html");
  });

  test("opens on a page a signed-out pilot can use", () => {
    expect(manifest.start_url).toBe("/comp");
  });

  test("accepts the MIME types the flight apps share an IGC as", () => {
    const accept = manifest.share_target.params.files[0].accept;
    // XCTrack shares as application/igc. Android matches on MIME type and
    // ignores the `.igc` extension entry, so without this GlideComp is not
    // even offered in XCTrack's share sheet.
    expect(accept).toContain("application/igc");
    // SeeYou Navigator and the Files app share as application/octet-stream.
    expect(accept).toContain("application/octet-stream");
  });

  test("posts the share where the service worker listens", () => {
    expect(manifest.share_target.action).toBe("/share-target");
    const sw = readFileSync(join(__dirname, "../public/sw.js"), "utf8");
    expect(sw).toContain("url.pathname === '/share-target'");
    expect(sw).toContain(`const SHARE_CACHE = '${SHARE_CACHE}'`);
  });
});
