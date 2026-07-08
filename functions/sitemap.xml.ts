/**
 * Dynamic sitemap for the public competition pages. Fetches the comp list over
 * the COMPETITION_API service binding, then each comp's detail (tasks) and
 * scores (per-pilot narrative pages), and emits a <urlset>. Test comps are not
 * included (the anonymous list omits them). Short edge cache so new comps and
 * tasks show up within the hour without hammering the API.
 */
interface Env {
  COMPETITION_API: Fetcher;
}

interface CompRow {
  comp_id: string;
  test: boolean;
  last_task_date: string | null;
  creation_date: string;
}
interface TaskRow {
  task_id: string;
  task_date: string;
}
interface StandingPilot {
  comp_pilot_id: string;
  tasks: Array<{ task_id: string }>;
}
interface ClassStanding {
  pilots: StandingPilot[];
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const origin = new URL(context.request.url).origin;
  const api = (path: string) =>
    context.env.COMPETITION_API.fetch(new Request(`https://comp.internal${path}`));

  const urls: Array<{ loc: string; lastmod?: string }> = [{ loc: `${origin}/comp` }];

  try {
    const listRes = await api("/api/comp");
    if (listRes.ok) {
      const { comps } = (await listRes.json()) as { comps: CompRow[] };
      for (const comp of comps) {
        if (comp.test) continue;
        const base = `${origin}/comp/${comp.comp_id}`;
        urls.push({ loc: base, lastmod: comp.last_task_date ?? comp.creation_date ?? undefined });
        await appendCompUrls(api, comp.comp_id, base, urls).catch(() => {
          // One comp's detail failing must not sink the whole sitemap.
        });
      }
    }
  } catch {
    // Fall back to just /comp if the list is unreachable.
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

async function appendCompUrls(
  api: (path: string) => Promise<Response>,
  compId: string,
  base: string,
  urls: Array<{ loc: string; lastmod?: string }>
): Promise<void> {
  const [detailRes, scoresRes] = await Promise.all([
    api(`/api/comp/${compId}`),
    api(`/api/comp/${compId}/scores`),
  ]);

  const taskDate = new Map<string, string>();
  if (detailRes.ok) {
    const detail = (await detailRes.json()) as { tasks?: TaskRow[] };
    for (const t of detail.tasks ?? []) {
      taskDate.set(t.task_id, t.task_date);
      urls.push({ loc: `${base}/task/${t.task_id}`, lastmod: t.task_date });
    }
  }

  if (scoresRes.ok) {
    const scores = (await scoresRes.json()) as { standings?: ClassStanding[] };
    const seen = new Set<string>();
    for (const cls of scores.standings ?? []) {
      for (const pilot of cls.pilots) {
        for (const task of pilot.tasks) {
          const loc = `${base}/task/${task.task_id}/pilot/${pilot.comp_pilot_id}`;
          if (seen.has(loc)) continue;
          seen.add(loc);
          urls.push({ loc, lastmod: taskDate.get(task.task_id) });
        }
      }
    }
  }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
