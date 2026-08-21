/**
 * A signed-in account's own pilot profile — the national IDs and personal
 * details that identify the same person across competitions, plus the flights
 * those identities have claimed.
 *
 * Split from routes/pilot.ts, which is the COMPETITION ROSTER: a comp's
 * `comp_pilot` rows, who may edit them, and the bulk import. The two share a
 * URL prefix and nothing else — different table, different authorisation,
 * different reader — and together they were the only file in the worker still
 * over a thousand lines.
 */

import { Hono } from "hono";
import type { AuthedEnv, Env } from "../env";
import { encodeId } from "../sqids";
import { requireAuth, forwardAuthHeaders } from "../middleware/auth";
import { updatePilotSchema, validated } from "../validators";
import { linkExistingRegistrations } from "../pilot-linker";
import { audit } from "../audit";

// ── GET /api/comp/pilot/flights row/response shapes ──

/** One flight-evidence row (track or manual) joined to its task and comp. */
interface FlightRow {
  task_id: number;
  comp_pilot_id: number;
  recorded_at: string;
  kind: "track" | "manual";
  task_name: string;
  task_date: string;
  pilot_class: string;
  comp_id: number;
  comp_name: string;
}

/** Rank fields json_each-extracted from a task_scores blob inside D1. */
interface RankRow {
  task_id: number;
  comp_pilot_sqid: string;
  rank: number;
  total_score: number;
  class_size: number;
}

/** One serialized flight in the response; ids are sqid-encoded. */
interface FlightEntry {
  comp_id: string;
  comp_name: string;
  task_id: string;
  task_name: string;
  task_date: string;
  pilot_class: string;
  comp_pilot_id: string;
  kind: "track" | "manual";
  recorded_at: string;
  rank: number | null;
  class_size: number | null;
  total_score: number | null;
}

// Columns selected from the `comp_pilot` table (aliased `cp` in joined
// queries). Kept in a single array so the SELECT list and the row type can
// never drift.

const PROFILE_COLUMNS = [
  "name",
  "civl_id",
  "safa_id",
  "ushpa_id",
  "bhpa_id",
  "dhv_id",
  "ffvl_id",
  "fai_id",
  "phone",
  "glider",
  "emergency_contact_name",
  "emergency_contact_phone",
] as const;

type ProfileRow = {
  [K in (typeof PROFILE_COLUMNS)[number]]: string | null;
};

function serializeProfile(row: ProfileRow | null, fallbackName: string) {
  if (!row) {
    return {
      name: fallbackName,
      civl_id: null,
      safa_id: null,
      ushpa_id: null,
      bhpa_id: null,
      dhv_id: null,
      ffvl_id: null,
      fai_id: null,
      phone: null,
      glider: null,
      emergency_contact_name: null,
      emergency_contact_phone: null,
    };
  }
  return {
    name: row.name,
    civl_id: row.civl_id ?? null,
    safa_id: row.safa_id ?? null,
    ushpa_id: row.ushpa_id ?? null,
    bhpa_id: row.bhpa_id ?? null,
    dhv_id: row.dhv_id ?? null,
    ffvl_id: row.ffvl_id ?? null,
    fai_id: row.fai_id ?? null,
    phone: row.phone ?? null,
    glider: row.glider ?? null,
    emergency_contact_name: row.emergency_contact_name ?? null,
    emergency_contact_phone: row.emergency_contact_phone ?? null,
  };
}

// ── The account's display name ──

/** Attempts at the account-name write before it is reported as a failure. */
const SET_NAME_ATTEMPTS = 3;
const SET_NAME_RETRY_DELAY_MS = 50;

/**
 * Push a renamed pilot profile through to the ACCOUNT's display name.
 *
 * There are two display names in play and they had only one writer between
 * them (issue #539): `pilot.name` is the profile, written here; `"user".name`
 * is the account, which /api/auth/me answers and which the account menu, the
 * static Astro chrome and the audit log's `actor_name` all read. Only sign-up
 * and onboarding ever wrote the second one, so a Settings rename moved the
 * profile and left the account holding the sign-up name — an organiser who
 * corrected their name still signed every later audit entry with the old one,
 * on a competition's public transparency record.
 *
 * Doing it HERE rather than asking the browser for a second request is what
 * makes it hold: `PATCH /api/comp/pilot` is the only writer of `pilot.name`,
 * so a future caller cannot forget the other half the way Settings did.
 *
 * The caller's own credential is forwarded and auth-api resolves the session
 * itself, so this renames the caller's account and no one else's.
 *
 * Throws once its retries are exhausted; a 4xx is a real answer and is
 * returned rather than retried.
 */
async function setAccountName(
  env: Env,
  headers: Headers,
  name: string
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const forward = forwardAuthHeaders(headers);
  forward.set("Content-Type", "application/json");

  let lastErr: unknown;
  for (let attempt = 0; attempt < SET_NAME_ATTEMPTS; attempt++) {
    try {
      const res = await env.AUTH_API.fetch(
        new Request("https://auth/api/auth/set-name", {
          method: "POST",
          headers: forward,
          body: JSON.stringify({ name }),
        })
      );
      // 5xx: auth-api is up but couldn't write. Retryable — and the UPDATE it
      // performs is idempotent, so a retry can only land the same row twice.
      if (res.status >= 500) {
        throw new Error(`auth-api /set-name responded ${res.status}`);
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        return {
          ok: false,
          status: res.status,
          error: body.error ?? "Could not update your account name",
        };
      }
      return { ok: true };
    } catch (err) {
      lastErr = err;
      if (attempt < SET_NAME_ATTEMPTS - 1) {
        await new Promise((r) =>
          setTimeout(r, SET_NAME_RETRY_DELAY_MS * (attempt + 1))
        );
      }
    }
  }
  throw lastErr;
}

export const pilotProfileRoutes = new Hono<AuthedEnv>()
  // ── GET /api/comp/pilot ── Current user's pilot profile
  .get("/api/comp/pilot", requireAuth, async (c) => {
    const user = c.var.user;

    const pilot = await c.env.DB.prepare(
      `SELECT ${PROFILE_COLUMNS.join(", ")} FROM pilot WHERE user_id = ?`
    )
      .bind(user.id)
      .first<ProfileRow>();

    return c.json(serializeProfile(pilot, user.name));
  })

  // ── GET /api/comp/pilot/flights ── Current user's competition flights
  //
  // Every flight record (track or manual flight) linked to the caller's
  // pilot across all public comps, newest task first, each with the comp /
  // task names for links and the pilot's last-computed rank. These flights
  // belong to the competition, not the user's personal library — there is
  // deliberately no delete here (removal is the comp admin's igc/manual
  // routes).
  //
  // Kept cheap by construction: one unique-index pilot lookup, then ONE
  // statement over the new by-pilot indexes (migration 0020) that only ever
  // touches this pilot's rows, then one json_each() pass that extracts just
  // {rank, score} from the materialized task_scores blobs inside D1 — the
  // blobs (full per-task score payloads) never leave the database and are
  // never parsed in the worker.
  .get("/api/comp/pilot/flights", requireAuth, async (c) => {
    const user = c.var.user;
    const alphabet = c.env.SQIDS_ALPHABET;

    const pilotRow = await c.env.DB.prepare(
      "SELECT pilot_id FROM pilot WHERE user_id = ?"
    )
      .bind(user.id)
      .first<{ pilot_id: number }>();
    if (!pilotRow) return c.json({ flights: [] as FlightEntry[] });

    // Test (hidden) comps are excluded: their pages 404 for non-admin
    // visitors, so a link here would be a dead end.
    const flightArm = (table: string, kind: string, timeCol: string) =>
      `SELECT f.task_id, f.comp_pilot_id, f.${timeCol} AS recorded_at,
              '${kind}' AS kind, t.name AS task_name, t.task_date,
              cp.pilot_class, c.comp_id, c.name AS comp_name
       FROM comp_pilot cp
       JOIN ${table} f ON f.comp_pilot_id = cp.comp_pilot_id AND f.active = 1
       JOIN task t ON t.task_id = f.task_id
       JOIN comp c ON c.comp_id = cp.comp_id
       WHERE cp.pilot_id = ?1 AND c.test = 0`;
    const flights = (
      await c.env.DB.prepare(
        `${flightArm("task_track", "track", "uploaded_at")}
         UNION ALL
         ${flightArm("task_manual_flight", "manual", "set_at")}
         ORDER BY task_date DESC, recorded_at DESC
         LIMIT 500`
      )
        .bind(pilotRow.pilot_id)
        .all<FlightRow>()
    ).results;

    // Ranks: the score blobs store comp_pilot_id sqid-encoded, so encode
    // ours and let SQLite's json_each pull out only the matching entries.
    // Placeholder rows (bumped before first compute) hold '' — not JSON —
    // and must be skipped or json_each errors. Chunked so each statement
    // stays under D1's bound-parameter cap.
    const rankByFlight = new Map<string, RankRow>();
    const CHUNK = 40;
    for (let i = 0; i < flights.length; i += CHUNK) {
      const chunk = flights.slice(i, i + CHUNK);
      const taskIds = [...new Set(chunk.map((f) => f.task_id))];
      const pilotSqids = [
        ...new Set(chunk.map((f) => encodeId(alphabet, f.comp_pilot_id))),
      ];
      const ranks = await c.env.DB.prepare(
        `SELECT ts.task_id,
                json_extract(pj.value, '$.comp_pilot_id') AS comp_pilot_sqid,
                json_extract(pj.value, '$.rank') AS rank,
                json_extract(pj.value, '$.total_score') AS total_score,
                json_array_length(cls.value, '$.pilots') AS class_size
         FROM task_scores ts,
              json_each(ts.response_json, '$.classes') cls,
              json_each(cls.value, '$.pilots') pj
         WHERE ts.task_id IN (${taskIds.map(() => "?").join(", ")})
           AND ts.response_json != ''
           AND json_extract(pj.value, '$.comp_pilot_id')
                 IN (${pilotSqids.map(() => "?").join(", ")})`
      )
        .bind(...taskIds, ...pilotSqids)
        .all<RankRow>();
      for (const r of ranks.results) {
        rankByFlight.set(`${r.task_id}:${r.comp_pilot_sqid}`, r);
      }
    }

    const entries: FlightEntry[] = flights.map((f) => {
      const sqid = encodeId(alphabet, f.comp_pilot_id);
      const score = rankByFlight.get(`${f.task_id}:${sqid}`) ?? null;
      return {
        comp_id: encodeId(alphabet, f.comp_id),
        comp_name: f.comp_name,
        task_id: encodeId(alphabet, f.task_id),
        task_name: f.task_name,
        task_date: f.task_date,
        pilot_class: f.pilot_class,
        comp_pilot_id: sqid,
        kind: f.kind,
        recorded_at: f.recorded_at,
        rank: score?.rank ?? null,
        class_size: score?.class_size ?? null,
        total_score: score?.total_score ?? null,
      };
    });

    return c.json({ flights: entries });
  })

  // ── PATCH /api/comp/pilot ── Update current user's pilot profile
  .patch(
    "/api/comp/pilot",
    requireAuth,
    validated("json", updatePilotSchema),
    async (c) => {
      const user = c.var.user;
      const body = c.req.valid("json");

      // Trimmed once, and the SAME string goes to both rows — writing " Bob "
      // to the pilot and "Bob" to the account would be this very bug in
      // miniature.
      const newName = body.name === undefined ? undefined : body.name.trim();
      if (newName !== undefined) {
        // A name that is only whitespace passes `min(1)` and would clear the
        // account's, putting it back through the onboarding gate — the one
        // constraint issue #539 names for any fix.
        if (newName === "") {
          return c.json({ error: "Display name is required" }, 400);
        }
        // The account's copy goes FIRST, and only when the two actually
        // differ. First, because it is the hop that can fail on its own:
        // writing it before the local rows means a failure leaves nothing
        // half-written, so the retry the user is told to make starts from a
        // clean slate. Only-when-different, because Settings resubmits every
        // field on every save — a phone-number edit must not be able to fail
        // on an auth-api blip — and because comparing against the account name
        // we were just handed also quietly repairs an account that drifted
        // apart before this route kept the two in step.
        if (newName !== user.name) {
          let synced;
          try {
            synced = await setAccountName(c.env, c.req.raw.headers, newName);
          } catch (err) {
            console.error("[competition-api] auth-api set-name unreachable", err);
            return c.json(
              { error: "Could not save your name right now. Please try again." },
              503
            );
          }
          if (!synced.ok) {
            // auth-api gave a real answer and refused. It validates the same
            // 1-128 characters this route does, so in practice this is the
            // session having gone away between requireAuth and now.
            return c.json({ error: synced.error }, synced.status === 401 ? 401 : 400);
          }
        }
      }

      const existing = await c.env.DB.prepare(
        "SELECT pilot_id FROM pilot WHERE user_id = ?"
      )
        .bind(user.id)
        .first<{ pilot_id: number }>();

      if (!existing) {
        await c.env.DB.prepare(
          "INSERT INTO pilot (user_id, name) VALUES (?, ?)"
        )
          .bind(user.id, user.name)
          .run();
      }

      const updates: string[] = [];
      const values: unknown[] = [];

      for (const col of PROFILE_COLUMNS) {
        if (body[col as keyof typeof body] !== undefined) {
          updates.push(`${col} = ?`);
          values.push(
            col === "name" ? newName! : body[col as keyof typeof body] ?? null
          );
        }
      }

      if (updates.length > 0) {
        values.push(user.id);
        await c.env.DB.prepare(
          `UPDATE pilot SET ${updates.join(", ")} WHERE user_id = ?`
        )
          .bind(...values)
          .run();
      }

      // Signup-linking (Iteration 8g): once the user's identity fields are
      // up to date, scan every competition — closed ones included — for
      // admin-pre-registered comp_pilot rows matching them and claim any
      // hits. This is the mechanism that turns a pre-registration into a
      // real linked registration as soon as the user fills in (e.g.) their
      // CIVL ID, and it is how a pilot claims their flights in historical
      // comps for the My Flights page.
      const pilotIdRow = await c.env.DB.prepare(
        "SELECT pilot_id FROM pilot WHERE user_id = ?"
      )
        .bind(user.id)
        .first<{ pilot_id: number }>();
      if (pilotIdRow) {
        const linked = await linkExistingRegistrations(
          c.env.DB,
          pilotIdRow.pilot_id,
          "all-comps"
        );
        for (const link of linked) {
          await audit(c.env.DB, c.var.user, link.comp_id, {
            subject_type: "pilot",
            subject_id: link.comp_pilot_id,
            subject_name: link.registered_pilot_name,
            description: `Linked pre-registered pilot "${link.registered_pilot_name}" to GlideComp account (matched by ${link.matched_by})`,
          });
        }
      }

      const pilot = await c.env.DB.prepare(
        `SELECT ${PROFILE_COLUMNS.join(", ")} FROM pilot WHERE user_id = ?`
      )
        .bind(user.id)
        .first<ProfileRow>();

      return c.json(serializeProfile(pilot, user.name));
    }
  )
;
