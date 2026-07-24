/**
 * Sitemap for the public, indexable pages.
 *
 * Two parts: a fixed list of the static content pages (home + the evergreen
 * scoring explainers, built by the Astro app) and one entry per PUBLIC comp
 * for its top-level surfaces — the hub, the scores page, and (GAP comps only)
 * the field analysis page. Deeper pages (per task, per pilot) are deliberately
 * NOT listed: they are reached by crawlers via links from the comp pages, and
 * listing every one would bloat the sitemap for little indexing benefit.
 *
 * Test comps are excluded (the anonymous list omits them). Short edge cache so
 * new comps show up within the hour without hammering the API.
 */
import {
  compPath,
  compScoresPath,
  compAnalysisPath,
} from "../web/frontend/src/react/lib/slug";

interface Env {
  COMPETITION_API: Fetcher;
}

interface CompRow {
  comp_id: string;
  name: string;
  test: boolean;
  scoring_format?: string;
  last_task_date: string | null;
  creation_date: string;
}

/** The static pages the Astro app prerenders, in canonical (no-trailing-slash)
 * form to match how the site links to them. */
const STATIC_PATHS = [
  "/",
  "/about",
  "/legal",
  "/scoring",
  "/scoring/gap",
  "/scoring/open-distance",
  "/scoring/data-cleaning",
];

export const onRequest: PagesFunction<Env> = async (context) => {
  const origin = new URL(context.request.url).origin;
  const api = (path: string) =>
    context.env.COMPETITION_API.fetch(new Request(`https://comp.internal${path}`));

  const urls: Array<{ loc: string; lastmod?: string }> = [
    ...STATIC_PATHS.map((p) => ({ loc: `${origin}${p}` })),
    { loc: `${origin}/comp` },
  ];

  try {
    const listRes = await api("/api/comp");
    if (listRes.ok) {
      const { comps } = (await listRes.json()) as { comps: CompRow[] };
      for (const comp of comps) {
        if (comp.test) continue;
        // Canonical slugged URLs (`${slug}-${id}`) — the same form the SSR
        // Function 301s to, so the sitemap never points at a redirect.
        // Day-level lastmod, consistently: last_task_date is already
        // YYYY-MM-DD, but the creation_date fallback is a full ISO timestamp —
        // slice both to a bare date so the sitemap never mixes the two forms.
        // (Google reads lastmod at date granularity anyway.)
        const lastmod = (comp.last_task_date ?? comp.creation_date)?.slice(0, 10);
        urls.push({ loc: `${origin}${compPath(comp.comp_id, comp.name)}`, lastmod });
        urls.push({ loc: `${origin}${compScoresPath(comp.comp_id, comp.name)}`, lastmod });
        // Field analysis has nothing to measure on an open-distance comp (no
        // legs, no speed section) — its page renders empty + noindex there, so
        // only GAP comps get a sitemap entry.
        if (comp.scoring_format !== "open_distance") {
          urls.push({ loc: `${origin}${compAnalysisPath(comp.comp_id, comp.name)}`, lastmod });
        }
      }
    }
  } catch {
    // Fall back to the static pages + /comp if the list is unreachable.
  }

  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls
      .map(
        (u) =>
          `  <url><loc>${escapeXml(u.loc)}</loc>${
            u.lastmod ? `<lastmod>${escapeXml(u.lastmod)}</lastmod>` : ""
          }</url>`
      )
      .join("\n") +
    `\n</urlset>\n`;

  return new Response(body, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=0, s-maxage=3600",
    },
  });
};

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
