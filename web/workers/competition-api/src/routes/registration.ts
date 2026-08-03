/**
 * "Which registration am I in this competition?"
 *
 * Asked by the submit form as soon as a signed-in pilot picks a comp, so the
 * question is settled while they are still choosing a file rather than after
 * they press Submit. The upload route answers the same question for itself and
 * refuses to guess (`ensureCompPilot`); this endpoint exists so the pilot is
 * never surprised by that refusal.
 *
 * STRICTLY READ-ONLY. It never claims, never links, never inserts. A pilot who
 * opens the form, sees the question and walks away leaves nothing behind — and
 * a resolve that is retried, raced or replayed cannot change anything. The
 * only mutation is the one the upload itself performs, with the answer carried
 * in the `x-comp-pilot` header.
 *
 * POST rather than GET because the optional identifier may be an email
 * address, and a GET would put it in access logs, `Referer` and browser
 * history — the same reasoning as the anonymous submit route's headers.
 */

import { Hono } from "hono";
import type { Env, AuthUser } from "../env";
import { encodeId } from "../sqids";
import { sqidsMiddleware } from "../middleware/sqids";
import { requireAuth } from "../middleware/auth";
import {
  findCompPilotsByIdentifier,
  findUnclaimedRegistrations,
  isPilotIdentifierKind,
  orderByLikelihood,
  type PilotIdentifierKind,
} from "../pilot-linker";
import { maskEmail } from "../submission-gate";
import { RESOLVE_PER_USER, chargeBudget } from "../rate-limit";

type Variables = {
  user: AuthUser;
  ids: { comp_id?: number };
};

type HonoEnv = { Bindings: Env; Variables: Variables };

const MAX_IDENTIFIER_CHARS = 190;

interface Candidate {
  comp_pilot_id: string;
  registered_pilot_name: string;
  pilot_class: string;
  notify_email_masked: string | null;
}

export const registrationRoutes = new Hono<HonoEnv>().post(
  // Hyphen-free static segment under a comp, mounted ahead of compRoutes so it
  // beats `/api/comp/:comp_id` — same placement as lookup and search.
  "/api/comp/:comp_id/registration/resolve",
  requireAuth,
  sqidsMiddleware,
  async (c) => {
    const compId = c.var.ids.comp_id!;
    const user = c.var.user;
    const alphabet = c.env.SQIDS_ALPHABET;
    const db = c.env.DB;

    const budget = await chargeBudget(db, "resolve", user.id, RESOLVE_PER_USER);
    if (!budget.allowed) {
      return c.json(
        {
          error: "That is more lookups than we accept in a day.",
          code: "rate_limited",
          retry_after_seconds: budget.retryAfterSeconds,
        },
        429,
        { "Retry-After": String(budget.retryAfterSeconds) }
      );
    }

    let body: { identifier?: { kind?: string; value?: string } } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      // An empty body is the ordinary case — "who am I, going on my account".
    }

    const comp = await db
      .prepare("SELECT comp_id, name, open_registration FROM comp WHERE comp_id = ?")
      .bind(compId)
      .first<{ comp_id: number; name: string; open_registration: number }>();
    if (!comp) return c.json({ error: "Competition not found" }, 404);

    const mayRegister = !!comp.open_registration;

    // Already linked? Then there is nothing to ask, and the form says who they
    // are rather than offering a list.
    const pilot = await db
      .prepare("SELECT pilot_id FROM pilot WHERE user_id = ?")
      .bind(user.id)
      .first<{ pilot_id: number }>();

    if (pilot) {
      const mine = await db
        .prepare(
          `SELECT comp_pilot_id, registered_pilot_name, pilot_class
           FROM comp_pilot WHERE comp_id = ? AND pilot_id = ?`
        )
        .bind(compId, pilot.pilot_id)
        .first<{
          comp_pilot_id: number;
          registered_pilot_name: string;
          pilot_class: string;
        }>();
      if (mine) {
        return c.json({
          state: "linked",
          comp_pilot: {
            comp_pilot_id: encodeId(alphabet, mine.comp_pilot_id),
            registered_pilot_name: mine.registered_pilot_name,
            pilot_class: mine.pilot_class,
          },
        });
      }
    }

    // An identifier the pilot typed — "I'm registered under my CIVL id". Reuses
    // the anonymous route's matcher, which searches BOTH the registered
    // columns and the joined account, so it finds a registration the organiser
    // made against an id the pilot's own profile does not carry.
    const raw = body.identifier;
    if (raw?.kind || raw?.value) {
      const value = (raw.value ?? "").trim();
      if (!raw.kind || !isPilotIdentifierKind(raw.kind)) {
        return c.json(
          { error: "That is not an identifier we can look up.", code: "bad_identifier" },
          400
        );
      }
      if (value === "" || value.length > MAX_IDENTIFIER_CHARS) {
        return c.json(
          { error: "Enter the identifier you are registered with.", code: "bad_identifier" },
          400
        );
      }
      const matches = await findCompPilotsByIdentifier(
        db,
        compId,
        raw.kind as PilotIdentifierKind,
        value
      );
      // Only UNCLAIMED rows can be offered: a row somebody else's account owns
      // is not something this pilot can take (ensureCompPilot refuses it), so
      // offering it would be a button that cannot work.
      const free = matches.filter((m) => m.pilot_id === null);
      if (free.length > 0) {
        return c.json({
          state: "choose",
          matched_by: raw.kind,
          may_register: mayRegister,
          candidates: free.map<Candidate>((m) => ({
            comp_pilot_id: encodeId(alphabet, m.comp_pilot_id),
            registered_pilot_name: m.registered_pilot_name,
            pilot_class: m.pilot_class,
            notify_email_masked: maskEmail(m.notify_email),
          })),
        });
      }
      // Fall through: nothing answered to that identifier, so show the roster
      // rather than a dead end.
    }

    const unclaimed = await findUnclaimedRegistrations(db, compId);
    if (unclaimed.length === 0) {
      return c.json({ state: "new", may_register: mayRegister, candidates: [] });
    }

    return c.json({
      state: "choose",
      may_register: mayRegister,
      // Ordered most-likely-you first. Ordering ONLY — see nameAffinity: the
      // decision to ask at all was made without looking at a single name.
      candidates: orderByLikelihood(unclaimed, user.name).map<Candidate>((r) => ({
        comp_pilot_id: encodeId(alphabet, r.comp_pilot_id),
        registered_pilot_name: r.registered_pilot_name,
        pilot_class: r.pilot_class,
        notify_email_masked: maskEmail(r.registered_pilot_email),
      })),
    });
  }
);
