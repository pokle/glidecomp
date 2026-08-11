/**
 * /submit — the front door for a pilot who has just landed.
 *
 * A real page, not a modal over an empty backdrop: it has a heading, a URL and
 * a title, it survives a reload and a back button, and it is a thing the site
 * header's "Submit track" tab can honestly link to (a plain anchor, so it
 * still works with JavaScript off — which the content pages require).
 *
 * `?comp=` and `?task=` prefill the first step, which makes this a URL worth
 * putting on a poster or behind a QR code at launch.
 *
 * The flow itself is SubmitTrackForm, shared with the compact dialog on the
 * task page.
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
      <SubmitTrackForm prefill={compId ? { compId, taskId } : undefined} />
    </div>
  );
}
