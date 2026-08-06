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
import { ANONYMOUS_ACTOR_NAME } from "../audit";
import {
  PILOT_IDENTIFIER_LABELS,
  findCompPilotsByIdentifier,
  isPilotIdentifierKind,
  type CompPilotMatch,
  type PilotIdentifierKind,
} from "../pilot-linker";
import { ingestTrackSubmission } from "../track-upload";
import {
  ANON_SUBMIT_FUTILE,
  ANON_SUBMIT_PER_COMP,
  ANON_SUBMIT_PER_PILOT,
  chargeBudget,
  peekBudget,
} from "../rate-limit";
import {
  isCompClosed,
  organisersOf,
  submissionsClosedBody,
} from "../submission-gate";

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
  | "rate_limited"
  | "submissions_closed";

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

    /**
     * Charge the caller's effort budget and hand back the failure.
     *
     * EVERY exit that does not store a track goes through here, so the one
     * per-IP budget on this route is charged for wasted work and nothing else.
     * A pilot who gets their file in pays nothing — which is what makes a
     * per-IP budget safe on a route whose whole point is a hillside full of
     * pilots sharing one connection.
     *
     * A 429 deliberately does NOT go through here: a caller already being
     * turned away by one budget should not also spend another, or a pilot who
     * hits their own six-a-day would burn allowance shared with everybody else
     * at the comp.
     */
    const futile = async <T>(response: T): Promise<T> => {
      await chargeBudget(db, "futile", clientIp, ANON_SUBMIT_FUTILE);
      return response;
    };

    // ── Cheapest rejections first. Nothing that costs R2 or CPU runs before
    // something cheaper can turn the request away.
    //
    // The budgets below are PEEKED here and charged at the far end, once a
    // track is actually stored (SEC-39). Peeking keeps this rule — a comp or
    // pilot at its cap is still turned away before the body is read — while
    // making the counters unmovable by anyone who is not really uploading.

    const effort = await peekBudget(db, "futile", clientIp, ANON_SUBMIT_FUTILE);
    if (!effort.allowed) {
      return rateLimited(effort.retryAfterSeconds, "attempts");
    }

    const identifier = readIdentifier(
      c.req.header(KIND_HEADER),
      c.req.header(VALUE_HEADER)
    );
    if ("problem" in identifier) {
      return futile(
        c.json(
          {
            error: identifier.problem,
            code: "bad_identifier" satisfies AnonSubmitCode,
            accepted_kinds: Object.keys(PILOT_IDENTIFIER_LABELS),
          },
          400
        )
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
      return futile(
        c.json(
          {
            error: "We could not find that competition.",
            code: "comp_not_found" satisfies AnonSubmitCode,
          },
          404
        )
      );
    }

    if (!comp.open_igc_upload) {
      return futile(
        c.json(
          {
            error: `${comp.name} asks pilots to sign in before submitting a track.`,
            code: "anonymous_not_permitted" satisfies AnonSubmitCode,
            comp: { comp_id: encodeId(alphabet, compId), name: comp.name },
            organisers: await organisersOf(db, compId),
          },
          403
        )
      );
    }

    if (isCompClosed(comp.close_date)) {
      return futile(
        c.json(
          {
            error: `${comp.name} has closed for track submissions.`,
            code: "comp_closed" satisfies AnonSubmitCode,
            comp: { comp_id: encodeId(alphabet, compId), name: comp.name },
            close_date: comp.close_date,
            organisers: await organisersOf(db, compId),
          },
          400
        )
      );
    }

    const task = await db
      .prepare(
        "SELECT task_id, name, submissions_closed FROM task WHERE task_id = ? AND comp_id = ?"
      )
      .bind(taskId, compId)
      .first<{ task_id: number; name: string; submissions_closed: number }>();
    if (!task) {
      return futile(
        c.json(
          {
            error: `That task is not part of ${comp.name}.`,
            code: "task_not_found" satisfies AnonSubmitCode,
            comp: { comp_id: encodeId(alphabet, compId), name: comp.name },
          },
          404
        )
      );
    }

    // A hard stop here: this route has no admin concept to bypass with, and an
    // anonymous caller is exactly who the organiser meant to stop.
    if (task.submissions_closed) {
      return futile(c.json(await submissionsClosedBody(db, compId, taskId), 403));
    }

    // Now that the competition is known to be real, open and running, its
    // shared allowance is worth consulting. Peeked, never charged here: a
    // comp_id is public in its own URL, so charging on arrival let anyone
    // spend a competition's whole day without uploading anything.
    const compBudget = await peekBudget(db, "comp", compId, ANON_SUBMIT_PER_COMP);
    if (!compBudget.allowed) {
      return rateLimited(compBudget.retryAfterSeconds, "comp");
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
      // The effort budget carries the enumeration guard the old miss-only
      // budget existed for: without a cost on failure, this answers "is that
      // address registered here?" as fast as anyone can ask.
      return futile(
        c.json(
          {
            error: `No pilot with that ${label} is registered for ${comp.name}.`,
            code: "no_pilot_match" satisfies AnonSubmitCode,
            comp: { comp_id: encodeId(alphabet, compId), name: comp.name },
            identifier_kind: identifier.kind,
            identifier_label: label,
            organisers: await organisersOf(db, compId),
          },
          404
        )
      );
    }

    if (matches.length > 1) {
      // Two roster rows answering to one identifier is the organiser's to
      // fix. Guessing would file the track against the wrong person.
      return futile(
        c.json(
          {
            error: `That ${label} matches more than one pilot registered for ${comp.name}, so we cannot tell which is you.`,
            code: "ambiguous_pilot_match" satisfies AnonSubmitCode,
            comp: { comp_id: encodeId(alphabet, compId), name: comp.name },
            match_count: matches.length,
            organisers: await organisersOf(db, compId),
          },
          409
        )
      );
    }

    const pilot: CompPilotMatch = matches[0];
    const pilotName = pilot.registered_pilot_name;

    // Peeked, not charged: six a day is small, and an identifier that resolves
    // is public on the roster, so charging on arrival meant six empty POSTs
    // could take a named pilot's whole landing day.
    const pilotBudget = await peekBudget(
      db,
      "cp",
      pilot.comp_pilot_id,
      ANON_SUBMIT_PER_PILOT
    );
    if (!pilotBudget.allowed) {
      return rateLimited(pilotBudget.retryAfterSeconds, "pilot");
    }

    // ── The file. From here on this is the same pipeline the signed-in
    // routes run — see track-upload.ts.

    const ingested = await ingestTrackSubmission(c, {
      compId,
      taskId,
      compPilotId: pilot.comp_pilot_id,
      comp,
      task,
      body: await c.req.arrayBuffer(),
      filedForName: pilotName,
      // No user: there is no account to point at, and inventing one would make
      // the record lie. `audit()` records actor_name "system" for a null user,
      // so the sentence below carries the anonymity itself.
      actor: null,
      uploader: { userId: null, name: ANONYMOUS_ACTOR_NAME },
      submitter: { kind: "anonymous", identifierLabel: label },
      // Identifier LABEL only, never the value — the log is public, and the
      // value is either personal data or the key that granted the action.
      describeUpload: ({ replaced, size, previously }) =>
        `${replaced ? "Replaced" : "Uploaded"} IGC for ${pilotName} by anonymous ` +
        `submission, matched on ${label} (${size})${previously}`,
    });

    if (!ingested.ok) {
      const { rejection } = ingested;
      return futile(
        rejection.kind === "invalid_file"
          ? c.json(
              {
                error: rejection.message,
                code: "invalid_file" satisfies AnonSubmitCode,
                reason: rejection.reason,
              },
              400
            )
          : c.json(
              {
                error: rejection.message,
                code: "task_pilot_limit" satisfies AnonSubmitCode,
                organisers: await organisersOf(db, compId),
              },
              400
            )
      );
    }

    // ── The track is in. THIS is the damage the two budgets peeked at above
    // bound, so this is where they are charged — not on arrival, where a
    // caller who never uploaded anything could spend them (SEC-39).
    //
    // The verdicts are deliberately ignored: the peeks admitted this request,
    // the file is already stored, and turning it away now would leave a track
    // in R2 that the pilot was told never arrived.
    await chargeBudget(db, "comp", compId, ANON_SUBMIT_PER_COMP);
    await chargeBudget(db, "cp", pilot.comp_pilot_id, ANON_SUBMIT_PER_PILOT);

    return c.json(
      {
        ...ingested.result,
        comp_id: encodeId(alphabet, compId),
        task_id: encodeId(alphabet, taskId),
        // Echoed so the dialog can ask "submitting for Jane Smith — is that
        // you?" before the pilot walks away from the screen.
        pilot_class: pilot.pilot_class,
        matched_on: identifier.kind,
      },
      ingested.status
    );
  }
);
