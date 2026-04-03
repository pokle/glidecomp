/**
 * Pages Function that proxies all /api/auth/* requests to the auth-api worker
 * via a Cloudflare service binding. This makes the auth API reachable on every
 * Pages deployment (production and preview) without domain-specific worker routes.
 */

interface Env {
  AUTH_API: Fetcher;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  return context.env.AUTH_API.fetch(context.request);
};
