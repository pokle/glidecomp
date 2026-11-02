/**
 * /submit — the front door for a pilot who has just landed.
 *
 * A real page, not a modal over an empty backdrop: it has a heading, a URL and
 * a title, it survives a reload and a back button, and it is a thing the site
 * header's "Submit track" tab can honestly link to (a plain anchor, so it
 * still works with JavaScript off — which the content pages require).
 *
 * `?comp=` and `?task=` prefill the first step, which makes this a URL worth
 * putting on a poster or behind a QR code at launch. It is also how the comp
 * page (`?comp=`) and the task page (`?comp=&task=`) send a pilot here, so
 * Back returns them to the page they came from. A hidden comp's id carries its
 * share key in `?comp=` (`compUrlId()`), exactly as it does in a comp URL.
 *
 * The flow itself is SubmitTrackForm.
 */
import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { SubmitTrackForm } from "../comp/SubmitTrackForm";

export function SubmitTrack() {
  const [params] = useSearchParams();
  const compId = params.get("comp") ?? undefined;
  const taskId = params.get("task") ?? undefined;

  useEffect(() => {
    document.title = "GlideComp - Submit track";
  }, []);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      {/* No standfirst: the three numbered steps below already say what the
          page wants, and explaining them first only delayed reading them. */}
      <h1 className="mb-8 text-2xl font-bold">Submit your track</h1>
      {/* Keyed on the prefill, so following another task's link while on this
          page starts a fresh form rather than carrying the first one over. */}
      <SubmitTrackForm
        key={`${compId ?? ""}/${taskId ?? ""}`}
        prefill={compId ? { compId, taskId } : undefined}
      />
    </div>
  );
}
