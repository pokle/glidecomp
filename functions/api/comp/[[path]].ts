/**
 * Pages Function that proxies all /api/comp/* requests to the competition-api
 * worker via a Cloudflare service binding.
 */

interface Env {
  COMPETITION_API: Fetcher;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  return context.env.COMPETITION_API.fetch(context.request);
};
