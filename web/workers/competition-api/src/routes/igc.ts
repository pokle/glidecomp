import { Hono } from "hono";
import type { AuthedEnv } from "../env";
import { encodeId, decodeId } from "../sqids";
import { sqidsMiddleware } from "../middleware/sqids";
import { requireAuth, optionalAuth, requireCompAdmin } from "../middleware/auth";
import { isCompAdmin } from "../super-admin";
import {
  updatePenaltySchema,
  trackQualityOverrideSchema,
  validated,
} from "../validators";
import { audit } from "../audit";
import { bumpAndRevalidateScores } from "../score-store";
import {
  findUnclaimedRegistrations,
  linkExistingRegistrations,
  orderByLikelihood,
} from "../pilot-linker";
import {
  supersedeActiveManualFlights,
  markLandedFromEvidence,
} from "../manual-flight-store";
import { ingestTrackSubmission } from "../track-upload";
import {
  isCompClosed,
  maskEmail,
  organisersOf,
  submissionsClosedBody,
} from "../submission-gate";
import { hiddenFromCaller } from "../comp-visibility";

/**
 * Ensure a `pilot` row exists for the given user. Returns the pilot_id.
 */
async function ensurePilot(
  db: D1Database,
  userId: string,
  userName: string
): Promise<number> {
  const existing = await db
    .prepare("SELECT pilot_id FROM pilot WHERE user_id = ?")
    .bind(userId)
    .first<{ pilot_id: number }>();
  if (existing) return existing.pilot_id;

  const res = await db
    .prepare("INSERT INTO pilot (user_id, name) VALUES (?, ?)")
    .bind(userId, userName)
    .run();
  return res.meta.last_row_id;
}

/**
 * How a signed-in pilot names the registration this track is for.
 *
 * A header, not a query string, for the same reason igc-anon.ts gives: this
 * identifies a person, and query strings land in access logs, `Referer` and
 * browser history.
 *
 * `new-pilot` is hyphenated deliberately. The sqid alphabet is a–z only, so a
 * hyphenated sentinel can never collide with a real comp_pilot_id — the same
 * trick as the `open-submit` and `open-now` route segments. A bare word like
 * "new" WOULD be a decodable id and must not be used.
 */
const COMP_PILOT_HEADER = "x-comp-pilot";
const NEW_PILOT_SENTINEL = "new-pilot";

/** Parse the header into a claim. "invalid" means the value was not readable. */
function readSelfClaim(
  raw: string | undefined,
  alphabet: string
): SelfClaim | "invalid" {
  const value = raw?.trim();
  if (!value) return { kind: "auto" };
  if (value === NEW_PILOT_SENTINEL) return { kind: "new" };
  const id = decodeId(alphabet, value);
  if (id === null) return "invalid";
  return { kind: "row", compPilotId: id };
}

/**
 * Which registration a signed-in pilot says this track belongs to.
 *
 * `auto` is the ordinary case — nothing was said, so the server works it out
 * (and refuses to guess when it cannot). The other two come from the
 * `x-comp-pilot` header, and are the pilot answering the question.
 */
export type SelfClaim =
  | { kind: "auto" }
  | { kind: "row"; compPilotId: number }
  | { kind: "new" };

/** A registration the pilot might be, offered when the server will not guess. */
export interface IdentityCandidate {
  comp_pilot_id: number;
  registered_pilot_name: string;
  pilot_class: string;
  /** Masked, so a pilot can recognise their own old address without the
   *  roster becoming an address book. */
  notify_email_masked: string | null;
}

export type EnsureResult =
  | { outcome: "existing"; compPilotId: number }
  /** An exact id/email match claimed the organiser's row. */
  | { outcome: "claimed"; compPilotId: number; preRegName: string }
  /** The pilot pointed at the row themselves. */
  | { outcome: "claimed-by-choice"; compPilotId: number; preRegName: string }
  | { outcome: "registered"; compPilotId: number; declined: number }
  | { outcome: "ambiguous"; candidates: IdentityCandidate[] }
  | { outcome: "registration-closed" }
  | {
      outcome: "claim-rejected";
      reason: "not_found" | "already_claimed" | "already_registered";
      compPilotId?: number;
    };

/**
 * Find, claim or create this pilot's registration in a competition — and
 * NEVER silently create a second one.
 *
 * The bug this exists to prevent: a pilot the organiser registered with a
 * mistyped email, whose own profile carries no national ids, matches nothing.
 * The old code inserted a fresh roster row, so the pilot was registered twice
 * — the organiser's entry sitting empty, a self-made one carrying the track —
 * and nobody was told. The pilot count feeds launch validity (S7F §9.1), so
 * the phantom is a scoring input too.
 *
 * The fix is step 4 below: if there is ANY unclaimed registration in this
 * comp, the answer is "ask the pilot", not "make a new one". That rule looks
 * at no names at all — see `nameAffinity` for why names order the question but
 * never answer it.
 */
async function ensureCompPilot(
  db: D1Database,
  compId: number,
  pilotId: number,
  pilotName: string,
  defaultPilotClass: string,
  /** False when `comp.open_registration` is off — an unknown pilot is refused
   *  rather than added. Claiming an existing pre-registration still works:
   *  that pilot IS on the roster, the account just had not been linked yet. */
  mayRegister: boolean,
  claim: SelfClaim = { kind: "auto" }
): Promise<EnsureResult> {
  // 1. Already on the roster under this account.
  const existing = await db
    .prepare(
      "SELECT comp_pilot_id FROM comp_pilot WHERE comp_id = ? AND pilot_id = ?"
    )
    .bind(compId, pilotId)
    .first<{ comp_pilot_id: number }>();
  if (existing) {
    if (claim.kind === "row" && claim.compPilotId !== existing.comp_pilot_id) {
      // They are already somebody here. Silently moving the track to another
      // row would either hide a genuine roster duplicate (the organiser's job)
      // or act on a mis-tap. Say so instead.
      return {
        outcome: "claim-rejected",
        reason: "already_registered",
        compPilotId: existing.comp_pilot_id,
      };
    }
    return { outcome: "existing", compPilotId: existing.comp_pilot_id };
  }

  // 2. The pilot named a row. Claim it, but only if it is genuinely unclaimed.
  //    Strict on purpose: a wrong track is recoverable (the superseded file is
  //    retained, restore exists), but a wrong CLAIM is a persistent identity
  //    link that redirects every future upload and shows a stranger's comp in
  //    the pilot's own flights.
  if (claim.kind === "row") {
    const row = await db
      .prepare(
        `SELECT comp_pilot_id, registered_pilot_name, pilot_id
         FROM comp_pilot WHERE comp_pilot_id = ? AND comp_id = ?`
      )
      .bind(claim.compPilotId, compId)
      .first<{
        comp_pilot_id: number;
        registered_pilot_name: string;
        pilot_id: number | null;
      }>();
    if (!row) return { outcome: "claim-rejected", reason: "not_found" };
    if (row.pilot_id !== null) {
      return { outcome: "claim-rejected", reason: "already_claimed" };
    }
    // The same guarded update the linker uses, so a concurrent claim behaves
    // identically here: whoever writes first wins, the loser is told.
    const res = await db
      .prepare(
        "UPDATE comp_pilot SET pilot_id = ? WHERE comp_pilot_id = ? AND pilot_id IS NULL"
      )
      .bind(pilotId, row.comp_pilot_id)
      .run();
    if (!res.meta.changes) {
      return { outcome: "claim-rejected", reason: "already_claimed" };
    }
    return {
      outcome: "claimed-by-choice",
      compPilotId: row.comp_pilot_id,
      preRegName: row.registered_pilot_name,
    };
  }

  // 3. An exact id/email match claims the organiser's row by itself. Today's
  //    happy path, untouched.
  const claimed = await linkExistingRegistrations(db, pilotId, { comp_id: compId });
  if (claimed.length > 0) {
    // Take the first match — if admins pre-registered the same person
    // twice in one comp, subsequent ones will stay unlinked and still
    // show up in admin tools to resolve.
    const first = claimed[0];
    return {
      outcome: "claimed",
      compPilotId: first.comp_pilot_id,
      preRegName: first.registered_pilot_name,
    };
  }

  // 4. THE GUARANTEE. While there is anything on this roster the pilot could
  //    be, and they have not said "none of these", the INSERT below is
  //    unreachable.
  const unclaimed = await findUnclaimedRegistrations(db, compId);
  if (unclaimed.length > 0 && claim.kind !== "new") {
    return {
      outcome: "ambiguous",
      candidates: orderByLikelihood(unclaimed, pilotName).map((r) => ({
        comp_pilot_id: r.comp_pilot_id,
        registered_pilot_name: r.registered_pilot_name,
        pilot_class: r.pilot_class,
        notify_email_masked: maskEmail(r.registered_pilot_email),
      })),
    };
  }

  // 5. Nothing to be, and the comp does not accept self-registration.
  if (!mayRegister) return { outcome: "registration-closed" };

  // 6. Genuinely new.
  const res = await db
    .prepare(
      `INSERT INTO comp_pilot (comp_id, pilot_id, registered_pilot_name, pilot_class)
       VALUES (?, ?, ?, ?)`
    )
    .bind(compId, pilotId, pilotName, defaultPilotClass)
    .run();
  return {
    outcome: "registered",
    compPilotId: res.meta.last_row_id,
    declined: unclaimed.length,
  };
}

export const igcRoutes = new Hono<AuthedEnv>()
  // ── POST /api/comp/:comp_id/task/:task_id/igc ── Upload IGC
  .post(
    "/api/comp/:comp_id/task/:task_id/igc",
    requireAuth,
    sqidsMiddleware,
    async (c) => {
      const user = c.var.user;
      const compId = c.var.ids.comp_id!;
      const taskId = c.var.ids.task_id!;
      const alphabet = c.env.SQIDS_ALPHABET;

      // Verify comp exists and check close_date
      const comp = await c.env.DB.prepare(
        "SELECT comp_id, name, close_date, default_pilot_class, open_registration, test FROM comp WHERE comp_id = ?"
      )
        .bind(compId)
        .first<{
          comp_id: number;
          name: string;
          close_date: string | null;
          default_pilot_class: string;
          open_registration: number;
          test: number;
        }>();

      if (!comp) {
        return c.json({ error: "Competition not found" }, 404);
      }

      // A hidden test comp answers exactly as a missing one does — being
      // signed in is not a claim to somebody's rehearsal.
      if (await hiddenFromCaller(c.env.DB, compId, comp.test, user)) {
        return c.json({ error: "Competition not found" }, 404);
      }

      if (isCompClosed(comp.close_date)) {
        return c.json(
          { error: "Competition is closed for track submissions" },
          400
        );
      }

      // Verify task exists and belongs to comp
      const task = await c.env.DB.prepare(
        "SELECT task_id, name, submissions_closed FROM task WHERE task_id = ? AND comp_id = ?"
      )
        .bind(taskId, compId)
        .first<{ task_id: number; name: string; submissions_closed: number }>();

      if (!task) {
        return c.json({ error: "Task not found" }, 404);
      }

      // Closed for the day. Before the body read: a refusal should cost a
      // header parse, not a megabyte and a decompression.
      if (task.submissions_closed && !(await isCompAdmin(c.env.DB, compId, user))) {
        return c.json(await submissionsClosedBody(c.env.DB, compId, taskId), 403);
      }

      // WHO before WHAT. Identity is resolved ahead of the body read so an
      // unanswerable one costs a header parse rather than a megabyte and a
      // decompression — the same cheapest-rejection-first order igc-anon.ts
      // states. It also means the 409 below can be answered without the pilot
      // having uploaded anything yet.
      const parsedClaim = readSelfClaim(c.req.header(COMP_PILOT_HEADER), alphabet);
      if (parsedClaim === "invalid") {
        return c.json({ error: "That is not a registration we can look up." }, 400);
      }

      const pilotId = await ensurePilot(c.env.DB, user.id, user.name);
      const ensured = await ensureCompPilot(
        c.env.DB,
        compId,
        pilotId,
        user.name,
        comp.default_pilot_class,
        !!comp.open_registration,
        parsedClaim
      );

      if (ensured.outcome === "registration-closed") {
        // Name who can fix it: the pilot cannot add themselves, so an answer
        // without a person in it is a dead end.
        return c.json(
          {
            error: `You are not registered for ${comp.name}, and it does not accept pilots registering themselves. Ask the organiser to add you.`,
            code: "registration_closed",
            comp: { comp_id: encodeId(alphabet, compId), name: comp.name },
            organisers: await organisersOf(c.env.DB, compId),
          },
          403
        );
      }

      if (ensured.outcome === "ambiguous") {
        // The server will not guess which registration this is. This is the
        // SAFETY NET rather than the flow — the form asks before the pilot
        // ever chooses a file — so it is reachable only from a stale bundle or
        // a scripted client.
        return c.json(
          {
            error: `Which registration are you in ${comp.name}?`,
            code: "identity_ambiguous",
            comp: { comp_id: encodeId(alphabet, compId), name: comp.name },
            candidates: ensured.candidates.map((cand) => ({
              ...cand,
              comp_pilot_id: encodeId(alphabet, cand.comp_pilot_id),
            })),
            organisers: await organisersOf(c.env.DB, compId),
          },
          409
        );
      }

      if (ensured.outcome === "claim-rejected") {
        const message =
          ensured.reason === "already_claimed"
            ? "Somebody has already claimed that registration. Ask the organiser if it should be yours."
            : ensured.reason === "already_registered"
              ? `You are already registered in ${comp.name} under a different entry.`
              : "That registration is not part of this competition.";
        return c.json(
          {
            error: message,
            code: "claim_rejected",
            reason: ensured.reason,
            comp: { comp_id: encodeId(alphabet, compId), name: comp.name },
            organisers: await organisersOf(c.env.DB, compId),
          },
          409
        );
      }

      const compPilotId = ensured.compPilotId;
      // The name the track is FILED under, which is not always the account's:
      // a pilot who just claimed "Jane Smith" is Jane Smith on this roster.
      const filedForName =
        ensured.outcome === "claimed" || ensured.outcome === "claimed-by-choice"
          ? ensured.preRegName
          : user.name;

      const body = await c.req.arrayBuffer();

      if (ensured.outcome === "claimed") {
        await audit(c.env.DB, user, compId, {
          subject_type: "pilot",
          subject_id: compPilotId,
          subject_name: ensured.preRegName,
          description: `Linked pre-registered pilot "${ensured.preRegName}" to GlideComp account on first upload`,
        });
      } else if (ensured.outcome === "claimed-by-choice") {
        // Says it was the PILOT'S assertion, not a match the server made. That
        // distinction is the whole basis of the permissive model: nothing here
        // was verified, so the record has to show who claimed what.
        await audit(c.env.DB, user, compId, {
          subject_type: "pilot",
          subject_id: compPilotId,
          subject_name: ensured.preRegName,
          description: `${user.name} claimed the registration for "${ensured.preRegName}" when uploading a track`,
        });
      } else if (ensured.outcome === "registered") {
        // Open registration just put someone on the roster. Without this the
        // transparency record shows a track uploaded for a pilot it never saw
        // join — and the pilot count feeds launch validity (S7F §9.1), so this
        // is a scoring input arriving unannounced. Mirrors the wording the
        // admin registration routes use, plus how it happened.
        const declined = ensured.declined
          ? `, declining ${ensured.declined} unclaimed registration${ensured.declined === 1 ? "" : "s"} already on the roster`
          : "";
        await audit(c.env.DB, user, compId, {
          subject_type: "pilot",
          subject_id: compPilotId,
          subject_name: user.name,
          description: `Registered pilot "${user.name}" (class: ${comp.default_pilot_class}) on first upload${declined}`,
        });
      }

      const ingested = await ingestTrackSubmission(c, {
        compId,
        taskId,
        compPilotId,
        comp,
        task,
        body,
        filedForName,
        actor: user,
        uploader: { userId: user.id, name: user.name },
        submitter: { kind: "person", name: user.name },
        claimedRegistration: ensured.outcome === "claimed-by-choice",
        submitterEmail: user.email,
        describeUpload: ({ replaced, size, previously }) =>
          `${replaced ? "Replaced" : "Uploaded"} IGC for ${filedForName} (${size})${previously}`,
      });
      if (!ingested.ok) return c.json({ error: ingested.rejection.message }, 400);

      return c.json(ingested.result, ingested.status);
    }
  )

  // ── POST /api/comp/:comp_id/task/:task_id/igc/:comp_pilot_id ── Upload on behalf
  // Authorised if the caller is either (a) a comp admin or (b) a registered
  // pilot in this comp AND comp.open_igc_upload is enabled.
  .post(
    "/api/comp/:comp_id/task/:task_id/igc/:comp_pilot_id",
    requireAuth,
    sqidsMiddleware,
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const taskId = c.var.ids.task_id!;
      const compPilotId = c.var.ids.comp_pilot_id!;
      const user = c.var.user;
      const alphabet = c.env.SQIDS_ALPHABET;

      // Look up the comp once — need open_igc_upload to gate authorisation
      const comp = await c.env.DB.prepare(
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
      if (!comp) return c.json({ error: "Competition not found" }, 404);

      // As the self route: a hidden test comp is missing to everyone but its
      // admins, whichever pilot the track is being filed for.
      if (await hiddenFromCaller(c.env.DB, compId, comp.test, user)) {
        return c.json({ error: "Competition not found" }, 404);
      }

      if (isCompClosed(comp.close_date)) {
        return c.json(
          { error: "Competition is closed for track submissions" },
          400
        );
      }

      // Authorisation: admin OR registered pilot (when open_igc_upload enabled)
      const isAdmin = await isCompAdmin(c.env.DB, compId, user);
      if (!isAdmin) {
        if (!comp.open_igc_upload) {
          return c.json(
            { error: "Only admins can upload on behalf of other pilots in this competition" },
            403
          );
        }
        // Caller must be a registered pilot in this comp
        const callerPilot = await c.env.DB.prepare(
          `SELECT cp.comp_pilot_id FROM comp_pilot cp
           JOIN pilot p ON cp.pilot_id = p.pilot_id
           WHERE cp.comp_id = ? AND p.user_id = ?`
        )
          .bind(compId, user.id)
          .first();
        if (!callerPilot) {
          return c.json(
            { error: "Only registered pilots can upload on behalf of others in this competition" },
            403
          );
        }
      }

      // Verify task exists and belongs to comp
      const task = await c.env.DB.prepare(
        "SELECT task_id, name, submissions_closed FROM task WHERE task_id = ? AND comp_id = ?"
      )
        .bind(taskId, compId)
        .first<{ task_id: number; name: string; submissions_closed: number }>();

      if (!task) {
        return c.json({ error: "Task not found" }, 404);
      }

      // Closed for the day. `isAdmin` is already resolved above, so the
      // organiser bypass costs nothing extra here.
      if (task.submissions_closed && !isAdmin) {
        return c.json(await submissionsClosedBody(c.env.DB, compId, taskId), 403);
      }

      // Verify comp_pilot exists and belongs to this comp
      const cp = await c.env.DB.prepare(
        "SELECT comp_pilot_id, registered_pilot_name FROM comp_pilot WHERE comp_pilot_id = ? AND comp_id = ?"
      )
        .bind(compPilotId, compId)
        .first<{ comp_pilot_id: number; registered_pilot_name: string }>();

      if (!cp) {
        return c.json({ error: "Pilot not found in this competition" }, 404);
      }

      const targetPilotName = cp.registered_pilot_name;

      const ingested = await ingestTrackSubmission(c, {
        compId,
        taskId,
        compPilotId,
        comp,
        task,
        body: await c.req.arrayBuffer(),
        filedForName: targetPilotName,
        actor: user,
        uploader: { userId: user.id, name: user.name },
        // Tell the pilot somebody else filed for them. Until this route was
        // brought onto the shared pipeline it was the biggest silent gap in
        // the flow: a STRANGER'S anonymous replacement emailed you, but a
        // fellow registered pilot overwriting your track did not.
        submitter: { kind: "person", name: user.name },
        submitterEmail: user.email,
        describeUpload: ({ replaced, size, previously }) =>
          `${replaced ? "Replaced" : "Uploaded"} IGC for ${targetPilotName} on behalf (${size})${previously}`,
      });
      if (!ingested.ok) return c.json({ error: ingested.rejection.message }, 400);

      return c.json(ingested.result, ingested.status);
    }
  )

  // ── GET /api/comp/:comp_id/task/:task_id/igc ── List tracks
  .get(
    "/api/comp/:comp_id/task/:task_id/igc",
    optionalAuth,
    sqidsMiddleware,
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const taskId = c.var.ids.task_id!;
      const user = c.var.user;
      const alphabet = c.env.SQIDS_ALPHABET;

      // Check comp exists and handle test visibility
      const comp = await c.env.DB.prepare(
        "SELECT comp_id, test FROM comp WHERE comp_id = ?"
      )
        .bind(compId)
        .first<{ comp_id: number; test: number }>();

      if (!comp) {
        return c.json({ error: "Not found" }, 404);
      }

      if (comp.test) {
        if (!user) {
          return c.json({ error: "Not found" }, 404);
        }
        if (!(await isCompAdmin(c.env.DB, compId, user))) {
          return c.json({ error: "Not found" }, 404);
        }
      }

      // Verify task belongs to comp
      const task = await c.env.DB.prepare(
        "SELECT task_id FROM task WHERE task_id = ? AND comp_id = ?"
      )
        .bind(taskId, compId)
        .first();

      if (!task) {
        return c.json({ error: "Task not found" }, 404);
      }

      const tracks = await c.env.DB.prepare(
        `SELECT tt.task_track_id, tt.comp_pilot_id, tt.igc_filename,
                tt.uploaded_at, tt.file_size, tt.penalty_points, tt.penalty_reason,
                tt.igc_pilot_name, tt.uploaded_by_user_id, tt.uploaded_by_name,
                tt.active,
                cp.registered_pilot_name as pilot_name,
                cp.pilot_class
         FROM task_track tt
         JOIN comp_pilot cp ON tt.comp_pilot_id = cp.comp_pilot_id
         WHERE tt.task_id = ?
         ORDER BY tt.uploaded_at ASC`
      )
        .bind(taskId)
        .all<{
          task_track_id: number;
          comp_pilot_id: number;
          igc_filename: string;
          uploaded_at: string;
          file_size: number;
          penalty_points: number;
          penalty_reason: string | null;
          igc_pilot_name: string | null;
          uploaded_by_user_id: string | null;
          uploaded_by_name: string | null;
          active: number;
          pilot_name: string;
          pilot_class: string;
        }>();

      return c.json({
        tracks: tracks.results.map((t) => ({
          task_track_id: encodeId(alphabet, t.task_track_id),
          comp_pilot_id: encodeId(alphabet, t.comp_pilot_id),
          pilot_name: t.pilot_name,
          igc_pilot_name: t.igc_pilot_name,
          pilot_class: t.pilot_class,
          uploaded_at: t.uploaded_at,
          file_size: t.file_size,
          penalty_points: t.penalty_points,
          penalty_reason: t.penalty_reason,
          uploaded_by_name: t.uploaded_by_name,
          /** False when superseded by DNF/Absent/Present or a manual flight
           * (retained, not scored, restorable). */
          active: !!t.active,
          /**
           * True when an IGC was uploaded by someone other than the pilot
           * it belongs to. Computed server-side so the UI can just show
           * attribution without comparing names or checking user IDs.
           */
          uploaded_on_behalf:
            t.uploaded_by_name !== null &&
            t.uploaded_by_name !== t.pilot_name,
        })),
      });
    }
  )

  // ── GET /api/comp/:comp_id/task/:task_id/igc/:comp_pilot_id/download ── Download track
  .get(
    "/api/comp/:comp_id/task/:task_id/igc/:comp_pilot_id/download",
    optionalAuth,
    sqidsMiddleware,
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const taskId = c.var.ids.task_id!;
      const compPilotId = c.var.ids.comp_pilot_id!;
      const user = c.var.user;

      // Check comp exists and handle test visibility
      const comp = await c.env.DB.prepare(
        "SELECT comp_id, test FROM comp WHERE comp_id = ?"
      )
        .bind(compId)
        .first<{ comp_id: number; test: number }>();

      if (!comp) {
        return c.json({ error: "Not found" }, 404);
      }

      if (comp.test) {
        if (!user) {
          return c.json({ error: "Not found" }, 404);
        }
        if (!(await isCompAdmin(c.env.DB, compId, user))) {
          return c.json({ error: "Not found" }, 404);
        }
      }

      // Get track
      const track = await c.env.DB.prepare(
        `SELECT tt.igc_filename
         FROM task_track tt
         JOIN task t ON tt.task_id = t.task_id
         WHERE tt.task_id = ? AND tt.comp_pilot_id = ? AND t.comp_id = ?`
      )
        .bind(taskId, compPilotId, compId)
        .first<{ igc_filename: string }>();

      if (!track) {
        return c.json({ error: "Track not found" }, 404);
      }

      const object = await c.env.R2.get(track.igc_filename);
      if (!object) {
        return c.json({ error: "File not found in storage" }, 404);
      }

      // Return the file — R2 transparently decompresses gzip if the client
      // sends Accept-Encoding: gzip, or we can return it raw.
      return new Response(object.body, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${compPilotId}.igc"`,
          ...(object.httpMetadata?.contentEncoding
            ? { "Content-Encoding": object.httpMetadata.contentEncoding }
            : {}),
        },
      });
    }
  )

  // ── PATCH /api/comp/:comp_id/task/:task_id/igc/:comp_pilot_id ── Update penalty
  .patch(
    "/api/comp/:comp_id/task/:task_id/igc/:comp_pilot_id",
    requireAuth,
    sqidsMiddleware,
    requireCompAdmin,
    validated("json", updatePenaltySchema),
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const taskId = c.var.ids.task_id!;
      const compPilotId = c.var.ids.comp_pilot_id!;
      const body = c.req.valid("json");

      // Verify track exists and capture pilot name for audit
      const track = await c.env.DB.prepare(
        `SELECT tt.task_track_id, tt.penalty_points AS old_points, cp.registered_pilot_name
         FROM task_track tt
         JOIN task t ON tt.task_id = t.task_id
         JOIN comp_pilot cp ON tt.comp_pilot_id = cp.comp_pilot_id
         WHERE tt.task_id = ? AND tt.comp_pilot_id = ? AND t.comp_id = ?`
      )
        .bind(taskId, compPilotId, compId)
        .first<{
          task_track_id: number;
          old_points: number;
          registered_pilot_name: string;
        }>();

      if (!track) {
        return c.json({ error: "Track not found" }, 404);
      }

      await c.env.DB.prepare(
        `UPDATE task_track SET penalty_points = ?, penalty_reason = ?
         WHERE task_track_id = ?`
      )
        .bind(
          body.penalty_points,
          body.penalty_reason ?? null,
          track.task_track_id
        )
        .run();

      await bumpAndRevalidateScores(c, [taskId]);

      const reasonSuffix = body.penalty_reason ? `: ${body.penalty_reason}` : "";
      const description =
        track.old_points === 0
          ? `Set penalty for ${track.registered_pilot_name} to ${body.penalty_points} pts${reasonSuffix}`
          : `Changed penalty for ${track.registered_pilot_name} from ${track.old_points} to ${body.penalty_points} pts${reasonSuffix}`;

      await audit(c.env.DB, c.var.user, compId, {
        subject_type: "track",
        subject_id: track.task_track_id,
        subject_name: track.registered_pilot_name,
        description,
      });

      return c.json({ success: true });
    }
  )

  // ── PATCH …/igc/:comp_pilot_id/quality-override ── Scorekeeper's ruling on
  // a tracklog that an automatic data-quality check withheld from scoring.
  //
  // FAI S7A §4.4.6 (Rejection of Track Log) makes this the ORGANISER's
  // judgement, not the software's — the automatic verdict is a default, and
  // this is how a scorekeeper overrules it. Setting the override scores and
  // analyses the track normally; its findings still show on the pilot's page.
  .patch(
    "/api/comp/:comp_id/task/:task_id/igc/:comp_pilot_id/quality-override",
    requireAuth,
    sqidsMiddleware,
    requireCompAdmin,
    validated("json", trackQualityOverrideSchema),
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const taskId = c.var.ids.task_id!;
      const compPilotId = c.var.ids.comp_pilot_id!;
      const { quality_override } = c.req.valid("json");

      const track = await c.env.DB.prepare(
        `SELECT tt.task_track_id, tt.quality_override AS old_override,
                cp.registered_pilot_name
         FROM task_track tt
         JOIN task t ON tt.task_id = t.task_id
         JOIN comp_pilot cp ON tt.comp_pilot_id = cp.comp_pilot_id
         WHERE tt.task_id = ? AND tt.comp_pilot_id = ? AND t.comp_id = ?
           AND tt.active = 1`
      )
        .bind(taskId, compPilotId, compId)
        .first<{
          task_track_id: number;
          old_override: number;
          registered_pilot_name: string;
        }>();

      if (!track) {
        return c.json({ error: "Track not found" }, 404);
      }

      await c.env.DB.prepare(
        "UPDATE task_track SET quality_override = ? WHERE task_track_id = ?"
      )
        .bind(quality_override ? 1 : 0, track.task_track_id)
        .run();

      await bumpAndRevalidateScores(c, [taskId]);

      await audit(c.env.DB, c.var.user, compId, {
        subject_type: "track",
        subject_id: track.task_track_id,
        subject_name: track.registered_pilot_name,
        description: quality_override
          ? `Accepted ${track.registered_pilot_name}'s tracklog despite a failed ` +
            `data-quality check — it is scored and analysed normally (FAI S7A §4.4.6)`
          : `Withdrew the data-quality acceptance of ${track.registered_pilot_name}'s ` +
            `tracklog — it returns to being withheld from scoring`,
      });

      return c.json({ success: true, quality_override });
    }
  )

  // ── DELETE /api/comp/:comp_id/task/:task_id/igc/:comp_pilot_id ── Delete track
  .delete(
    "/api/comp/:comp_id/task/:task_id/igc/:comp_pilot_id",
    requireAuth,
    sqidsMiddleware,
    requireCompAdmin,
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const taskId = c.var.ids.task_id!;
      const compPilotId = c.var.ids.comp_pilot_id!;

      // Verify track exists and get filename for R2 cleanup; capture pilot name
      const track = await c.env.DB.prepare(
        `SELECT tt.task_track_id, tt.igc_filename, cp.registered_pilot_name
         FROM task_track tt
         JOIN task t ON tt.task_id = t.task_id
         JOIN comp_pilot cp ON tt.comp_pilot_id = cp.comp_pilot_id
         WHERE tt.task_id = ? AND tt.comp_pilot_id = ? AND t.comp_id = ?`
      )
        .bind(taskId, compPilotId, compId)
        .first<{
          task_track_id: number;
          igc_filename: string;
          registered_pilot_name: string;
        }>();

      if (!track) {
        return c.json({ error: "Track not found" }, 404);
      }

      // Delete from D1 and R2
      await Promise.all([
        c.env.DB.prepare("DELETE FROM task_track WHERE task_track_id = ?")
          .bind(track.task_track_id)
          .run(),
        c.env.R2.delete(track.igc_filename),
      ]);

      await bumpAndRevalidateScores(c, [taskId]);
      await audit(c.env.DB, c.var.user, compId, {
        subject_type: "track",
        subject_id: track.task_track_id,
        subject_name: track.registered_pilot_name,
        description: `Deleted IGC for ${track.registered_pilot_name}`,
      });

      return c.json({ success: true });
    }
  )

  // ── POST /api/comp/:comp_id/task/:task_id/igc/:comp_pilot_id/restore ──
  // Reactivate a pilot's superseded track (e.g. after they were marked DNF,
  // which deactivated it). Makes the track the active evidence again,
  // supersedes any active manual flight, and resolves the outcome to Landed.
  // Admin-only — this overrides a status an admin set.
  //
  // Deliberately NOT gated by task.submissions_closed: restoring a file the
  // task already holds is a correction, not a submission.
  .post(
    "/api/comp/:comp_id/task/:task_id/igc/:comp_pilot_id/restore",
    requireAuth,
    sqidsMiddleware,
    requireCompAdmin,
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const taskId = c.var.ids.task_id!;
      const compPilotId = c.var.ids.comp_pilot_id!;
      const user = c.var.user;

      const track = await c.env.DB.prepare(
        `SELECT tt.task_track_id, tt.active, cp.registered_pilot_name
         FROM task_track tt
         JOIN task t ON tt.task_id = t.task_id
         JOIN comp_pilot cp ON tt.comp_pilot_id = cp.comp_pilot_id
         WHERE tt.task_id = ? AND tt.comp_pilot_id = ? AND t.comp_id = ?`
      )
        .bind(taskId, compPilotId, compId)
        .first<{
          task_track_id: number;
          active: number;
          registered_pilot_name: string;
        }>();

      if (!track) {
        return c.json({ error: "Track not found" }, 404);
      }
      if (track.active) {
        return c.json({ error: "Track is already active" }, 400);
      }

      const manualSuperseded = await supersedeActiveManualFlights(
        c.env.DB,
        taskId,
        compPilotId
      );
      await c.env.DB.prepare(
        `UPDATE task_track SET active = 1 WHERE task_track_id = ?`
      )
        .bind(track.task_track_id)
        .run();
      await markLandedFromEvidence(c.env.DB, user, compId, taskId, compPilotId);

      await bumpAndRevalidateScores(c, [taskId]);
      const supersededNote = manualSuperseded
        ? " (superseded their manual flight)"
        : "";
      await audit(c.env.DB, c.var.user, compId, {
        subject_type: "track",
        subject_id: track.task_track_id,
        subject_name: track.registered_pilot_name,
        description: `Restored track for ${track.registered_pilot_name} (back to Landed)${supersededNote}`,
      });

      return c.json({ success: true });
    }
  );
