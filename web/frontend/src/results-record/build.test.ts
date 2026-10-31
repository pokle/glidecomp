// @vitest-environment node
import { describe, expect, test } from "vitest";
import { encodeXctskQR, parseXCTask, xctaskTurnpointsToRecords } from "@glidecomp/engine";
import { buildResultsRecord, resultsRecordFilename, routeQr } from "./build";
import { drawTaskDiagram } from "./task-diagram-pdf";
import { PdfWriter } from "./pdf-writer";
import { readRecord } from "./read-pdf";
import { fixture, NAMES, ORIGIN, readFonts } from "./test-fixture";
import { TASK_RESULTS_COLUMNS, TASK_VALIDITY_COLUMNS } from "./attachments";

const GENERATED = new Date("2020-12-21T01:02:03Z");

async function build(data = fixture()) {
  return readRecord(
    await buildResultsRecord(data, { origin: ORIGIN, generatedAt: GENERATED, fonts: readFonts() })
  );
}

describe("buildResultsRecord", () => {
  test("is a PDF that names what it is and when it was made", async () => {
    const { doc } = await build();
    expect(doc.getTitle()).toBe("Unungra Cup 2020 — results record");
    expect(doc.getAuthor()).toBe("GlideComp");
    expect(doc.getCreationDate()?.toISOString()).toBe(GENERATED.toISOString());
    // Cover, two class standings, teams, and at least a page per task.
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(6);
    // A4 landscape, every page.
    for (const page of doc.getPages()) {
      expect(Math.round(page.getWidth())).toBe(842);
      expect(Math.round(page.getHeight())).toBe(595);
    }
  });

  test("bookmarks every section, in reading order", async () => {
    const { bookmarks } = await build();
    expect(bookmarks).toEqual([
      "Summary",
      "Standings — open",
      "Standings — sport",
      "Teams",
      "T1 · Task 1 — 12 Dec",
      "T2 · Task 2 — 13 Dec",
    ]);
  });

  test("carries the data as attachments, each one listed in the README", async () => {
    const { attachments } = await build();
    expect([...attachments.keys()]).toEqual([
      "scores.csv",
      "task-results.csv",
      "task-validity.csv",
      "audit-log.csv",
      "competition.json",
      // Only the routed task has a route file.
      "route-01-task-1.xctsk",
      "README.txt",
    ]);
    const readme = attachments.get("README.txt")!.text;
    for (const name of attachments.keys()) {
      if (name !== "README.txt") expect(readme).toContain(name);
      expect(attachments.get(name)!.description).not.toBe("");
    }
    expect(readme).toContain("not a fixed format");
  });

  test("the attachments hold names exactly, even ones the PDF's font cannot draw", async () => {
    const { attachments } = await build();
    const results = attachments.get("task-results.csv")!.text;
    expect(results.split("\n")[0]).toBe(TASK_RESULTS_COLUMNS.join(","));
    for (const name of Object.values(NAMES)) expect(results).toContain(name);
    expect(results).toContain("Airspace infringement, CTA C");
    expect(results).toContain("Altitude jumps of 1,000 m");
    // Exact, not the table's rounding.
    expect(results).toContain(",912.44,");

    const validity = attachments.get("task-validity.csv")!.text.split("\n");
    expect(validity[0]).toBe(TASK_VALIDITY_COLUMNS.join(","));
    expect(validity[1]).toContain("3f9a2b7c1d04");
  });

  test("competition.json carries the parameters each class was scored with", async () => {
    const { attachments } = await build();
    const json = JSON.parse(attachments.get("competition.json")!.text);
    expect(json.generated_at).toBe(GENERATED.toISOString());
    expect(json.competition.url).toBe(`${ORIGIN}/comp/unungra-cup-2020-c1`);
    const t1 = json.tasks[0];
    expect(t1.scored.engine_generation).toBe("3f9a2b7c1d04");
    expect(t1.scored.classes[0].gap_params.nominalDistance).toBe(64_470);
    expect(json.tasks[1].scored).toBeNull();
  });

  test("a route attachment reads back as the same task", async () => {
    const data = fixture();
    const { attachments } = await build(data);
    const route = parseXCTask(attachments.get("route-01-task-1.xctsk")!.text);
    expect(route.turnpoints.map((t) => t.waypoint.name)).toEqual(
      data.tasks[0].task.xctsk!.turnpoints.map((t) => t.waypoint.name)
    );
  });

  test("a comp with nothing scored still makes a record", async () => {
    const data = fixture();
    data.scores = null;
    data.tasks = data.tasks.map((t) => ({ ...t, score: null }));
    const { bookmarks, attachments } = await build(data);
    expect(bookmarks).toEqual(["Summary", "T1 · Task 1 — 12 Dec", "T2 · Task 2 — 13 Dec"]);
    expect(attachments.get("task-results.csv")!.text.trim().split("\n")).toHaveLength(1);
  });

  test("more tasks than fit across the page split into bands rather than overflow", async () => {
    const data = fixture();
    const base = data.tasks[0];
    data.tasks = Array.from({ length: 14 }, (_, k) => ({
      task: { ...base.task, task_id: `t${k}`, name: `Task ${k + 1}` },
      score: { ...base.score!, task_id: `t${k}` },
    }));
    data.scores!.tasks = data.tasks.map((t) => ({
      task_id: t.task.task_id,
      task_name: t.task.name,
      task_date: t.task.task_date,
      classes: ["open", "sport"],
    }));
    const { doc } = await build(data);
    expect(doc.getPageCount()).toBeGreaterThan(14);
  });
});

describe("resultsRecordFilename", () => {
  test("is dated in the comp's own zone, so a record a day never overwrites", () => {
    // 01:02 UTC on the 21st is already midday on the 21st in Melbourne…
    expect(resultsRecordFilename({ name: "Unungra Cup 2020", timezone: "Australia/Melbourne" }, GENERATED)).toBe(
      "unungra-cup-2020-results-2020-12-21.pdf"
    );
    // …and still the 20th in Los Angeles.
    expect(
      resultsRecordFilename({ name: "Unungra Cup 2020", timezone: "America/Los_Angeles" }, GENERATED)
    ).toBe("unungra-cup-2020-results-2020-12-20.pdf");
  });
});

describe("PdfWriter.clean", () => {
  test("keeps every name the font can draw and marks what it cannot", async () => {
    const w = await PdfWriter.create(readFonts());
    expect(w.clean(`${NAMES.polish}\n${NAMES.czech}\t${NAMES.cyrillic}`)).toBe(
      `${NAMES.polish} ${NAMES.czech} ${NAMES.cyrillic}`
    );
    expect(w.clean(NAMES.cjk)).toBe("??");
    expect(w.clean("Ελένη Øvre Ðorđe Nguyễn")).toBe("Ελένη Øvre Ðorđe Nguyễn");
  });
});

describe("routeQr", () => {
  const xctsk = fixture().tasks[0].task.xctsk!;

  test("carries exactly what the task page's QR code does", () => {
    const qr = routeQr(xctsk)!;
    expect(qr.payload).toBe(encodeXctskQR(xctaskTurnpointsToRecords(xctsk.turnpoints)));
    expect(qr.payload.startsWith("XCTSK:")).toBe(true);
    // A square module matrix, at least a version-1 QR, sized for paper.
    expect(qr.modules.length).toBeGreaterThanOrEqual(21);
    for (const row of qr.modules) expect(row).toHaveLength(qr.modules.length);
    expect(qr.size).toBeGreaterThanOrEqual(110);
    expect(qr.size).toBeLessThanOrEqual(170);
  });

  test("a route too long for one QR gets none, as on the task page", () => {
    const tp = xctsk.turnpoints[2];
    const long = {
      ...xctsk,
      turnpoints: Array.from({ length: 120 }, (_, i) => ({
        ...tp,
        waypoint: { ...tp.waypoint, name: `turnpoint-number-${i}`, lat: tp.waypoint.lat + i / 1000 },
      })),
    };
    expect(routeQr(long)).toBeNull();
    expect(routeQr({ ...xctsk, turnpoints: [] })).toBeNull();
  });
});

describe("drawTaskDiagram", () => {
  test("draws the task page's diagram for a route, and nothing without one", async () => {
    const w = await PdfWriter.create(readFonts());
    const xctsk = fixture().tasks[0].task.xctsk!;
    expect(drawTaskDiagram(w, xctsk, 40, 500, 1)).toBe(true);
    expect(drawTaskDiagram(w, { ...xctsk, turnpoints: [] }, 40, 500, 1)).toBe(false);
  });
});
