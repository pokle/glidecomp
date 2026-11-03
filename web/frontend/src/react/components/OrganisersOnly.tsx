/**
 * An organiser's page — an editor, a settings page, a form that changes the
 * competition — reached by someone who is not one of its organisers (owner
 * decision, 2026-11-03: redirect them, rather than show a page that only says
 * they cannot be there).
 *
 * They go to the public page this one belongs to — the competition, the task,
 * the waypoints list, the scores — which is what there is for them to read,
 * signed in or not: the waypoints editor's pages already sent every visitor
 * to the read-only list (CLAUDE.md), and a pilot following a link should not
 * be stopped at a sign-in form. A line says why they are there and not where
 * the link pointed, so an organiser signed in with the wrong account, or not
 * signed in at all, is not left guessing.
 *
 * Replacing, never pushing: Back from where they land goes to where they came
 * from, not into this page and straight out of it again.
 */
import { useEffect, useRef } from "react";
import { Navigate } from "react-router-dom";
import { useUser } from "../lib/user";
import { toast } from "../lib/toast";

/** What a signed-in visitor is told, once, as they land on the public page. */
export const ORGANISERS_ONLY = "That page is for the competition’s organisers.";
/** And a signed-out one, who may be an organiser in a browser not signed in. */
export const ORGANISERS_ONLY_SIGN_IN =
  "That page is for the competition’s organisers. Sign in if you are one.";

export function OrganisersOnly({ to }: { to: string }) {
  const { user } = useUser();
  const told = useRef(false);

  useEffect(() => {
    if (told.current) return;
    told.current = true;
    toast.info(user ? ORGANISERS_ONLY : ORGANISERS_ONLY_SIGN_IN);
    // Once, on the way out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <Navigate replace to={to} />;
}
