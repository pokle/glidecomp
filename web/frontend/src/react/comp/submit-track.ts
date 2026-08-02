/**
 * The decisions the submit-track flow makes before anyone types anything.
 *
 * Which task is probably the right one, what kind of identifier somebody just
 * typed, and which step a given failure sends them back to. All of it is
 * DOM-free so it can be tested directly (submit-track.test.ts) rather than
 * through a rendered dialog — and so the same rules hold whether the flow is
 * rendered as the /submit page or as the compact dialog on a task page.
 */

/** How the submitter names themselves. Mirrors the worker's kind union. */
export type IdentifierKind =
  | "email"
  | "civl_id"
  | "safa_id"
  | "ushpa_id"
  | "bhpa_id"
  | "dhv_id"
  | "ffvl_id"
  | "fai_id";

/**
 * Email first, deliberately. Every other kind is on the public roster
 * (`GET /api/comp/:comp_id/pilot` returns them), so email is the only one that
 * is not simply readable by anyone — which makes it the strongest thing a
 * pilot can name themselves with.
 */
export const IDENTIFIER_KINDS: { value: IdentifierKind; label: string }[] = [
  { value: "email", label: "Email address" },
  { value: "civl_id", label: "CIVL ID" },
  { value: "safa_id", label: "SAFA ID" },
  { value: "ushpa_id", label: "USHPA ID" },
  { value: "bhpa_id", label: "BHPA ID" },
  { value: "dhv_id", label: "DHV ID" },
  { value: "ffvl_id", label: "FFVL ID" },
  { value: "fai_id", label: "FAI ID" },
];

export interface OpenTask {
  task_id: string;
  name: string;
  task_date: string;
  pilot_classes: string[];
  has_xctsk: boolean;
}

export interface OpenComp {
  comp_id: string;
  name: string;
  category: string;
  timezone: string | null;
  close_date: string | null;
  suggested_task_id: string;
  tasks: OpenTask[];
}

export interface OpenCompsResponse {
  generated_at: string;
  window: { from: string; to: string; today: string };
  comps: OpenComp[];
}

/**
 * The pilot classes a task is for, minus any the task's own name already says.
 *
 * Most organisers name the class into the task ("Task 1 (Open)"), and repeating
 * it turns the picker into "Task 1 (Open) · open". But a task named "Boosfy" is
 * a class the pilot cannot see, and picking the wrong one files their track
 * against a field they did not fly in. So: say it only when the name doesn't.
 *
 * Returns null when there is nothing to add.
 */
export function unnamedClasses(
  taskName: string,
  pilotClasses: string[] | undefined
): string | null {
  if (!pilotClasses || pilotClasses.length === 0) return null;
  const name = taskName.toLowerCase();
  const missing = pilotClasses.filter((c) => !name.includes(c.toLowerCase()));
  return missing.length === 0 ? null : missing.join(", ");
}

/**
 * The two caps the server actually enforces, in
 * `web/workers/competition-api/src/igc-validation.ts`: the gzip body it
 * receives, and the IGC text that comes out of it.
 *
 * BOTH have to be checked here, and the second is the one that matters. An IGC
 * compresses roughly eight to one, so a tracklog big enough to breach the
 * compressed cap barely exists — but 3 MB of raw IGC is an ordinary
 * all-day flight logged at 1 Hz, it gzips to about 350 KB, and it is refused
 * by the DECOMPRESSED cap. Checking only the compressed size therefore looks
 * correct, passes every file anyone tries, and still hands the pilot a bare
 * 400 for the one case that happens.
 */
export const MAX_COMPRESSED_BYTES = 1024 * 1024;
export const MAX_DECOMPRESSED_BYTES = 2 * 1024 * 1024;

export const NOT_AN_IGC_MESSAGE = "That is not an IGC file.";

/**
 * Why the server will refuse this file on size alone, or null if it will not.
 *
 * Say the number, and say what to do about it: "too large" with no limit and
 * no remedy is the same dead end as the 400 it replaced.
 */
export function tooLargeReason(
  rawBytes: number,
  compressedBytes: number
): string | null {
  if (rawBytes > MAX_DECOMPRESSED_BYTES) {
    return "That tracklog is over the 2 MB limit. Trim it to the flight itself — most loggers record for hours either side — and try again.";
  }
  if (compressedBytes > MAX_COMPRESSED_BYTES) {
    return "That file is too big to accept, even compressed. Trim the tracklog to the flight and try again.";
  }
  return null;
}

export interface TrackQualityWire {
  hard_failed: boolean;
  findings: { id: string; severity: string; title: string; detail: string }[];
}

/**
 * What to say once an upload has been accepted.
 *
 * A stored track is not the same as a scored one: a wrong-day or wrong-place
 * file is kept, audited and then WITHHELD from scoring
 * (docs/track-quality.md). Announcing a bare "Track uploaded" over the top of
 * that tells the uploader the opposite of what happened, and on the admin grid
 * it is worse — the pilot whose track it is never sees this screen, so the one
 * person who could notice has been told everything is fine.
 *
 * `tone` is "warning" for anything the uploader should look at, so the message
 * does not arrive dressed as a success.
 */
export function describeUploadOutcome(
  pilotName: string,
  replaced: boolean,
  quality: TrackQualityWire | null | undefined
): { tone: "success" | "warning"; message: string } {
  const what = replaced ? "Track replaced" : "Track uploaded";
  const findings = quality?.findings ?? [];

  if (quality?.hard_failed) {
    const why = findings[0]?.title;
    return {
      tone: "warning",
      message: `${what} for ${pilotName}, but it will not be scored${why ? `: ${why.toLowerCase()}` : ""}`,
    };
  }
  if (findings.length > 0) {
    return {
      tone: "warning",
      message: `${what} for ${pilotName} — needs checking: ${findings[0].title.toLowerCase()}`,
    };
  }
  return { tone: "success", message: `${what} for ${pilotName}` };
}

/** What the pilot last submitted, remembered so day two costs no typing. */
export interface LastSubmission {
  compId: string;
  taskId: string;
  identifierKind: IdentifierKind;
  identifierValue: string;
}

export const LAST_SUBMISSION_KEY = "glidecomp:last-submit";

/**
 * Read what the pilot last submitted.
 *
 * Convenience only, never proof of identity — the worker re-checks the
 * identifier against the roster on every submission regardless of what was in
 * here. Anything malformed is treated as nothing.
 */
export function readLastSubmission(
  storage: Pick<Storage, "getItem"> | undefined
): LastSubmission | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(LAST_SUBMISSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LastSubmission>;
    if (
      typeof parsed.compId !== "string" ||
      typeof parsed.taskId !== "string" ||
      typeof parsed.identifierValue !== "string" ||
      !IDENTIFIER_KINDS.some((k) => k.value === parsed.identifierKind)
    ) {
      return null;
    }
    return parsed as LastSubmission;
  } catch {
    return null;
  }
}

export function writeLastSubmission(
  storage: Pick<Storage, "setItem"> | undefined,
  value: LastSubmission
): void {
  try {
    storage?.setItem(LAST_SUBMISSION_KEY, JSON.stringify(value));
  } catch {
    // Private browsing, a full quota — none of it is worth failing an upload.
  }
}

/**
 * Guess which kind of identifier a string is, so somebody who ignores the
 * dropdown and types straight into the field still gets matched.
 *
 * Only two guesses are safe: an `@` means an email address, and an all-digit
 * value means a CIVL ID (the only kind that is numeric in practice). Anything
 * else keeps whatever the pilot chose, because guessing between six national
 * bodies from a string like "A-4821" would be a coin toss dressed up as help.
 */
export function inferIdentifierKind(
  value: string,
  current: IdentifierKind
): IdentifierKind {
  const trimmed = value.trim();
  if (trimmed === "") return current;
  if (trimmed.includes("@")) return "email";
  if (/^\d{3,}$/.test(trimmed) && current === "email") return "civl_id";
  return current;
}

export interface TaskChoice {
  compId: string;
  taskId: string;
}

/**
 * The task the pilot most likely means, in order of how strong the evidence is:
 *
 *   1. what the URL asked for — somebody followed a link or a QR code;
 *   2. where they submitted last, if that comp is still open — a pilot at a
 *      six-day comp submits to the same comp every evening;
 *   3. the comp whose task is nearest today, and that comp's own suggestion.
 *
 * Returns null when there is nothing to go on, which is a real state: the
 * picker shows the list and asks.
 */
export function pickDefaultTask(
  comps: OpenComp[],
  opts: {
    fromUrl?: { compId?: string | null; taskId?: string | null };
    last?: LastSubmission | null;
  } = {}
): TaskChoice | null {
  const { fromUrl, last } = opts;

  if (fromUrl?.compId && fromUrl?.taskId) {
    return { compId: fromUrl.compId, taskId: fromUrl.taskId };
  }

  const findComp = (compId: string) => comps.find((c) => c.comp_id === compId);

  // A comp named in the URL but no task: fall through to that comp's own pick.
  if (fromUrl?.compId) {
    const comp = findComp(fromUrl.compId);
    if (comp) return { compId: comp.comp_id, taskId: comp.suggested_task_id };
    return null;
  }

  if (last) {
    const comp = findComp(last.compId);
    if (comp) {
      // Prefer the exact task if it is still listed, else the comp's own
      // suggestion — the pilot has moved on to the next day's task.
      const stillThere = comp.tasks.some((t) => t.task_id === last.taskId);
      return {
        compId: comp.comp_id,
        taskId: stillThere ? last.taskId : comp.suggested_task_id,
      };
    }
  }

  const first = comps[0];
  if (!first) return null;
  return { compId: first.comp_id, taskId: first.suggested_task_id };
}

/** The steps of the flow, in the order they are asked. */
export type SubmitStep = "task" | "identity" | "file";

/** Every failure code the worker can answer a submission with. */
export type SubmitErrorCode =
  | "bad_identifier"
  | "anonymous_not_permitted"
  | "registration_closed"
  | "comp_closed"
  | "comp_not_found"
  | "task_not_found"
  | "no_pilot_match"
  | "ambiguous_pilot_match"
  | "invalid_file"
  | "task_pilot_limit"
  | "rate_limited";

export interface Organiser {
  name: string;
  email: string;
}

export interface SubmitError {
  error: string;
  code?: SubmitErrorCode;
  comp?: { comp_id: string; name: string };
  organisers?: Organiser[];
  identifier_label?: string;
  close_date?: string | null;
  match_count?: number;
  retry_after_seconds?: number;
}

/**
 * Which step can actually fix a given failure.
 *
 * Null means no step can — the pilot has to talk to somebody, or wait — and
 * the panel says so instead of pretending a retry will help.
 */
export function repairStepFor(code: SubmitErrorCode | undefined): SubmitStep | null {
  switch (code) {
    case "bad_identifier":
    case "no_pilot_match":
      return "identity";
    case "invalid_file":
      return "file";
    case "comp_not_found":
    case "task_not_found":
      return "task";
    // An ambiguous roster, a closed comp, a comp that wants a sign-in, a full
    // task, a spent budget: none of these are repairable by trying again.
    default:
      return null;
  }
}

/** True when the pilot's own answer is to sign in rather than to edit a field. */
export function needsSignIn(code: SubmitErrorCode | undefined): boolean {
  return code === "anonymous_not_permitted";
}

// ---------------------------------------------------------------------------
// Formatting the summary the upload comes back with
// ---------------------------------------------------------------------------

export interface FlightSummaryWire {
  flight_date: string | null;
  takeoff_at: string | null;
  landing_at: string | null;
  duration_seconds: number | null;
  first_fix_at: string | null;
  last_fix_at: string | null;
  track_length_m: number | null;
  track_length_airborne_only: boolean;
  max_altitude_m: number | null;
  max_altitude_above_takeoff_m: number | null;
  fix_count: number;
  median_fix_interval_seconds: number | null;
  header_pilot_name: string | null;
  header_glider_type: string | null;
  header_glider_id: string | null;
  header_competition_id: string | null;
}

/**
 * How long a rate-limited pilot has to wait, as the tail of "Try again …".
 *
 * Returns the whole phrase, preposition included, because the units change the
 * grammar: "in about 10 minutes" but "tomorrow", not "in tomorrow". The
 * budgets are daily, so a naive minutes rendering would also say "in 1440
 * minutes", which reads as a bug rather than an answer.
 */
export function formatRetryAfter(seconds: number): string {
  if (seconds < 90) return "in a moment";
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 90) return `in about ${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in about ${hours} hour${hours === 1 ? "" : "s"}`;
  return "tomorrow";
}

/** "4h 31m", "18m", "—". */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return "—";
  const total = Math.round(seconds / 60);
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

/** Clock time in the competition's own zone, which is the one the pilot flew in. */
export function formatClockInZone(
  iso: string | null,
  timeZone: string | null
): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}

export function formatKm(metres: number | null): string {
  if (metres === null) return "—";
  return `${(metres / 1000).toFixed(1)} km`;
}

export function formatMetres(metres: number | null): string {
  if (metres === null) return "—";
  return `${Math.round(metres).toLocaleString("en-AU")} m`;
}
