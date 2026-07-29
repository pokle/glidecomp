/**
 * `/civl-rankings.csv` — the imported CIVL world rankings, as a CSV download.
 *
 * A verification hatch for the monthly import
 * (`web/scripts/fetch-civl-rankings.ts` → the `pilot_ranking` table). The
 * table has no UI and no other reader, so this is how you check that a month
 * landed and matches civlcomps.org. Linked from nowhere on purpose.
 *
 * Lives at the site root rather than under `/api/` because it is something a
 * person opens in a browser, not something the app calls. The work happens in
 * the competition-api worker (`routes/civl-rankings.ts`); this only forwards,
 * preserving the query string so `?slug=hang-gliding-class-1-xc` narrows the
 * dump to one list.
 */

interface Env {
  COMPETITION_API: Fetcher;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const target = new URL("/api/civl-rankings.csv", url.origin);
  target.search = url.search;
  return context.env.COMPETITION_API.fetch(
    new Request(target, { method: "GET", headers: context.request.headers }),
  );
};
