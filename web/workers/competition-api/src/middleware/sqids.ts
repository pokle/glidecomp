import { createMiddleware } from "hono/factory";
import type { Env, RouteIds } from "../env";
import { decodeId } from "../sqids";
import { splitCompRef } from "../share-key";

/** Path param names that contain Sqid-encoded IDs. */
const SQID_PARAMS = ["comp_id", "task_id", "comp_pilot_id"] as const;

/**
 * Middleware that decodes Sqid path params into numeric IDs.
 * Decoded values are stored in c.var.ids (e.g. c.var.ids.comp_id).
 * Returns 400 if any Sqid param is present but invalid.
 *
 * `comp_id` may carry a hidden competition's share key after its sqid
 * (`vzuq_7hq2m9xk4rwd`, see share-key.ts). The key lands in
 * `c.var.ids.comp_key`; only the read routes' visibility rule
 * (`hiddenFromViewer`) ever looks at it.
 *
 * A response to a request that carried a key is never stored by a shared
 * cache or indexed, whatever the route itself said: it is a hidden comp's
 * page, readable only by whoever holds the link, and the key must not end up
 * in a cache keyed by URL or in a search engine. One rule here rather than in
 * each route's own Cache-Control logic, so a new read route inherits it.
 */
export const sqidsMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: { ids: RouteIds };
}>(async (c, next) => {
  const alphabet = c.env.SQIDS_ALPHABET;
  const ids: RouteIds = {};

  for (const param of SQID_PARAMS) {
    let raw = c.req.param(param);
    if (!raw) continue;
    if (param === "comp_id") {
      const ref = splitCompRef(raw);
      if (ref === null) return c.json({ error: `Invalid ${param}` }, 400);
      raw = ref.sqid;
      if (ref.key) ids.comp_key = ref.key;
    }
    const decoded = decodeId(alphabet, raw);
    if (decoded === null) {
      return c.json({ error: `Invalid ${param}` }, 400);
    }
    ids[param] = decoded;
  }

  c.set("ids", ids);
  await next();

  if (ids.comp_key) {
    // Copy first: a body streamed straight from R2 can arrive with immutable
    // headers.
    c.res = new Response(c.res.body, c.res);
    c.res.headers.set("Cache-Control", "private, no-store");
    c.res.headers.set("X-Robots-Tag", "noindex");
  }
});
