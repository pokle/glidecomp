/**
 * /submit — the front door for a pilot who has just landed.
 *
 * A real page, not a modal over an empty backdrop: it has a heading, a URL and
 * a title, it survives a reload and a back button, and it is a thing the site
 * header's "Submit track" tab can honestly link to (a plain anchor, so it
 * still works with JavaScript off — which the content pages require). It is
 * one of the places the app starts from, so its bar has the main menu where a
 * form under another page has Cancel, and Submit where every form's commit is.
 *
 * `?comp=` and `?task=` prefill the first step, which makes this a URL worth
 * putting on a poster or behind a QR code at launch. It is also how the comp
 * page (`?comp=`) and the task page (`?comp=&task=`) send a pilot here, so
 * Back returns them to the page they came from. A hidden comp's id carries its
 * share key in `?comp=` (`compUrlId()`), exactly as it does in a comp URL.
 *
 * `?shared=1` is where Android sends a track shared to the installed app from
 * XCTrack, SeeYou or the Files app (public/sw.js, issue #800): the form opens
 * with that file already chosen, read from the service worker's cache
 * (src/share-target.ts), so a reload finds it again.
 *
 * The flow itself is SubmitTrackForm.
 */
import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { SubmitTrackForm } from "../comp/SubmitTrackForm";
import { SHARED_PARAM } from "../../share-target";

export function SubmitTrack() {
  const [params] = useSearchParams();
  const compId = params.get("comp") ?? undefined;
  const taskId = params.get("task") ?? undefined;
  const shared = params.get(SHARED_PARAM) === "1";

  useEffect(() => {
    document.title = "GlideComp - Submit track";
  }, []);

  // The form is the page: it carries the bar, because Submit is in it (#863).
  // No standfirst: the three numbered steps already say what the page wants,
  // and explaining them first only delayed reading them.
  //
  // Keyed on the prefill, so following another task's link while on this page
  // starts a fresh form rather than carrying the first one over.
  return (
    <SubmitTrackForm
      key={`${compId ?? ""}/${taskId ?? ""}`}
      prefill={compId ? { compId, taskId } : undefined}
      shared={shared}
    />
  );
}
