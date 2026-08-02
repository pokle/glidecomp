/**
 * Anonymous track submission.
 *
 * A pilot who has just landed should be able to get their file in from the
 * homepage without an account. So instead of proving who they are with a
 * session, they NAME themselves with an identifier the organiser already
 * registered — a CIVL ID, an email address — and the roster does the rest.
 *
 * What that trades away, stated plainly: the identifier is a name, not a
 * secret. `GET /api/comp/:comp_id/pilot` is public and returns every pilot's
 * national IDs, and CIVL ids are on the FAI ranking site besides. Anyone who
 * can read the roster can submit as anyone on it. What contains that:
 *
 *   - the organiser opts in per competition (`open_igc_upload`), the same
 *     switch that already lets registered pilots upload for each other;
 *   - the identifier must ALREADY be on the roster. This route never creates
 *     a `pilot` or a `comp_pilot`, so it cannot grow a competition;
 *   - every submission is in the public audit log, named as anonymous;
 *   - a replacement emails the pilot, which is the detection channel;
 *   - the superseded track is retained and an admin can restore it;
 *   - track quality still withholds a wrong-day or wrong-place file from
 *     scoring, which defeats the laziest version of the attack;
 *   - budgets (rate-limit.ts) bound how much any of that can be done.
 *
 * It is a deliberate lowering of a barrier for low-stakes competitions, and
 * the same posture docs/email-submission-spec.md argues for: flag, don't
 * reject.
 *
 * The route lives in its own file rather than in igc.ts because its
 * authorisation story is the whole point of it and should be readable in one
 * screen.
 */

import { Hono } from "hono";
import type { Env } from "../env";
import { encodeId } from "../sqids";
import { sqidsMiddleware } from "../middleware/sqids";
import { ANONYMOUS_ACTOR_NAME, audit } from "../audit";
import { bumpAndRevalidateScores } from "../score-store";
import {
  PILOT_IDENTIFIER_LABELS,
  findCompPilotsByIdentifier,
  isPilotIdentifierKind,
  type CompPilotMatch,
  type PilotIdentifierKind,
} from "../pilot-linker";
import { applyStatusOnTrackUpload } from "./pilot-status";
import { validateAndDecompressIgc, IgcValidationException } from "../igc-validation";
import {
  TaskPilotLimitError,
  assessUploadedTrack,
  flightSummaryOf,
  formatBytes,
  igcPilotNameOf,
  parseUploadedIgc,
  qualityAuditLine,
  storeUploadedTrack,
  toUploadResult,
} from "../track-upload";
import {
  ANON_SUBMIT_MISSES,
  ANON_SUBMIT_PER_COMP,
  ANON_SUBMIT_PER_PILOT,
  chargeBudget,
} from "../rate-limit";
import {
  buildTrackReplacedEmail,
  sendTrackReplacedNotice,
} from "../track-replaced-email";

type Variables = {
  ids: { comp_id?: number; task_id?: number };
};

type HonoEnv = { Bindings: Env; Variables: Variables };

/**
 * How the submitter names the pilot. Headers, not the query string: the value
 * can be an email address, and query strings land in access logs, `Referer`
 * and browser history. Same precedent as `x-filename` on /api/user/tracks.
 *
 * Percent-encoded because the Headers API rejects bytes outside 0x20–0x7E,
 * and a pilot's identifier may not be ASCII.
 */
const KIND_HEADER = "x-pilot-ident-kind";
const VALUE_HEADER = "x-pilot-ident";
const MAX_IDENTIFIER_CHARS = 190;

/**
 * A repairable failure.
 *
 * `error` is the sentence a person reads; `code` is what the dialog branches
 * on to reopen the step that can fix it; the rest is what it needs to offer
 * the fix. Every failure that a pilot standing on a hill could plausibly
 * repair carries enough to repair it — and where they cannot, it names the
 * organiser who can.
 */
export type AnonSubmitCode =
  | "bad_identifier"
  | "anonymous_not_permitted"
  | "comp_closed"
  | "comp_not_found"
  | "task_not_found"
  | "no_pilot_match"
  | "ambiguous_pilot_match"
  | "invalid_file"
  | "task_pilot_limit"
  | "rate_limited";

interface Organiser {
  name: string;
  email: string;
}

/**
 * The organisers of a competition, with their addresses.
 *
 * Not a new exposure: `GET /api/comp/:comp_id` already returns `admins` with
 * emails to anonymous callers, and the public comp page renders them with a
 * `mailto:` link. It is included only on genuine failures, which are
 * rate-limited, so this does not become a harvesting endpoint.
 */
async function organisersOf(db: D1Database, compId: number): Promise<Organiser[]> {
  const rows = await db
    .prepare(
      `SELECT u.email, u.name FROM comp_admin ca
       JOIN "user" u ON ca.user_id = u.id
       WHERE ca.comp_id = ?`
    )
    .bind(compId)
    .all<{ email: string; name: string }>();
  return rows.results;
}

/** Read and validate the two identifier headers. */
function readIdentifier(
  rawKind: string | undefined,
  rawValue: string | undefined
): { kind: PilotIdentifierKind; value: string } | { problem: string } {
  if (!rawKind || !rawValue) {
    return { problem: "Tell us who the track is for." };
  }
  if (!isPilotIdentifierKind(rawKind)) {
    return { problem: "That is not an identifier we can look up." };
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawValue);
  } catch {
    return { problem: "We could not read the identifier you sent." };
  }
  const value = decoded.trim();
  if (value === "") {
    return { problem: "Enter your identifier so we know whose track this is." };
  }
  if (value.length > MAX_IDENTIFIER_CHARS) {
    return { problem: "That identifier is too long to be one we hold." };
  }
  return { kind: rawKind, value };
}

/** Date-only close_date means end of day, same rule as the signed-in routes. */
function isClosed(closeDate: string | null): boolean {
  if (!closeDate) return false;
  const at = closeDate.includes("T") ? closeDate : closeDate + "T23:59:59Z";
  return new Date() > new Date(at);
}

export const igcAnonRoutes = new Hono<HonoEnv>().post(
  // "open-submit" rather than a bare word: the sqid alphabet is a–z only, so a
  // hyphenated segment can never collide with a real comp_pilot_id and shadow
  // the sibling on-behalf route.
  "/api/comp/:comp_id/task/:task_id/igc/open-submit",
  // Deliberately NO auth middleware — not even optionalAuth. A cookie must not
  // change the answer, or the route's behaviour becomes two routes.
  sqidsMiddleware,
  async (c) => {
    const compId = c.var.ids.comp_id!;
    const taskId = c.var.ids.task_id!;
    const alphabet = c.env.SQIDS_ALPHABET;
    const db = c.env.DB;
    const clientIp = c.req.header("cf-connecting-ip") ?? "unknown";

    const rateLimited = (retryAfterSeconds: number, scope: string) =>
      c.json(
        {
          error:
            "That is more submissions than we accept in a day. Try again later, or ask the competition organiser to upload for you.",
          code: "rate_limited" satisfies AnonSubmitCode,
          scope,
          retry_after_seconds: retryAfterSeconds,
        },
        429,
        { "Retry-After": String(retryAfterSeconds) }
      );

    // ── Cheapest rejections first. Nothing that costs R2 or CPU runs before
    // something cheaper can turn the request away.

    const compBudget = await chargeBudget(db, "comp", compId, ANON_SUBMIT_PER_COMP);
    if (!compBudget.allowed) {
      return rateLimited(compBudget.retryAfterSeconds, "comp");
    }

    const identifier = readIdentifier(
      c.req.header(KIND_HEADER),
      c.req.header(VALUE_HEADER)
    );
    if ("problem" in identifier) {
      return c.json(
        {
          error: identifier.problem,
          code: "bad_identifier" satisfies AnonSubmitCode,
          accepted_kinds: Object.keys(PILOT_IDENTIFIER_LABELS),
        },
        400
      );
    }

    const comp = await db
      .prepare(
        "SELECT comp_id, name, close_date, open_igc_upload, test FROM comp WHERE comp_id = ?"
      )
      .bind(compId)
      .first<{
        comp_id: number;
        name: string;
        close_date: string | null;
        open_igc_upload: number;
        test: number;
      }>();

    // A hidden test comp answers exactly as a missing one does, so this route
    // never becomes a way to discover that one exists.
    if (!comp || comp.test) {
      return c.json(
        {
          error: "We could not find that competition.",
          code: "comp_not_found" satisfies AnonSubmitCode,
        },
        404
      );
    }

    if (!comp.open_igc_upload) {
      return c.json(
        {
          error: `${comp.name} asks pilots to sign in before submitting a track.`,
          code: "anonymous_not_permitted" satisfies AnonSubmitCode,
          comp: { comp_id: encodeId(alphabet, compId), name: comp.name },
          organisers: await organisersOf(db, compId),
        },
        403
      );
    }

    if (isClosed(comp.close_date)) {
      return c.json(
        {
          error: `${comp.name} has closed for track submissions.`,
          code: "comp_closed" satisfies AnonSubmitCode,
          comp: { comp_id: encodeId(alphabet, compId), name: comp.name },
          close_date: comp.close_date,
          organisers: await organisersOf(db, compId),
        },
        400
      );
    }

    const task = await db
      .prepare("SELECT task_id, name FROM task WHERE task_id = ? AND comp_id = ?")
      .bind(taskId, compId)
      .first<{ task_id: number; name: string }>();
    if (!task) {
      return c.json(
        {
          error: `That task is not part of ${comp.name}.`,
          code: "task_not_found" satisfies AnonSubmitCode,
          comp: { comp_id: encodeId(alphabet, compId), name: comp.name },
        },
        404
      );
    }

    // ── Who is this?

    const matches = await findCompPilotsByIdentifier(
      db,
      compId,
      identifier.kind,
      identifier.value
    );
    const label = PILOT_IDENTIFIER_LABELS[identifier.kind];

    if (matches.length === 0) {
      // Charged only on a miss, so this cannot become a fast way to test
      // whether an address is registered.
      const missBudget = await chargeBudget(
        db,
        "miss",
        clientIp,
        ANON_SUBMIT_MISSES
      );
      if (!missBudget.allowed) {
        return rateLimited(missBudget.retryAfterSeconds, "probe");
      }
      return c.json(
        {
          error: `No pilot with that ${label} is registered for ${comp.name}.`,
          code: "no_pilot_match" satisfies AnonSubmitCode,
          comp: { comp_id: encodeId(alphabet, compId), name: comp.name },
          identifier_kind: identifier.kind,
          identifier_label: label,
          organisers: await organisersOf(db, compId),
        },
        404
      );
    }

    if (matches.length > 1) {
      // Two roster rows answering to one identifier is the organiser's to
      // fix. Guessing would file the track against the wrong person.
      return c.json(
        {
          error: `That ${label} matches more than one pilot registered for ${comp.name}, so we cannot tell which is you.`,
          code: "ambiguous_pilot_match" satisfies AnonSubmitCode,
          comp: { comp_id: encodeId(alphabet, compId), name: comp.name },
          match_count: matches.length,
          organisers: await organisersOf(db, compId),
        },
        409
      );
    }

    const pilot: CompPilotMatch = matches[0];
    const pilotName = pilot.registered_pilot_name;

    const pilotBudget = await chargeBudget(
      db,
      "cp",
      pilot.comp_pilot_id,
      ANON_SUBMIT_PER_PILOT
    );
    if (!pilotBudget.allowed) {
      return rateLimited(pilotBudget.retryAfterSeconds, "pilot");
    }

    // ── The file.

    const body = await c.req.arrayBuffer();
    let igcText: string;
    try {
      igcText = await validateAndDecompressIgc(body);
    } catch (err) {
      if (err instanceof IgcValidationException) {
        return c.json(
          {
            error: err.detail.message,
            code: "invalid_file" satisfies AnonSubmitCode,
            reason: err.detail.kind,
          },
          400
        );
      }
      throw err;
    }

    const igc = parseUploadedIgc(igcText);
    const igcPilotName = igcPilotNameOf(igc);
    const quality = await assessUploadedTrack(db, taskId, igc);

    let stored;
    try {
      stored = await storeUploadedTrack(db, c.env.R2, {
        compId,
        taskId,
        compPilotId: pilot.comp_pilot_id,
        body,
        igcPilotName,
        // No user id: there is no account to point at, and inventing one
        // would make the record lie.
        uploader: { userId: null, name: ANONYMOUS_ACTOR_NAME },
      });
    } catch (err) {
      if (err instanceof TaskPilotLimitError) {
        return c.json(
          {
            error: err.message,
            code: "task_pilot_limit" satisfies AnonSubmitCode,
            organisers: await organisersOf(db, compId),
          },
          400
        );
      }
      throw err;
    }

    await bumpAndRevalidateScores(c, [taskId]);

    // `audit()` records actor_name "system" for a null user, so the sentence
    // has to carry the anonymity itself. Identifier LABEL only, never the
    // value — the log is public, and the value is either personal data or the
    // key that granted the action.
    await audit(db, null, compId, {
      subject_type: "track",
      subject_id: stored.taskTrackId,
      subject_name: pilotName,
      description: stored.replaced
        ? `Replaced IGC for ${pilotName} by anonymous submission, matched on ${label} (${formatBytes(stored.fileSize)})` +
          describePrevious(stored.previousUploadedAt, stored.uploadedAt)
        : `Uploaded IGC for ${pilotName} by anonymous submission, matched on ${label} (${formatBytes(stored.fileSize)})`,
    });

    const qualityLine = quality && qualityAuditLine(pilotName, quality);
    if (qualityLine) {
      await audit(db, null, compId, {
        subject_type: "track",
        subject_id: stored.taskTrackId,
        subject_name: pilotName,
        description: qualityLine,
      });
    }

    // A hard-failed file is not evidence that this pilot flew, so it must not
    // stamp them "Landed" or supersede a scorekeeper's manual flight.
    if (!quality?.hardFailed) {
      await applyStatusOnTrackUpload(
        db,
        null,
        compId,
        taskId,
        pilot.comp_pilot_id,
        pilotName
      );
    }

    // ── Tell the pilot their track was replaced.

    let notified: { emailed: boolean; reason?: string; masked_to?: string } = {
      emailed: false,
    };
    if (stored.replaced) {
      if (pilot.notify_email) {
        const origin = c.env.SITE_ORIGIN ?? "https://glidecomp.com";
        const organisers = await organisersOf(db, compId);
        const message = buildTrackReplacedEmail({
          to: pilot.notify_email,
          pilotName,
          compName: comp.name,
          taskName: task.name,
          identifierLabel: label,
          // Bare-id paths are valid URLs on their own — building a slugged one
          // would put URL knowledge in the worker, which is where it drifts.
          taskUrl: `${origin}/comp/${encodeId(alphabet, compId)}/task/${encodeId(alphabet, taskId)}`,
          organisers,
        });
        c.executionCtx.waitUntil(
          sendTrackReplacedNotice(c.env.EMAIL, message)
        );
        notified = { emailed: true, masked_to: maskEmail(pilot.notify_email) };
      } else {
        // Nobody to write to. The replacement still stands — refusing it would
        // punish exactly the pilots whose organiser did the least data entry —
        // but the audit log has to say so, because it is now the only record.
        notified = { emailed: false, reason: "no_registered_email" };
        await audit(db, null, compId, {
          subject_type: "track",
          subject_id: stored.taskTrackId,
          subject_name: pilotName,
          description: `Could not advise ${pilotName} that their track was replaced by an anonymous submission — no email address is registered for them`,
        });
      }
    }

    return c.json(
      {
        task_track_id: encodeId(alphabet, stored.taskTrackId),
        comp_pilot_id: encodeId(alphabet, pilot.comp_pilot_id),
        comp_id: encodeId(alphabet, compId),
        task_id: encodeId(alphabet, taskId),
        // Echoed so the dialog can ask "submitting for Jane Smith — is that
        // you?" before the pilot walks away from the screen.
        pilot_name: pilotName,
        pilot_class: pilot.pilot_class,
        matched_on: identifier.kind,
        igc_filename: stored.r2Key,
        uploaded_at: stored.uploadedAt,
        file_size: stored.fileSize,
        replaced: stored.replaced,
        notified,
        track_quality: toUploadResult(quality),
        flight_summary: flightSummaryOf(igc),
      },
      stored.replaced ? 200 : 201
    );
  }
);

/**
 * How long the track being replaced had been up.
 *
 * The audit log is read by people, so it says "eleven minutes earlier" rather
 * than printing an ISO timestamp mid-sentence. Relative, because what matters
 * to somebody scanning the log is whether this was a pilot fixing their own
 * upload or somebody overwriting a track that had stood all day.
 */
function describePrevious(previousAt: string | null, now: string): string {
  if (!previousAt) return "";
  const gapMs = new Date(now).getTime() - new Date(previousAt).getTime();
  if (!Number.isFinite(gapMs) || gapMs < 0) return "";
  const minutes = Math.round(gapMs / 60_000);
  if (minutes < 1) return " — replacing a track uploaded moments earlier";
  if (minutes < 60) {
    return ` — replacing a track uploaded ${minutes} minute${minutes === 1 ? "" : "s"} earlier`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return ` — replacing a track uploaded ${hours} hour${hours === 1 ? "" : "s"} earlier`;
  }
  const days = Math.round(hours / 24);
  return ` — replacing a track uploaded ${days} days earlier`;
}

/** Enough of an address to recognise, not enough to learn. */
function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 1)}***@${domain}`;
}
