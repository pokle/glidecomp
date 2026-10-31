// @vitest-environment node
import { describe, expect, test } from "vitest";
import { loadResultsRecord } from "../react/loaders";
import { serveResultsRecord } from "./serve";
import { readRecord, readZip } from "./read-pdf";
import { fixture, ORIGIN, readFonts } from "./test-fixture";

const NOW = new Date("2020-12-21T01:02:03Z");

/** The competition API as the loader sees it, from the fixture, recording
 * every path asked for. `override` answers a path first. */
function fakeApi(override: (path: string) => Response | null = () => null) {
  const data = fixture();
  const calls: string[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetch = async (path: string) => {
    calls.push(path);
    const o = override(path);
    if (o) return o;
    if (path === "/api/comp/c1") return json(data.comp);
    if (path === "/api/comp/c1/scores") return json(data.scores);
    if (path.startsWith("/api/comp/c1/audit")) return json({ entries: data.audit, has_more: false, next_before: null });
    const m = path.match(/^\/api\/comp\/c1\/task\/(t\d)(\/score)?$/);
    if (m) {
      const t = data.tasks.find((x) => x.task.task_id === m[1])!;
      if (!m[2]) return json(t.task);
      return t.score ? json(t.score) : json({ error: "no route" }, 422);
    }
    return json({ error: "Not found" }, 404);
  };
  return { fetch, calls, data };
}

function serve(
  api: ReturnType<typeof fakeApi>,
  segment = "unungra-cup-2020-c1",
  format: "pdf" | "zip" = "pdf"
) {
  return serveResultsRecord({
    fetch: api.fetch,
    segment,
    format,
    origin: ORIGIN,
    loadFonts: async () => readFonts(),
    now: NOW,
  });
}

describe("serveResultsRecord", () => {
  test("an admin gets the PDF as a dated download", async () => {
    const res = await serve(fakeApi());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="unungra-cup-2020-results-2020-12-21.pdf"'
    );
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
    const head = new TextDecoder().decode((await res.arrayBuffer()).slice(0, 5));
    expect(head).toBe("%PDF-");
  });

  test("any visitor gets it, not only the comp's admins", async () => {
    const api = fakeApi((path) =>
      path === "/api/comp/c1"
        ? new Response(JSON.stringify({ ...fixture().comp, is_admin: false }), { status: 200 })
        : null
    );
    const res = await serve(api);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
  });

  test("the ZIP holds the PDF's attachments, in one folder named like it", async () => {
    let fontsLoaded = false;
    const res = await serveResultsRecord({
      fetch: fakeApi().fetch,
      segment: "unungra-cup-2020-c1",
      format: "zip",
      origin: ORIGIN,
      loadFonts: async () => {
        fontsLoaded = true;
        return readFonts();
      },
      now: NOW,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="unungra-cup-2020-results-2020-12-21.zip"'
    );
    // Nothing in a ZIP is drawn, so the fonts are never fetched.
    expect(fontsLoaded).toBe(false);

    const zipped = readZip(new Uint8Array(await res.arrayBuffer()));
    const pdf = await readRecord(
      new Uint8Array(await (await serve(fakeApi())).arrayBuffer())
    );
    const folder = "unungra-cup-2020-results-2020-12-21/";
    expect([...zipped.keys()].sort()).toEqual([...pdf.attachments.keys()].map((n) => folder + n).sort());
    for (const [name, file] of pdf.attachments) expect(zipped.get(folder + name)).toBe(file.text);
  });

  test("a comp that does not exist — or is hidden from this visitor — is a 404", async () => {
    const res = await serve(fakeApi(), "nope-zz");
    expect(res.status).toBe(404);
  });

  test(
    "a task whose scores will not load fails the export rather than leave a day out",
    async () => {
      const api = fakeApi((path) =>
        path === "/api/comp/c1/task/t1/score" ? new Response("boom", { status: 500 }) : null
      );
      const res = await serve(api);
      expect(res.status).toBe(503);
      // Retried before giving up (issue #481).
      expect(api.calls.filter((p) => p === "/api/comp/c1/task/t1/score")).toHaveLength(3);
    },
    10_000
  );

  test("a task with no route is fetched once and not scored", async () => {
    const api = fakeApi();
    await serve(api);
    expect(api.calls).toContain("/api/comp/c1/task/t2");
    expect(api.calls).not.toContain("/api/comp/c1/task/t2/score");
  });
});

describe("loadResultsRecord", () => {
  test("pages through the whole audit log", async () => {
    const entry = (id: number) => ({ ...fixture().audit[0], audit_id: id });
    const api = fakeApi((path) => {
      if (path === "/api/comp/c1/audit?limit=200")
        return new Response(JSON.stringify({ entries: [entry(3), entry(2)], has_more: true, next_before: 2 }));
      if (path === "/api/comp/c1/audit?limit=200&before=2")
        return new Response(JSON.stringify({ entries: [entry(1)], has_more: false, next_before: null }));
      return null;
    });
    const data = await loadResultsRecord(api.fetch, "c1");
    expect(data.audit.map((e) => e.audit_id)).toEqual([3, 2, 1]);
    expect(data.auditTruncated).toBe(false);
    // Tasks come back in the comp's own order.
    expect(data.tasks.map((t) => t.task.task_id)).toEqual(["t1", "t2"]);
  });
});
