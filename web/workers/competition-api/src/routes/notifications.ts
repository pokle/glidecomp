/**
 * The app's notifications (mobile plan stage 9): a device registers its push
 * token, and an account follows the competitions it wants to hear about.
 * Sending lives in ../push.ts, called from the routes that change what a
 * follower would want to know.
 *
 * Neither is competition data — no organiser wrote it, no score reads it — so
 * these routes take no audit() call and no score bump (see migration 0038).
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AuthedEnv } from "../env";
import { hiddenFromCaller } from "../comp-visibility";
import { requireAuth } from "../middleware/auth";
import { sqidsMiddleware } from "../middleware/sqids";
import { validated } from "../validators";

// Expo push tokens look like ExponentPushToken[xxxxxxxx]; the cap only stops
// the column being used as storage.
const tokenSchema = z.string().min(10).max(200).regex(/^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$/, "not an Expo push token");

const registerSchema = z.object({ token: tokenSchema, platform: z.enum(["ios", "android"]) });
const forgetSchema = z.object({ token: tokenSchema });
const followSchema = z.object({ enabled: z.boolean() });

/** Above this an account is not following comps, it is spamming itself. */
const MAX_DEVICES_PER_USER = 10;

export const notificationRoutes = new Hono<AuthedEnv>()
  // ── PUT /api/user/push-token ── This device can be notified
  .put("/api/user/push-token", requireAuth, validated("json", registerSchema), async (c) => {
    const user = c.var.user;
    const { token, platform } = c.req.valid("json");
    const now = new Date().toISOString();
    // A token that was another account's moves to this one: the phone now
    // belongs to whoever signed in on it.
    await c.env.DB.prepare(
      `INSERT INTO push_token (token, user_id, platform, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (token) DO UPDATE SET user_id = excluded.user_id,
         platform = excluded.platform, last_seen_at = excluded.last_seen_at`
    )
      .bind(token, user.id, platform, now, now)
      .run();
    // Keep the newest few devices; the oldest are phones long since replaced.
    await c.env.DB.prepare(
      `DELETE FROM push_token WHERE user_id = ? AND token NOT IN (
         SELECT token FROM push_token WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT ?)`
    )
      .bind(user.id, user.id, MAX_DEVICES_PER_USER)
      .run();
    return c.json({ success: true });
  })

  // ── DELETE /api/user/push-token ── This device stops (signing out)
  .delete("/api/user/push-token", requireAuth, validated("json", forgetSchema), async (c) => {
    const { token } = c.req.valid("json");
    await c.env.DB.prepare("DELETE FROM push_token WHERE token = ? AND user_id = ?").bind(token, c.var.user.id).run();
    return c.json({ success: true });
  })

  // ── GET /api/comp/:comp_id/notify ── Does this account follow the comp?
  .get("/api/comp/:comp_id/notify", requireAuth, sqidsMiddleware, async (c) => {
    const compId = c.var.ids.comp_id!;
    const comp = await c.env.DB.prepare("SELECT test FROM comp WHERE comp_id = ?").bind(compId).first<{ test: number }>();
    if (!comp || (await hiddenFromCaller(c.env.DB, compId, comp.test, c.var.user))) {
      return c.json({ error: "Not found" }, 404);
    }
    const row = await c.env.DB.prepare("SELECT 1 AS on_ FROM comp_notify WHERE user_id = ? AND comp_id = ?")
      .bind(c.var.user.id, compId)
      .first();
    return c.json({ enabled: !!row });
  })

  // ── PUT /api/comp/:comp_id/notify ── Follow, or stop following, the comp
  .put("/api/comp/:comp_id/notify", requireAuth, sqidsMiddleware, validated("json", followSchema), async (c) => {
    const compId = c.var.ids.comp_id!;
    const comp = await c.env.DB.prepare("SELECT test FROM comp WHERE comp_id = ?").bind(compId).first<{ test: number }>();
    if (!comp || (await hiddenFromCaller(c.env.DB, compId, comp.test, c.var.user))) {
      return c.json({ error: "Not found" }, 404);
    }
    const { enabled } = c.req.valid("json");
    if (enabled) {
      await c.env.DB.prepare(
        "INSERT INTO comp_notify (user_id, comp_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING"
      )
        .bind(c.var.user.id, compId, new Date().toISOString())
        .run();
    } else {
      await c.env.DB.prepare("DELETE FROM comp_notify WHERE user_id = ? AND comp_id = ?").bind(c.var.user.id, compId).run();
    }
    return c.json({ enabled });
  });
