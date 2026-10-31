/**
 * The results record: a competition's scores as one PDF, for the organiser
 * to keep (`/comp/:id/scores.pdf`, comp admins only).
 *
 * WHY IT EXISTS. GlideComp re-scores every competition whenever the scoring
 * engine changes (docs/scoring-version.md), so the scores online are always
 * the CURRENT engine's reading of the comp, never a frozen copy. An organiser
 * who needs what the scores were — for their archive, a protest, a federation
 * — keeps this file. Nothing is stored on our side: the file IS the record,
 * and it says on every page when it was made and by which engine.
 *
 * WHAT IS IN IT, in reading order:
 *   1. the cover: what the comp is, when this file was made, how it was
 *      scored, a contents list, and which data is attached;
 *   2. the standings, one section per class (the scores page's class tabs);
 *   3. the teams, when the comp has any;
 *   4. one section per task: the route, then per class the validity
 *      arithmetic and the full results table, with every penalty and
 *      withheld track named.
 * Then the data itself rides along as attachments (attachments.ts), because
 * the printed tables are rounded for reading.
 *
 * It replaces printing the scores page, which was a cat-and-mouse game: each
 * change to the site could quietly break the paper version, and the page's
 * tabs meant printing every view separately. A document laid out in code
 * (pdf-writer.ts) cannot drift with the site's CSS.
 *
 * Every date and time prints in the comp's own zone (UTC when it has none),
 * through the same fixed-locale helpers the site uses.
 */
import {
  resolveStartGates,
  resolveTaskDeadline,
  resolveTimeOfDayNear,
  resolveTimeTrialGate,
  parseTimeOfDayUTC,
  type XCTask,
} from "@glidecomp/engine";
import { AFRelationship } from "pdf-lib";
import type { PilotScoreEntry, TaskDetailData, ClassScore } from "../react/comp/types";
import { buildTaskLegs } from "../react/comp/task-legs";
import {
  formatDuration,
  formatRankedScore,
  formatTaskDate,
  formatTaskDateRange,
  todayInZone,
} from "../react/lib/format";
import { compPath, compScoresPath, pilotPath, slugify, taskPath } from "../react/lib/slug";
import { formatInstant, hhmmInZone, zoneAbbrev, zoneOffsetMinutes } from "../react/lib/time";
import type { ResultsRecordLoaderData } from "../react/loaders";
import { aggregateTeams, type CompClassScore } from "../scores-views";
import { buildRecordFiles } from "./attachments";
import {
  CONTENT_WIDTH,
  MARGIN_X,
  PdfWriter,
  type CellInput,
  type Fonts,
  type TableColumn,
} from "./pdf-writer";

export type { Fonts } from "./pdf-writer";

export interface ResultsRecordOptions {
  /** Origin every printed and attached URL is absolute against. */
  origin: string;
  generatedAt: Date;
  fonts: Fonts;
}

/** "corryong-cup-2026-results-2026-02-08.pdf" — dated, because an organiser
 * may keep one a day and the files must not overwrite each other. */
export function resultsRecordFilename(
  comp: { name: string; timezone: string | null },
  generatedAt: Date
): string {
  return `${slugify(comp.name) || "competition"}-results-${todayInZone(comp.timezone ?? "UTC", generatedAt)}.pdf`;
}

// ── Formatting ──────────────────────────────────────────────────────────────

const km = (m: number, decimals = 1) => `${(m / 1000).toFixed(decimals)} km`;
const pts = (x: number) => String(Math.round(x));
const v3 = (x: number) => x.toFixed(3);

function categoryName(category: string): string {
  return category === "hg" ? "Hang gliding" : category === "pg" ? "Paragliding" : category;
}

function radiusLabel(m: number): string {
  return m >= 1000 && m % 100 === 0 ? `${m / 1000} km` : `${Math.round(m)} m`;
}

/** Wall-clock HH:MM:SS in the comp zone, for an ESS crossing. */
function clockInZone(ms: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(11, 19);
  }
}

/** Local midday on the task date — the reference the engine's
 * time-of-day resolvers place a gate or deadline nearest to. */
function taskMidday(taskDate: string, timeZone: string): number {
  const noonUtc = Date.parse(`${taskDate}T12:00:00Z`);
  try {
    return noonUtc - zoneOffsetMinutes(new Date(noonUtc), timeZone) * 60_000;
  } catch {
    return noonUtc;
  }
}

const ROLE_LABEL: Record<string, string> = {
  TAKEOFF: "Take-off",
  SSS: "Start (SSS)",
  ESS: "End of speed section",
  GOAL: "Goal",
};

// ── The document ────────────────────────────────────────────────────────────

interface TaskLabel {
  label: string;
  name: string;
  date: string;
}

export async function buildResultsRecord(
  data: ResultsRecordLoaderData,
  options: ResultsRecordOptions
): Promise<Uint8Array> {
  const { comp, scores } = data;
  const zone = comp.timezone ?? "UTC";
  const { origin, generatedAt } = options;
  const compUrl = origin + compPath(comp.comp_id, comp.name);
  const generated = formatInstant(generatedAt, zone);

  const w = await PdfWriter.create(options.fonts);
  const contents: Array<{ title: string; page: number; indent: boolean }> = [];
  const mark = (title: string, indent = false) =>
    contents.push({ title, page: w.doc.getPageCount(), indent });

  // T1, T2 … in the comp's own task order, so a column means the same task
  // in every class's table.
  const taskLabels = new Map<string, TaskLabel>(
    data.tasks.map(({ task }, i) => [
      task.task_id,
      { label: `T${i + 1}`, name: task.name, date: task.task_date },
    ])
  );

  const files = buildRecordFiles(data, { origin, generatedAt });
  const contentsAnchor = drawCover(w, data, { compUrl, generated, generatedAt, zone, files });

  if (scores && scores.class_scores.length > 0) {
    for (const cls of scores.class_scores) {
      w.newPage();
      w.heading(`Standings — ${cls.pilot_class}`, 1, {
        link: origin + compScoresPath(comp.comp_id, comp.name),
      });
      mark(`Standings — ${cls.pilot_class}`);
      drawStandings(w, data, cls, taskLabels, origin);
    }
    const teams = aggregateTeams(scores.class_scores);
    if (teams.length > 0) {
      w.newPage();
      w.heading("Teams", 1);
      mark("Teams");
      drawTeams(w, data, teams, taskLabels);
    }
  }

  data.tasks.forEach(({ task, score }) => {
    const label = taskLabels.get(task.task_id)!;
    w.newPage();
    w.heading(task.name, 1, {
      link: origin + taskPath(comp.comp_id, comp.name, task.task_id, task.name),
      bookmark: `${label.label} · ${task.name} — ${formatTaskDate(task.task_date, { day: "numeric", month: "short" })}`,
    });
    mark(`${label.label} · ${task.name}`);
    w.text(
      [
        label.label,
        formatTaskDate(task.task_date),
        task.pilot_classes.length ? `Classes: ${task.pilot_classes.join(", ")}` : null,
      ]
        .filter(Boolean)
        .join("  ·  "),
      { muted: true, after: 6 }
    );
    drawRoute(w, task, zone);
    if (task.weather_notes.trim()) {
      w.heading("Organiser's weather notes", 3, { keepWith: 20 });
      w.text(task.weather_notes, { after: 4 });
    }
    if (!score) {
      w.space(4);
      w.text(
        task.xctsk
          ? "This task has no scores."
          : "No route was set for this task, so it was not scored.",
        { muted: true }
      );
      return;
    }
    if (score.stale) {
      w.notice(
        "These scores were being recomputed when this file was made. Download the record " +
          "again in a few minutes for the up-to-date results."
      );
    }
    for (const cls of score.class_scores) {
      w.heading(cls.pilot_class, 2, { keepWith: 90 });
      drawTaskClass(w, data, task, cls, score.scoring_format, zone, origin);
    }
  });

  drawContents(w, contentsAnchor, contents);

  for (const f of files) {
    await w.doc.attach(new TextEncoder().encode(f.content), f.name, {
      mimeType: f.mimeType,
      description: f.description,
      creationDate: generatedAt,
      modificationDate: generatedAt,
      afRelationship: f.name === "README.txt" ? AFRelationship.Supplement : AFRelationship.Data,
    });
  }

  w.doc.setTitle(`${comp.name} — results record`, { showInWindowTitleBar: true });
  w.doc.setAuthor("GlideComp");
  w.doc.setSubject(`Scores for ${comp.name} as they stood on ${generated}`);
  w.doc.setKeywords([comp.name, "GlideComp", "results", categoryName(comp.category), "scores"]);
  w.doc.setCreator(`GlideComp (${origin})`);
  w.doc.setProducer("GlideComp results record");
  w.doc.setLanguage("en-AU");
  w.doc.setCreationDate(generatedAt);
  w.doc.setModificationDate(generatedAt);

  return w.finish({
    headerLeft: `${comp.name} — results record`,
    headerRight: `Generated ${generated}`,
    footerLeft: compUrl,
  });
}

// ── Cover ───────────────────────────────────────────────────────────────────

interface ContentsAnchor {
  pageIndex: number;
  x: number;
  top: number;
  width: number;
}

const COVER_LEFT_WIDTH = 450;

function drawCover(
  w: PdfWriter,
  data: ResultsRecordLoaderData,
  {
    compUrl,
    generated,
    generatedAt,
    zone,
    files,
  }: {
    compUrl: string;
    generated: string;
    generatedAt: Date;
    zone: string;
    files: ReturnType<typeof buildRecordFiles>;
  }
): ContentsAnchor {
  const { comp, scores } = data;
  w.drawLine("RESULTS RECORD", MARGIN_X, w.y, { size: 9, bold: true, muted: true });
  w.space(16);
  w.heading(comp.name, 1, { link: compUrl, bookmark: "Summary" });

  const dates = data.tasks.map((t) => t.task.task_date).sort();
  const scored = data.tasks.filter((t) => t.score).length;
  w.text(
    [
      categoryName(comp.category),
      comp.scoring_format === "open_distance" ? "Open distance" : "GAP",
      dates.length ? formatTaskDateRange(dates[0], dates[dates.length - 1]) : null,
    ]
      .filter(Boolean)
      .join("  ·  "),
    { size: 11, muted: true, after: 10 }
  );

  const top = w.y;
  const generations = [
    ...new Set(data.tasks.map((t) => t.score?.engine_generation).filter((g): g is string => !!g)),
  ];
  const editions = new Set(
    data.tasks.flatMap((t) => t.score?.class_scores.map((c) => c.rules_edition) ?? [])
  );
  const ftvPct = scores?.ftv_factor != null ? Math.round(scores.ftv_factor * 100) : null;

  w.keyValues(
    [
      ["Generated", generated],
      [
        "Scores computed",
        scores?.computed_at ? formatInstant(new Date(scores.computed_at), zone) : "No task has been scored yet",
      ],
      [
        "Scoring",
        comp.scoring_format === "open_distance"
          ? "Open distance: the score is the distance flown"
          : editions.has("s7f-2026")
            ? "GAP, FAI Sporting Code Section 7F, 2026 edition"
            : "GAP, FAI Sporting Code Section 7F",
      ],
      [
        "Series total",
        (scores?.series_scoring ?? comp.series_scoring) === "ftv"
          ? `Fixed Total Validity: each pilot's best tasks count${ftvPct != null ? `, ${ftvPct}% of total validity discarded` : ""}`
          : "The sum of every task's score",
      ],
      [
        "Scoring engine",
        generations.length ? `Generation ${generations.join(", ")}` : "Not reported",
      ],
      ["Classes", comp.pilot_classes.join(", ") || "—"],
      ["Pilots", String(comp.pilot_count)],
      ["Tasks", `${data.tasks.length} (${scored} scored)`],
      ["Times shown in", comp.timezone ? `${comp.timezone} (${zoneAbbrev(generatedAt, comp.timezone)})` : "UTC"],
      [
        "Submissions",
        comp.close_date
          ? `${todayInZone(zone, generatedAt) > comp.close_date ? "Closed" : "Close"} at the end of ${formatTaskDate(comp.close_date)}`
          : "No close date set",
      ],
      ["Online", { text: compUrl, link: compUrl }],
    ],
    { labelWidth: 112, width: COVER_LEFT_WIDTH }
  );

  const anyStale = scores?.stale || data.tasks.some((t) => t.score?.stale);
  w.space(6);
  if (anyStale) {
    w.notice(
      "Some scores were being recomputed when this file was made. Download the record again " +
        "in a few minutes for the up-to-date results."
    );
  }

  w.heading("About this record", 3, { keepWith: 30 });
  w.text(
    "GlideComp re-scores a competition whenever its scoring engine changes, so the scores " +
      "online can differ from these later. This file records them as they stood when it was " +
      "generated.",
    { width: COVER_LEFT_WIDTH, after: 4 }
  );

  w.heading("Attached data", 3, { keepWith: 30 });
  w.text(
    "The data in this document is also attached to it as files: open your PDF viewer's " +
      "attachments panel to save them. The tables here are rounded for reading; the files " +
      "hold the exact values.",
    { width: COVER_LEFT_WIDTH, after: 3 }
  );
  const routes = files.filter((f) => f.name.endsWith(".xctsk")).length;
  for (const f of files) {
    if (f.name.endsWith(".xctsk")) continue;
    w.text(`${f.name} — ${f.description}`, { size: 8.5, indent: 10, width: COVER_LEFT_WIDTH - 10 });
  }
  if (routes > 0) {
    w.text(`route-NN-….xctsk — each task's route as an XCTrack task file (${routes}).`, {
      size: 8.5,
      indent: 10,
      width: COVER_LEFT_WIDTH - 10,
    });
  }

  return {
    pageIndex: 0,
    x: MARGIN_X + COVER_LEFT_WIDTH + 40,
    top,
    width: CONTENT_WIDTH - COVER_LEFT_WIDTH - 40,
  };
}

/** The contents list, drawn last into the cover's right-hand column, once
 * every section knows its page. */
function drawContents(
  w: PdfWriter,
  anchor: ContentsAnchor,
  entries: Array<{ title: string; page: number; indent: boolean }>
): void {
  const page = w.doc.getPage(anchor.pageIndex);
  const size = 9;
  const lineHeight = 13;
  const bottomLimit = 60;
  let top = anchor.top;
  w.drawLine("Contents", anchor.x, top, { size: 10.5, bold: true, page });
  top -= 18;
  const max = Math.floor((top - bottomLimit) / lineHeight);
  const shown = entries.length > max ? entries.slice(0, max - 1) : entries;
  for (const entry of shown) {
    const no = String(entry.page);
    const noWidth = w.width(no, size);
    const lines = w.wrap(entry.title, size, anchor.width - noWidth - 12);
    w.drawLine(lines[0] + (lines.length > 1 ? "…" : ""), anchor.x, top, { size, page });
    w.drawLine(no, anchor.x + anchor.width - noWidth, top, { size, muted: true, page });
    top -= lineHeight;
  }
  if (shown.length < entries.length) {
    w.drawLine(`…and ${entries.length - shown.length} more in the bookmarks`, anchor.x, top, {
      size,
      muted: true,
      page,
    });
  }
}

// ── Standings ───────────────────────────────────────────────────────────────

const TASK_COL = 50;
const RANK_COL = 26;
const TOTAL_COL = 56;

/** Split task columns into bands that fit across the page beside `fixed`
 * points of other columns, keeping at least `minFlex` for the name column. */
function bands<T>(items: T[], fixed: number, minFlex: number): T[][] {
  const perBand = Math.max(1, Math.floor((CONTENT_WIDTH - fixed - minFlex) / TASK_COL));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += perBand) out.push(items.slice(i, i + perBand));
  return out.length ? out : [[]];
}

function taskHeader(t: TaskLabel): string[] {
  return [t.label, formatTaskDate(t.date, { day: "numeric", month: "short" })];
}

function drawStandings(
  w: PdfWriter,
  data: ResultsRecordLoaderData,
  cls: CompClassScore,
  taskLabels: Map<string, TaskLabel>,
  origin: string
): void {
  const { comp, scores } = data;
  const isFtv = scores!.series_scoring === "ftv";
  const classTasks = scores!.tasks.filter((t) => t.classes.includes(cls.pilot_class));
  const hasTeams = cls.pilots.some((p) => p.team_name?.trim());
  w.text(
    `${cls.pilots.length} pilots  ·  ${classTasks.length} ${classTasks.length === 1 ? "task" : "tasks"}  ·  ` +
      "pilots with the same total share a rank",
    { muted: true, after: 6 }
  );

  const taskBands = bands(classTasks, RANK_COL + TOTAL_COL + (hasTeams ? 100 : 0), 150);
  taskBands.forEach((band, b) => {
    const last = b === taskBands.length - 1;
    if (taskBands.length > 1) {
      w.heading(
        `Tasks ${taskLabels.get(band[0].task_id)?.label}–${taskLabels.get(band[band.length - 1].task_id)?.label}`,
        3,
        { keepWith: 40 }
      );
    }
    const columns: TableColumn[] = [
      { header: "#", width: RANK_COL, align: "right" },
      { header: "Pilot" },
      ...(hasTeams && b === 0 ? [{ header: "Team", width: 100 }] : []),
      ...band.map((t) => ({
        header: taskHeader(taskLabels.get(t.task_id) ?? { label: t.task_name, name: t.task_name, date: t.task_date }),
        width: TASK_COL,
        align: "right" as const,
      })),
      ...(last ? [{ header: "Total", width: TOTAL_COL, align: "right" as const }] : []),
    ];
    const rows: CellInput[][] = cls.pilots.map((p) => [
      String(p.rank),
      p.pilot_name,
      ...(hasTeams && b === 0 ? [p.team_name ?? ""] : []),
      ...band.map((t): CellInput => {
        const entry = p.tasks.find((e) => e.task_id === t.task_id);
        if (!entry) return { text: "—", muted: true };
        const score = formatRankedScore(entry.score);
        return {
          text:
            entry.ftv_status === "discarded"
              ? `[${score}]`
              : entry.ftv_status === "partial"
                ? `${score}*`
                : score,
          muted: entry.ftv_status === "discarded",
          link:
            origin +
            pilotPath(comp.comp_id, comp.name, t.task_id, t.task_name, p.comp_pilot_id, p.pilot_name),
        };
      }),
      ...(last ? [{ text: formatRankedScore(p.total_score), bold: true }] : []),
    ]);
    w.table(columns, rows);
  });

  const legend = classTasks
    .map((t) => {
      const l = taskLabels.get(t.task_id);
      return l ? `${l.label} ${l.name} (${formatTaskDate(l.date)})` : null;
    })
    .filter(Boolean)
    .join("   ");
  if (legend) w.text(legend, { size: 8, muted: true, after: 3 });
  if (isFtv) {
    w.text(
      "Fixed Total Validity: each pilot's total counts only their best tasks. A score in " +
        "[brackets] was discarded; a score marked * counted only in part.",
      { size: 8, muted: true }
    );
  }
}

function drawTeams(
  w: PdfWriter,
  data: ResultsRecordLoaderData,
  teams: ReturnType<typeof aggregateTeams>,
  taskLabels: Map<string, TaskLabel>
): void {
  const tasks = data.scores!.tasks;
  w.text("Each team scores the sum of its pilots' scores, task by task.", { muted: true, after: 6 });
  const taskBands = bands(tasks, RANK_COL + TOTAL_COL + 120, 150);
  taskBands.forEach((band, b) => {
    const last = b === taskBands.length - 1;
    const columns: TableColumn[] = [
      { header: "#", width: RANK_COL, align: "right" },
      { header: "Team", width: 120 },
      { header: "Pilots" },
      ...band.map((t) => ({
        header: taskHeader(taskLabels.get(t.task_id) ?? { label: t.task_name, name: t.task_name, date: t.task_date }),
        width: TASK_COL,
        align: "right" as const,
      })),
      ...(last ? [{ header: "Total", width: TOTAL_COL, align: "right" as const }] : []),
    ];
    w.table(
      columns,
      teams.map((team) => [
        String(team.rank),
        { text: team.team_name, bold: true },
        team.pilots.join(", "),
        ...band.map((t): CellInput =>
          team.task_scores[t.task_id] != null ? formatRankedScore(team.task_scores[t.task_id]) : { text: "—", muted: true }
        ),
        ...(last ? [{ text: formatRankedScore(team.total_score), bold: true }] : []),
      ])
    );
  });
}

// ── Tasks ───────────────────────────────────────────────────────────────────

function drawRoute(w: PdfWriter, task: TaskDetailData, zone: string): void {
  const xctsk: XCTask | null = task.xctsk;
  if (!xctsk) return;
  const ref = taskMidday(task.task_date, zone);
  const clock = (ms: number | null) => (ms == null ? null : `${hhmmInZone(new Date(ms), zone)}`);
  const tz = zoneAbbrev(new Date(ref), zone);

  const isElapsed = xctsk.sss?.type === "ELAPSED-TIME";
  const gates = isElapsed
    ? [resolveTimeTrialGate(xctsk, ref)].filter((g): g is number => g != null)
    : (resolveStartGates(xctsk, ref) ?? []);
  const deadline = resolveTaskDeadline(xctsk, ref);
  const windowAt = (raw: string | undefined) => {
    const s = raw ? parseTimeOfDayUTC(raw) : null;
    return s == null ? null : resolveTimeOfDayNear(s, ref);
  };
  const open = windowAt(xctsk.takeoff?.timeOpen);
  const close = windowAt(xctsk.takeoff?.timeClose);
  const course = buildTaskLegs(xctsk);

  const rows: Array<[string, CellInput]> = [
    ["Task type", isElapsed ? "Elapsed time" : "Race to goal"],
  ];
  if (xctsk.sss) {
    rows.push([
      "Start",
      `${xctsk.sss.direction === "EXIT" ? "Exit" : "Enter"} the start cylinder` +
        (gates.length
          ? `; ${gates.length === 1 ? "gate" : "gates"} ${gates.map(clock).join(", ")} ${tz}`
          : ""),
    ]);
  }
  if (open != null || close != null) {
    rows.push(["Launch window", `${clock(open) ?? "—"} to ${clock(close) ?? "—"} ${tz}`]);
  }
  rows.push([
    "Goal",
    `${xctsk.goal?.type === "LINE" ? "Line" : "Cylinder"}` +
      (deadline != null ? `; deadline ${clock(deadline)} ${tz}` : ""),
  ]);
  if (task.stop_announcement_time) {
    rows.push(["Stopped", `Announced ${formatInstant(new Date(task.stop_announcement_time), zone)}`]);
  }
  if (course) rows.push(["Optimised distance", km(course.totalMeters, 2)]);
  w.keyValues(rows, { labelWidth: 112 });
  w.space(4);

  w.table(
    [
      { header: "#", width: 22, align: "right" },
      { header: "Role", width: 112 },
      { header: "Turnpoint", width: 150 },
      { header: "Description" },
      { header: "Radius", width: 52, align: "right" },
      { header: ["Altitude", "(m)"], width: 50, align: "right" },
      { header: "Latitude", width: 64, align: "right" },
      { header: "Longitude", width: 70, align: "right" },
      { header: ["Leg", "(optimised)"], width: 66, align: "right" },
    ],
    xctsk.turnpoints.map((tp, i) => {
      const station = course?.stations[i];
      const role = station?.role ? ROLE_LABEL[station.role] : "Turnpoint";
      const leg = i > 0 ? course?.legs[i - 1] : undefined;
      return [
        String(i + 1),
        station?.direction === "exit" ? `${role} (exit)` : role,
        tp.waypoint.name,
        tp.waypoint.description ?? "",
        radiusLabel(tp.radius),
        tp.waypoint.altSmoothed != null ? String(Math.round(tp.waypoint.altSmoothed)) : "—",
        tp.waypoint.lat.toFixed(5),
        tp.waypoint.lon.toFixed(5),
        leg ? km(leg.meters, 2) : "",
      ];
    })
  );
}

function drawTaskClass(
  w: PdfWriter,
  data: ResultsRecordLoaderData,
  task: TaskDetailData,
  cls: ClassScore,
  format: "gap" | "open_distance",
  zone: string,
  origin: string
): void {
  const { comp } = data;
  const isOpen = format === "open_distance";

  if (!isOpen) {
    const v = cls.task_validity;
    const ap = cls.available_points;
    const factors = [
      `launch ${v3(v.launch)}`,
      `distance ${v3(v.distance)}`,
      `time ${v3(v.time)}`,
      ...(v.stopped != null ? [`stopped ${v3(v.stopped)}`] : []),
    ];
    const rows: Array<[string, CellInput]> = [
      ["Task validity", `${v3(v.task)} = ${factors.join(" × ")}`],
    ];
    const vi = cls.validity_inputs;
    if (vi) {
      rows.push([
        "Validity inputs",
        [
          `${vi.num_present} present, ${vi.num_flying} flying, ${vi.num_reached_ess} reached ESS, ${vi.num_in_goal} in goal`,
          `best distance ${km(vi.best_distance)}`,
          vi.best_time != null ? `best time ${formatDuration(vi.best_time)}` : null,
          `task distance ${km(vi.task_distance)}`,
        ]
          .filter(Boolean)
          .join("  ·  "),
      ]);
    }
    rows.push([
      "Available points",
      `${formatRankedScore(ap.total)} = distance ${formatRankedScore(ap.distance)} + time ${formatRankedScore(ap.time)}` +
        ` + leading ${formatRankedScore(ap.leading)} + arrival ${formatRankedScore(ap.arrival)}`,
    ]);
    const g = cls.gap_params;
    if (g) {
      rows.push([
        "Parameters",
        [
          `${g.scoring} scoring`,
          `nominal distance ${km(g.nominalDistance)}`,
          `nominal time ${formatDuration(g.nominalTime)}`,
          `minimum distance ${km(g.minimumDistance)}`,
          `leading ${g.useLeading ? "on" : "off"}`,
          `arrival ${g.useArrival ? "on" : "off"}`,
          `distance from ${g.distanceOrigin === "start" ? "the start" : "take-off"}`,
        ].join("  ·  "),
      ]);
    }
    w.keyValues(rows, { labelWidth: 112, size: 8.5 });
    w.space(3);
  }

  const pilots = cls.pilots;
  const hasSpeed = !isOpen && pilots.some((p) => p.speed_section_time !== null);
  const hasEss = !isOpen && pilots.some((p) => p.arrival_position != null);
  const hasTime = !isOpen && pilots.some((p) => p.time_points !== 0);
  const hasLead = !isOpen && pilots.some((p) => p.leading_points !== 0);
  const hasArr = !isOpen && pilots.some((p) => p.arrival_points !== 0);
  const hasPen = pilots.some((p) => p.penalty_points !== 0);

  const columns: TableColumn[] = [
    { header: "#", width: 26, align: "right" },
    { header: "Pilot" },
    ...(!isOpen ? [{ header: "Goal", width: 34 }] : []),
    { header: ["Distance", "(km)"], width: 54, align: "right" },
    ...(hasSpeed ? [{ header: ["Speed", "section"], width: 56, align: "right" as const }] : []),
    ...(hasEss ? [{ header: ["ESS", `(${zoneAbbrev(new Date(taskMidday(task.task_date, zone)), zone)})`], width: 74, align: "right" as const }] : []),
    ...(!isOpen ? [{ header: ["Dist", "pts"], width: 42, align: "right" as const }] : []),
    ...(hasTime ? [{ header: ["Time", "pts"], width: 42, align: "right" as const }] : []),
    ...(hasLead ? [{ header: ["Lead", "pts"], width: 42, align: "right" as const }] : []),
    ...(hasArr ? [{ header: ["Arr", "pts"], width: 40, align: "right" as const }] : []),
    ...(hasPen ? [{ header: "Penalty", width: 50, align: "right" as const }] : []),
    { header: "Total", width: 56, align: "right" },
  ];

  const rows: CellInput[][] = pilots.map((p) => [
    String(p.rank),
    {
      text: p.track_excluded ? `${p.pilot_name} (track withheld)` : p.pilot_name,
      link: origin + pilotPath(comp.comp_id, comp.name, task.task_id, task.name, p.comp_pilot_id, p.pilot_name),
    },
    ...(!isOpen ? [p.made_goal ? "Goal" : ""] : []),
    (p.flown_distance / 1000).toFixed(1),
    ...(hasSpeed ? [p.speed_section_time != null ? formatDuration(p.speed_section_time) : ""] : []),
    ...(hasEss
      ? [
          p.arrival_position != null
            ? `${p.ess_time_ms != null ? clockInZone(p.ess_time_ms, zone) : ""} (#${p.arrival_position})`
            : "",
        ]
      : []),
    ...(!isOpen ? [pts(p.distance_points)] : []),
    ...(hasTime ? [pts(p.time_points)] : []),
    ...(hasLead ? [pts(p.leading_points)] : []),
    ...(hasArr ? [pts(p.arrival_points)] : []),
    ...(hasPen ? [penaltyText(p)] : []),
    { text: formatRankedScore(p.total_score), bold: true },
  ]);
  w.table(columns, rows);

  const notes = pilots.flatMap((p) => pilotNotes(p));
  if (notes.length > 0) {
    w.heading("Notes", 3, { keepWith: 14 });
    for (const note of notes) w.text(note, { size: 8.5, indent: 8, after: 1 });
  }
}

/** A deduction prints as "−50"; a negative penalty is a bonus, "+50". */
function penaltyText(p: PilotScoreEntry): string {
  if (p.penalty_points === 0) return "";
  return p.penalty_points < 0 ? `+${Math.abs(p.penalty_points)}` : `−${p.penalty_points}`;
}

/** Everything about a pilot's score that the table cannot say in a cell. */
function pilotNotes(p: PilotScoreEntry): string[] {
  const out: string[] = [];
  if (p.track_excluded) {
    out.push(`${p.pilot_name}: track withheld from scoring — ${p.track_excluded.reasons.join("; ")}.`);
  }
  if (p.penalty_points !== 0) {
    out.push(
      `${p.pilot_name}: ${p.penalty_points < 0 ? "bonus" : "penalty"} of ${Math.abs(p.penalty_points)} points` +
        (p.penalty_reason ? ` — ${p.penalty_reason}` : "") +
        "."
    );
  }
  if (p.early_start_seconds) {
    out.push(
      `${p.pilot_name}: started ${Math.round(p.early_start_seconds)} s before the start gate` +
        (p.jump_the_gun_penalty ? `; jump-the-gun penalty of ${pts(p.jump_the_gun_penalty)} points` : "") +
        "."
    );
  }
  return out;
}
