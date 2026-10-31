/**
 * Answer `GET /comp/<slug>-<id>/scores.pdf` — the one handler both the Pages
 * Function (functions/comp/[[path]].ts) and the Vite dev mirror
 * (vite.config.ts) call, so dev and production serve the same bytes.
 *
 * COMP ADMINS ONLY. Keeping a record is the scorer's job, and the button
 * lives in admin-only places (the scores page's Download menu, the comp
 * page's wrap-up card), so a pilot never sees a control they have no use for.
 * The URL refuses everyone else too — with a 403, not a 404, because the
 * competition is real and its scores are public on the page. A hidden `test`
 * comp is still a 404 for anyone who cannot see it, exactly as on the page.
 *
 * The data is fetched with the visitor's own cookie, so `is_admin` is the
 * API's verdict on THIS visitor, not ours.
 */
import { idFromSegment } from "../react/lib/slug";
import { ForbiddenError, loadResultsRecord, NotFoundError, type FetchFn } from "../react/loaders";
import { buildResultsRecord, resultsRecordFilename, type Fonts } from "./build";

/** Where the embedded fonts are served from (web/frontend/public/fonts/…). */
export const RESULTS_RECORD_FONT_PATHS = {
  regular: "/fonts/results-record/NotoSans-Regular.ttf",
  bold: "/fonts/results-record/NotoSans-Bold.ttf",
} as const;

/** `/comp/<slug>-<id>/scores.pdf` → the segment. */
export const RESULTS_RECORD_PATTERN = /^\/comp\/([^/]+)\/scores\.pdf$/;

export async function serveResultsRecord({
  fetch,
  segment,
  origin,
  loadFonts,
  now = new Date(),
}: {
  /** The API, carrying the visitor's cookie. */
  fetch: FetchFn;
  segment: string;
  /** Origin the document's links are absolute against. */
  origin: string;
  loadFonts: () => Promise<Fonts>;
  now?: Date;
}): Promise<Response> {
  const compId = idFromSegment(segment);
  let data: Awaited<ReturnType<typeof loadResultsRecord>>;
  try {
    data = await loadResultsRecord(fetch, compId, { requireAdmin: true });
  } catch (err) {
    if (err instanceof NotFoundError) return plain(404, "Competition not found");
    if (err instanceof ForbiddenError) {
      return plain(403, "Only this competition's admins can download its results record.");
    }
    console.error("results record error for", compId, err);
    return plain(503, "The results record could not be made right now — please try again");
  }

  let pdf: Uint8Array;
  try {
    pdf = await buildResultsRecord(data, { origin, generatedAt: now, fonts: await loadFonts() });
  } catch (err) {
    console.error("results record build error for", compId, err);
    return plain(503, "The results record could not be made right now — please try again");
  }
  // pdf-lib allocates a fresh ArrayBuffer for the file, never a shared one.
  return new Response(pdf as Uint8Array<ArrayBuffer>, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${resultsRecordFilename(data.comp, now)}"`,
      "X-Robots-Tag": "noindex",
      // Only ever an admin's, and stamped with the moment it was made.
      "Cache-Control": "private, no-store",
    },
  });
}

function plain(status: number, message: string): Response {
  return new Response(`${message}\n`, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Robots-Tag": "noindex",
      "Cache-Control": "private, no-store",
    },
  });
}
