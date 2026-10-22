/**
 * Push notifications to the app (mobile plan stage 9), through Expo's push
 * service.
 *
 * Opt-in and per competition: a message only ever goes to an account that
 * turned that competition's notifications on (`comp_notify`), on the devices
 * it registered (`push_token`). It is never a replacement for the emails —
 * the track notice is sent whatever is set here.
 *
 * Sending is a no-op unless the deployment names an endpoint
 * (`PUSH_ENDPOINT`), the same seam the email binding uses: local dev and the
 * worker tests never reach out to Expo. And it never throws — every caller
 * has already done its real work, and a failed push must not turn that into
 * an error.
 */
import type { Env } from "./env";

/** What one notification says, and the app screen a tap opens. */
export interface PushMessage {
  title: string;
  body: string;
  /** An app route — the website's path, which is also the app's. */
  url: string;
}

/** Expo's message and ticket shapes, as much of them as this uses. */
interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  data: { url: string };
  sound: "default";
}
interface ExpoTicket {
  status: "ok" | "error";
  details?: { error?: string };
}

/** Expo takes at most 100 messages a request. */
const BATCH = 100;

type Waiter = { waitUntil(promise: Promise<unknown>): void };

/**
 * The accounts that follow a competition, optionally narrowed to one (a
 * pilot's own track or penalty) — and never the account that caused it, who
 * is looking at the result on their own screen.
 */
export async function followers(
  db: D1Database,
  compId: number,
  opts: { only?: string | null; except?: string | null } = {}
): Promise<string[]> {
  if (opts.only === null) return [];
  const rows = await db
    .prepare(
      opts.only
        ? "SELECT user_id FROM comp_notify WHERE comp_id = ? AND user_id = ?"
        : "SELECT user_id FROM comp_notify WHERE comp_id = ?"
    )
    .bind(...(opts.only ? [compId, opts.only] : [compId]))
    .all<{ user_id: string }>();
  return rows.results.map((r) => r.user_id).filter((id) => id !== opts.except);
}

/** The account that holds a roster entry, or null when it is unclaimed. */
export async function pilotAccount(db: D1Database, compPilotId: number): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT p.user_id FROM comp_pilot cp JOIN pilot p ON p.pilot_id = cp.pilot_id
       WHERE cp.comp_pilot_id = ?`
    )
    .bind(compPilotId)
    .first<{ user_id: string | null }>();
  return row?.user_id ?? null;
}

/** Send one message to every device of these accounts. */
export async function pushToUsers(
  env: Pick<Env, "DB" | "PUSH_ENDPOINT" | "EXPO_ACCESS_TOKEN">,
  userIds: string[],
  message: PushMessage,
  send: typeof fetch = fetch
): Promise<void> {
  if (!env.PUSH_ENDPOINT || userIds.length === 0) return;
  try {
    const placeholders = userIds.map(() => "?").join(",");
    const tokens = await env.DB.prepare(`SELECT token FROM push_token WHERE user_id IN (${placeholders})`)
      .bind(...userIds)
      .all<{ token: string }>();
    const messages: ExpoMessage[] = tokens.results.map((t) => ({
      to: t.token,
      title: message.title,
      body: message.body,
      data: { url: message.url },
      sound: "default",
    }));
    for (let i = 0; i < messages.length; i += BATCH) {
      const batch = messages.slice(i, i + BATCH);
      const res = await send(env.PUSH_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${env.EXPO_ACCESS_TOKEN}` } : {}),
        },
        body: JSON.stringify(batch),
      });
      if (!res.ok) {
        console.error("push send failed", res.status);
        continue;
      }
      // A device that uninstalled the app answers DeviceNotRegistered: forget
      // it, so the table holds only phones that can still hear us.
      const { data } = (await res.json()) as { data?: ExpoTicket[] };
      const gone = (data ?? [])
        .map((ticket, j) => (ticket.status === "error" && ticket.details?.error === "DeviceNotRegistered" ? batch[j].to : null))
        .filter((t): t is string => t !== null);
      if (gone.length > 0) {
        await env.DB.prepare(`DELETE FROM push_token WHERE token IN (${gone.map(() => "?").join(",")})`)
          .bind(...gone)
          .run();
      }
    }
  } catch (err) {
    console.error("push failed", err);
  }
}

/** Fire-and-forget, after the response: the route's work is already done. */
export function pushLater(
  c: { env: Env; executionCtx: Waiter },
  recipients: Promise<string[]>,
  message: PushMessage
): void {
  if (!c.env.PUSH_ENDPOINT) return;
  c.executionCtx.waitUntil(recipients.then((ids) => pushToUsers(c.env, ids, message)).catch(() => {}));
}
