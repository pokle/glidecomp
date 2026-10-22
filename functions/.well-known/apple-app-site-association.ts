/**
 * The iOS universal-link association (mobile plan stage 9): which
 * glidecomp.com paths open the app. Built from the shared list in
 * web/client/src/app-links.ts, with the Apple Team ID from the Pages
 * project's `APPLE_TEAM_ID` variable — not a secret, but not known until the
 * developer account exists, so it is configuration rather than code.
 *
 * Served as JSON with no redirect and no extension, which is what iOS asks
 * for; a 404 until the variable is set.
 */
import { appleAppSiteAssociation } from "../../web/client/src/app-links";

interface Env {
  APPLE_TEAM_ID?: string;
}

export const onRequestGet: PagesFunction<Env> = ({ env }) => {
  const doc = appleAppSiteAssociation(env.APPLE_TEAM_ID);
  if (!doc) return new Response("Not configured", { status: 404 });
  return new Response(JSON.stringify(doc), {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" },
  });
};
