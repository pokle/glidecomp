/**
 * A small competition for the results-record tests: two classes, a team, a
 * route from the bundled samples, a task with no route, and the awkward
 * cases a record must not lose — a penalty, a withheld track, an early
 * start, FTV marks, and names outside Latin-1.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseXCTask } from "@glidecomp/engine";
import type {
  ClassScore,
  CompDetailData,
  PilotScoreEntry,
  TaskDetailData,
  TaskScoreData,
} from "../react/comp/types";
import type { ResultsRecordLoaderData } from "../react/loaders";
import type { Fonts } from "./pdf-writer";

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLES = resolve(HERE, "../../../samples/comps/unungra-cup-2020-open-t4");
const FONT_DIR = resolve(HERE, "../../public/fonts/results-record");

export function readFonts(): Fonts {
  return {
    regular: new Uint8Array(readFileSync(resolve(FONT_DIR, "NotoSans-Regular.ttf"))),
    bold: new Uint8Array(readFileSync(resolve(FONT_DIR, "NotoSans-Bold.ttf"))),
  };
}

export const ORIGIN = "https://glidecomp.test";

/** Names a record must print exactly — and one the font cannot draw. */
export const NAMES = {
  polish: "Łukasz Wójcik",
  czech: "Petr Beneš",
  cyrillic: "Пётр Иванов",
  plain: "Alex Webb",
  withheld: "Sam Spike",
  cjk: "王伟",
} as const;

function entry(name: string, id: string, rank: number, total: number, extra: Partial<PilotScoreEntry> = {}): PilotScoreEntry {
  return {
    rank,
    comp_pilot_id: id,
    pilot_name: name,
    made_goal: total > 600,
    reached_ess: total > 600,
    flown_distance: total * 100,
    speed_section_time: total > 600 ? 5400 + rank * 60 : null,
    distance_points: total * 0.6,
    distance_linear_points: total * 0.6,
    distance_difficulty_points: 0,
    time_points: total * 0.3,
    leading_points: total * 0.1,
    arrival_points: 0,
    penalty_points: 0,
    penalty_reason: null,
    total_score: total,
    arrival_position: total > 600 ? rank : null,
    ess_time_ms: total > 600 ? Date.parse("2020-12-12T05:00:00Z") + rank * 60_000 : null,
    ...extra,
  };
}

function classScore(pilotClass: string, pilots: PilotScoreEntry[]): ClassScore {
  return {
    pilot_class: pilotClass,
    rules_edition: "s7f-2026",
    task_validity: { launch: 1, distance: 0.987, time: 0.966, task: 0.954 },
    available_points: { distance: 520.1, time: 300.2, leading: 100.3, arrival: 33.4, total: 954 },
    validity_inputs: {
      num_present: 6,
      num_flying: 6,
      num_in_goal: 3,
      num_reached_ess: 3,
      best_distance: 92_100,
      best_time: 5460,
      goal_ratio: 0.5,
      task_distance: 92_100,
      mean_distance_over_minimum: 61_000,
      weights: { distance: 0.545, time: 0.315, leading: 0.105, arrival: 0.035 },
    },
    gap_params: {
      nominalDistance: 64_470,
      nominalTime: 5400,
      minimumDistance: 5000,
      scoring: "HG",
      useLeading: true,
      useArrival: false,
      distanceOrigin: "takeoff",
      useDistanceDifficulty: false,
      jumpTheGunFactor: 2,
      jumpTheGunMaxSeconds: 300,
      essNotGoalFactor: 0.8,
    } as ClassScore["gap_params"],
    pilots,
  };
}

export function fixture(): ResultsRecordLoaderData {
  const xctsk = parseXCTask(readFileSync(resolve(SAMPLES, "task.xctsk"), "utf8"));
  const comp: CompDetailData = {
    comp_id: "c1",
    name: "Unungra Cup 2020",
    category: "hg",
    creation_date: "2020-11-01",
    close_date: "2020-12-20",
    test: false,
    pilot_classes: ["open", "sport"],
    default_pilot_class: "open",
    gap_params: null,
    scoring_format: "gap",
    series_scoring: "total",
    ftv_factor: null,
    timezone: "Australia/Melbourne",
    open_igc_upload: false,
    open_registration: false,
    tasks: [
      { task_id: "t1", name: "Task 1", task_date: "2020-12-12", has_xctsk: true, pilot_classes: ["open", "sport"], missing_sss: false, missing_ess: false, line_goal: false },
      { task_id: "t2", name: "Task 2", task_date: "2020-12-13", has_xctsk: false, pilot_classes: ["open"], missing_sss: false, missing_ess: false, line_goal: false },
    ],
    admins: [{ email: "scorer@example.com", name: "Scorer" }],
    is_admin: true,
    pilot_count: 6,
    waypoint_count: 12,
    settings_reviewed: true,
    class_coverage_warnings: [],
  };

  const task = (id: string, name: string, date: string, withRoute: boolean): TaskDetailData => ({
    task_id: id,
    comp_id: "c1",
    name,
    task_date: date,
    creation_date: "2020-11-01",
    xctsk: withRoute ? xctsk : null,
    stop_announcement_time: null,
    weather_notes: withRoute ? "Strong NW, cloudbase 2,800 m." : "",
    submissions_closed: true,
    pilot_classes: ["open"],
    track_count: withRoute ? 6 : 0,
  });

  const open = [
    entry(NAMES.polish, "p1", 1, 912.44, { leading_coefficient: 0.31 }),
    entry(NAMES.czech, "p2", 2, 845.06, {
      penalty_points: 50,
      penalty_reason: "Airspace infringement, CTA C",
      early_start_seconds: 35,
      jump_the_gun_penalty: 70,
    }),
    entry(NAMES.cyrillic, "p3", 3, 701.5),
    entry(NAMES.withheld, "p4", 4, 0, { track_excluded: { reasons: ["Altitude jumps of 1,000 m"] } }),
  ];
  const sport = [entry(NAMES.plain, "p5", 1, 640.2), entry(NAMES.cjk, "p6", 2, 410.7)];

  const t1Score: TaskScoreData = {
    task_id: "t1",
    comp_id: "c1",
    task_date: "2020-12-12",
    scoring_format: "gap",
    class_scores: [classScore("open", open), classScore("sport", sport)],
    computed_at: "2020-12-12T09:30:00Z",
    stale: false,
    engine_generation: "3f9a2b7c1d04",
  };

  const compPilot = (e: PilotScoreEntry, team: string | null) => ({
    pilot_name: e.pilot_name,
    comp_pilot_id: e.comp_pilot_id,
    team_name: team,
    rank: e.rank,
    total_score: e.total_score,
    tasks: [{ task_id: "t1", task_date: "2020-12-12", score: e.total_score, rank: e.rank }],
  });

  return {
    comp,
    scores: {
      comp_id: "c1",
      tasks: [{ task_id: "t1", task_name: "Task 1", task_date: "2020-12-12", classes: ["open", "sport"] }],
      class_scores: [
        { pilot_class: "open", pilots: open.map((e) => compPilot(e, e.rank <= 2 ? "Team Ridge" : null)) },
        { pilot_class: "sport", pilots: sport.map((e) => compPilot(e, null)) },
      ],
      computed_at: "2020-12-12T09:30:00Z",
      stale: false,
      series_scoring: "total",
    },
    tasks: [
      { task: task("t1", "Task 1", "2020-12-12", true), score: t1Score },
      { task: task("t2", "Task 2", "2020-12-13", false), score: null },
    ],
    audit: [
      {
        audit_id: 2,
        timestamp: "2020-12-12T10:00:00Z",
        actor_name: "Scorer",
        subject_type: "pilot",
        subject_id: "p2",
        subject_name: NAMES.czech,
        description: `Set a 50-point penalty for ${NAMES.czech}: "Airspace infringement, CTA C"`,
      },
      {
        audit_id: 1,
        timestamp: "2020-12-11T08:00:00Z",
        actor_name: "Scorer",
        subject_type: "comp",
        subject_id: "c1",
        subject_name: "Unungra Cup 2020",
        description: "Created the competition",
      },
    ],
    auditTruncated: false,
  };
}
