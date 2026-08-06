import type { EmailSendBinding } from "./track-notice-email";

export type Env = {
  DB: D1Database;
  R2: R2Bucket;
  AUTH_API: Fetcher;
  AIRSCORE_API: Fetcher;
  SQIDS_ALPHABET: string;
  glidecomp_scores_cache: KVNamespace;
  /**
   * Cloudflare Email Service, for the "your track was replaced" notice.
   * Optional: absent in local dev and in the worker tests, where sending
   * no-ops rather than needing a mail mock.
   */
  EMAIL?: EmailSendBinding;
  /** The canonical site origin, used to build links inside emails. */
  SITE_ORIGIN?: string;
};

export type AuthUser = {
  id: string;
  name: string;
  email: string;
  image: string | null;
  username: string | null;
};

/**
 * The route-parameter ids `sqidsMiddleware` decodes off the path.
 *
 * All optional because one shape covers every route: a handler reads the ids
 * its own path actually declares (`c.var.ids.comp_id!`), and narrowing the
 * type per route bought nothing except twenty near-identical declarations.
 */
export interface RouteIds {
  comp_id?: number;
  task_id?: number;
  comp_pilot_id?: number;
}

/**
 * A route's Hono environment, named by its AUTH POSTURE.
 *
 * Every route file used to declare its own `type Variables` / `type HonoEnv`
 * pair — 41 of them across 20 files, mostly identical. Collapsing them to one
 * type would have been wrong: the differences that DID exist were real, and
 * all of them were about whether `c.var.user` can be null. So there are three
 * names instead of one, and which one a file picks says what middleware it
 * runs, rather than restating a bag of fields.
 */
export type AuthedEnv = {
  Bindings: Env;
  Variables: { user: AuthUser; ids: RouteIds };
};

/** Behind `optionalAuth`: signed in and signed out are both real answers. */
export type PublicEnv = {
  Bindings: Env;
  Variables: { user: AuthUser | null; ids: RouteIds };
};

/**
 * No auth middleware at all — a cookie must not change the answer, or the
 * route's behaviour becomes two routes. `c.var.user` is not readable here.
 */
export type AnonEnv = {
  Bindings: Env;
  Variables: { ids: RouteIds };
};

/**
 * No auth and no decoded path ids — a public route that reads only its own
 * query string.
 */
export type BareEnv = { Bindings: Env };
