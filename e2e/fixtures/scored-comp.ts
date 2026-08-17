/**
 * A competition with one routed task that really scores — the fixture any spec
 * needs when the thing under test is what happens to a SCORE, or to the page
 * that explains one.
 *
 * The seeded sample comps are not that fixture. They are shared, several specs
 * assert against their contents, and mutating one to see a number move would
 * leave the next spec reading a competition somebody else edited. This builds
 * a private one per spec (named through `e2eCompName`, so the sweep in
 * global-setup.ts can collect it if a run is killed) and hands back the ids
 * every mutation is addressed to.
 *
 * The tracklogs are the bundled Unungra ones: real B records, GPS *and*
 * barometric altitude, flown on the day the task is dated. All three parts
 * matter — track quality withholds a tracklog flown on the wrong day, and a
 * withheld track is scored 0 with reasons, so a fixture that got the date
 * wrong would quietly score an empty field and every assertion downstream
 * would be about nothing.
 */
import { expect, type APIRequestContext } from "./test";
import { resolve, dirname } from "path";
import { readFile } from "fs/promises";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { gzipSync } from "zlib";
import { e2eCompName } from "./stack";

const SAMPLES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "web/samples/comps/unungra-cup-2020-open-t4"
);

/** The day the bundled tracklogs were flown. The task must be dated this. */
export const TASK_DATE = "2020-12-12";

/** Pilots with a tracklog — registered name to the file filed for them. */
export const FLYING_PILOTS = [
  { name: "Ada Adler", igc: "adler_39333_121220.igc" },
  { name: "Bruno Bennewitz", igc: "bennewitz_86426_121220.igc" },
  { name: "Cara Binstead", igc: "binstead_301122_121220.igc" },
] as const;

export interface ScoredComp {
  compId: string;
  taskId: string;
  /** comp_pilot_id by registered name. */
  pilotIds: Map<string, string>;
}

// ── The score wire, as far as these specs read it ───────────────────────────

export interface ScoredPilot {
  comp_pilot_id: string;
  pilot_name: string;
  total_score: number;
  flown_distance: number;
  penalty_points: number;
  penalty_reason: string | null;
}

export interface ScoredClass {
  pilot_class: string;
  task_validity: { launch: number; distance: number; time: number; task: number };
  validity_inputs?: { num_present: number; num_flying: number };
  /** The parameters the class was ACTUALLY scored with (migration 0021). */
  gap_params?: { nominalTime: number; nominalDistance: number };
  pilots: ScoredPilot[];
}

export interface TaskScore {
  stale: boolean;
  class_scores: ScoredClass[];
}

export async function readScore(
  api: APIRequestContext,
  f: Pick<ScoredComp, "compId" | "taskId">
): Promise<TaskScore> {
  const res = await api.get(`/api/comp/${f.compId}/task/${f.taskId}/score`);
  expect(res.ok(), `score read failed: ${res.status()}`).toBeTruthy();
  return (await res.json()) as TaskScore;
}

/**
 * Poll until the store has caught up with a mutation, then hand back the
 * recomputed scores.
 *
 * Reading is what drives this: revalidation is scheduled by the mutation and
 * again by every read that finds the row stale (`scheduleTaskRevalidation` in
 * score-store.ts), so polling the endpoint IS the mechanism rather than a way
 * around one. `stale: false` is the store's own statement that the blob now
 * matches its inputs; what the caller asserts next is what proves the
 * recompute actually saw the change.
 */
export async function readFreshScore(
  api: APIRequestContext,
  f: Pick<ScoredComp, "compId" | "taskId">
): Promise<TaskScore> {
  await expect
    .poll(async () => (await readScore(api, f)).stale, {
      message: "the task score never revalidated — was bumpAndRevalidateScores() called?",
      timeout: 45_000,
      intervals: [500, 1000, 2000],
    })
    .toBe(false);
  return readScore(api, f);
}

/** The single class these fixtures create. */
export function openClass(score: TaskScore): ScoredClass {
  const cls = score.class_scores.find((c) => c.pilot_class === "open");
  expect(cls, "the open class must be in the score payload").toBeTruthy();
  return cls!;
}

export function pilotIn(cls: ScoredClass, name: string): ScoredPilot | undefined {
  return cls.pilots.find((p) => p.pilot_name === name);
}

/**
 * Create the comp, its routed task, its roster and its tracks — all over the
 * API. The browser's own paths through each of these already have specs; what
 * needs this fixture is what happens AFTERWARDS.
 *
 * `extraPilots` register with no tracklog, for tests that need a pilot who has
 * not flown (a status to set, a manual flight to record).
 */
export async function createScoredComp(
  admin: APIRequestContext,
  label: string,
  extraPilots: readonly string[] = []
): Promise<ScoredComp> {
  const compRes = await admin.post("/api/comp", {
    data: { name: e2eCompName(label), category: "hg", pilot_classes: ["open"] },
  });
  expect(compRes.ok(), await compRes.text()).toBeTruthy();
  const { comp_id: compId } = (await compRes.json()) as { comp_id: string };

  const xctsk = JSON.parse(await readFile(resolve(SAMPLES, "task.xctsk"), "utf8")) as unknown;
  const taskRes = await admin.post(`/api/comp/${compId}/task`, {
    data: { name: "Task 4", task_date: TASK_DATE, pilot_classes: ["open"], xctsk },
  });
  expect(taskRes.ok(), await taskRes.text()).toBeTruthy();
  const { task_id: taskId } = (await taskRes.json()) as { task_id: string };

  const pilotIds = new Map<string, string>();
  const comp = { compId, taskId, pilotIds };
  for (const name of [...FLYING_PILOTS.map((p) => p.name), ...extraPilots]) {
    pilotIds.set(name, await registerPilot(admin, compId, name));
  }
  for (const p of FLYING_PILOTS) {
    await uploadTrack(admin, comp, p.name, readFileSync(resolve(SAMPLES, p.igc)));
  }

  return comp;
}

/** Add one pilot to the roster; returns their comp_pilot_id. */
export async function registerPilot(
  admin: APIRequestContext,
  compId: string,
  name: string,
  pilotClass = "open"
): Promise<string> {
  const res = await admin.post(`/api/comp/${compId}/pilot`, {
    data: { registered_pilot_name: name, pilot_class: pilotClass },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { comp_pilot_id: string }).comp_pilot_id;
}

/**
 * File a tracklog on behalf of a registered pilot, as the organiser.
 *
 * The body is raw gzipped IGC — the same bytes the manage grid posts from the
 * browser, so this exercises the endpoint the UI uses rather than a test-only
 * side door.
 */
export async function uploadTrack(
  admin: APIRequestContext,
  comp: ScoredComp,
  pilotName: string,
  igc: Buffer | string
): Promise<void> {
  const res = await admin.post(
    `/api/comp/${comp.compId}/task/${comp.taskId}/igc/${comp.pilotIds.get(pilotName)}`,
    { data: gzipSync(typeof igc === "string" ? Buffer.from(igc) : igc) }
  );
  expect(res.ok(), `upload for ${pilotName}: ${await res.text()}`).toBeTruthy();
}

/**
 * One of the bundled tracklogs with a REPAIRABLE altitude glitch cut into it:
 * a short run of fixes lifted `spikeMetres` above the rest of the trace.
 *
 * Why forge rather than find one: the bundled files are clean, so a spec about
 * what the page says when a track was repaired has nothing to say against them.
 * A glitch is exactly what `altitude-cleaning.ts` repairs — an implausible
 * vertical step (over 40 m/s) that returns to within 150 m of where it left,
 * inside 30 s. Five 1 Hz fixes lifted a kilometre is unambiguously that, and
 * nothing else in the file moves: same day, same place, same positions, so
 * track quality still passes it and the pilot still scores.
 *
 * These files carry no barometric channel (their pressure altitude is all
 * zeros), which is deliberate here too: it is the case where the chart has to
 * NAME the channel it hasn't got instead of drawing it flat at zero.
 */
export function spikedIgc(spikeMetres = 1000, runLength = 5): string {
  const lines = readFileSync(resolve(SAMPLES, FLYING_PILOTS[0].igc), "utf8").split("\n");
  // B HHMMSS DDMMmmmN DDDMMmmmE A PPPPP GGGGG — the GNSS altitude is the last
  // five digits, columns 30-34.
  const bIndexes = lines.flatMap((l, i) => (l.startsWith("B") ? [i] : []));
  expect(bIndexes.length, "the sample must carry B records").toBeGreaterThan(100);
  // Mid-flight, where a 1 km step is plainly a glitch rather than the launch
  // or the landing.
  const from = Math.floor(bIndexes.length / 2);
  for (const i of bIndexes.slice(from, from + runLength)) {
    const line = lines[i];
    const alt = Number(line.slice(30, 35)) + spikeMetres;
    lines[i] = line.slice(0, 30) + String(alt).padStart(5, "0") + line.slice(35);
  }
  return lines.join("\n");
}
