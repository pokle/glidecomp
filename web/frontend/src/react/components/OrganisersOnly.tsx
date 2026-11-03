/**
 * An organiser's page — an editor, a settings page, a form that changes the
 * competition — reached by someone who is not one of its organisers (owner
 * decision, 2026-11-03: redirect them, rather than show a page that only says
 * they cannot be there).
 *
 * - **Signed out:** to sign in, and back here afterwards. Most often it IS an
 *   organiser, opening a bookmark in a browser that is not signed in.
 * - **Signed in:** to the public page this one belongs to — the competition,
 *   the task, the waypoints list — which is what there is for them to read.
 *   A line says why they are there and not where the link pointed, so an
 *   organiser signed in with the wrong account is not left guessing.
 *
 * Replacing, never pushing: Back from where they land goes to where they came
 * from, not into this page and straight out of it again.
 */
import { useEffect, useRef } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { Loading } from "@/react/rac/progress";
import { useGoToSignIn, useUser } from "../lib/user";
import { toast } from "../lib/toast";

/** What a signed-in visitor is told, once, as they land on the public page. */
export const ORGANISERS_ONLY = "That page is for the competition’s organisers.";

export function OrganisersOnly({ to }: { to: string }) {
  const { user } = useUser();
  const location = useLocation();
  const goToSignIn = useGoToSignIn();
  const told = useRef(false);

  useEffect(() => {
    if (!user) goToSignIn(location.pathname + location.search + location.hash, { replace: true });
    else if (!told.current) {
      told.current = true;
      toast.info(ORGANISERS_ONLY);
    }
    // Once, on the way out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!user) return <Loading>Opening sign-in…</Loading>;
  return <Navigate replace to={to} />;
}
