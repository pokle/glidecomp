import { createMiddleware } from "hono/factory";
import type { Env } from "../env";
import { decodeId } from "../sqids";

/** Path param names that contain Sqid-encoded IDs. */
const SQID_PARAMS = ["comp_id", "task_id", "comp_pilot_id"] as const;

type DecodedIds = Partial<Record<(typeof SQID_PARAMS)[number], number>>;

/**
 * Middleware that decodes Sqid path params into numeric IDs.
 * Decoded values are stored in c.var.ids (e.g. c.var.ids.comp_id).
 * Returns 400 if any Sqid param is present but invalid.
 */
export const sqidsMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: { ids: DecodedIds };
}>(async (c, next) => {
  const alphabet = c.env.SQIDS_ALPHABET;
  const ids: DecodedIds = {};

  for (const param of SQID_PARAMS) {
    const raw = c.req.param(param);
    if (!raw) continue;
    const decoded = decodeId(alphabet, raw);
    if (decoded === null) {
      return c.json({ error: `Invalid ${param}` }, 400);
    }
    ids[param] = decoded;
  }

  c.set("ids", ids);
  await next();
});
