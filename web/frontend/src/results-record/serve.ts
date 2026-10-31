/**
 * Answer `GET /comp/<slug>-<id>/scores.pdf` (the results record) and
 * `scores.zip` (its attached data on its own, zip.ts) — the one handler both
 * the Pages Function (functions/comp/[[path]].ts) and the Vite dev mirror
 * (vite.config.ts) call, so dev and production serve the same bytes.
 *
 * OPEN TO EVERYONE, like the scores page and its CSV — the files say nothing
 * the page does not. (It was admin-only at first, to keep the menu tidy; the
 * items sit inside the Download menu, so they add no clutter either way.)
 * The data is fetched with the visitor's own cookie, so a hidden `test` comp
 * is still a 404 for anyone who cannot see it, exactly as on the page.
 */
import { idFromSegment } from "../react/lib/slug";
import { loadResultsRecord, NotFoundError, type FetchFn } from "../react/loaders";
import { buildResultsRecord, resultsRecordFilename, type Fonts } from "./build";
import { buildResultsZip } from "./zip";

/** Where the embedded fonts are served from (web/frontend/public/fonts/…). */
export const RESULTS_RECORD_FONT_PATHS = {
  regular: "/fonts/results-record/NotoSans-Regular.ttf",
  bold: "/fonts/results-record/NotoSans-Bold.ttf",
} as const;

/** `/comp/<slug>-<id>/scores.pdf` or `.zip` → [, segment, format]. */
export const RESULTS_RECORD_PATTERN = /^\/comp\/([^/]+)\/scores\.(pdf|zip)$/;

export type ResultsRecordFormat = "pdf" | "zip";

export async function serveResultsRecord({
  fetch,
  segment,
  format,
  origin,
  loadFonts,
  now = new Date(),
}: {
  /** The API, carrying the visitor's cookie. */
  fetch: FetchFn;
  segment: string;
  format: ResultsRecordFormat;
  /** Origin the document's links are absolute against. */
  origin: string;
  /** Only the PDF draws text; the ZIP never asks for them. */
  loadFonts: () => Promise<Fonts>;
  now?: Date;
}): Promise<Response> {
  const compId = idFromSegment(segment);
  let data: Awaited<ReturnType<typeof loadResultsRecord>>;
  try {
    data = await loadResultsRecord(fetch, compId);
  } catch (err) {
    if (err instanceof NotFoundError) return plain(404, "Competition not found");
    console.error("results record error for", compId, err);
    return plain(503, "The results record could not be made right now — please try again");
  }

  let body: Uint8Array;
  try {
    body =
      format === "zip"
        ? buildResultsZip(data, { origin, generatedAt: now })
        : await buildResultsRecord(data, { origin, generatedAt: now, fonts: await loadFonts() });
  } catch (err) {
    console.error("results record build error for", compId, format, err);
    return plain(503, "The results record could not be made right now — please try again");
  }
  // pdf-lib and fflate allocate a fresh ArrayBuffer for the file, never a shared one.
  return new Response(body as Uint8Array<ArrayBuffer>, {
    headers: {
      "Content-Type": format === "zip" ? "application/zip" : "application/pdf",
      "Content-Disposition": `attachment; filename="${resultsRecordFilename(data.comp, now, format)}"`,
      "X-Robots-Tag": "noindex",
      // Stamped with the moment it was made, so never served from a cache.
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
