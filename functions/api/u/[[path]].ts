/**
 * Pages Function that proxies all /api/u/* requests to the competition-api
 * worker via a Cloudflare service binding. These are public-by-link reads of
 * user-owned tracks/tasks/annotations.
 */

interface Env {
  COMPETITION_API: Fetcher;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  return context.env.COMPETITION_API.fetch(context.request);
};
