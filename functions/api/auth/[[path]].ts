/**
 * Pages Function that proxies all /api/auth/* requests to the auth-api worker
 * via a Cloudflare service binding. This makes the auth API reachable on every
 * Pages deployment (production and preview) without domain-specific worker routes.
 *
 * Branch previews carry a generated preview-backends module pointing at the
 * branch's own auth worker; there the proxy goes by public URL instead (the
 * Preview environment's service bindings are deliberately a dead end — see
 * functions/lib/preview-backends.ts).
 */
import { previewBackends } from "../../lib/preview-backends";
import { proxyToPreviewBackend } from "../../lib/preview-proxy";

interface Env {
  AUTH_API: Fetcher;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  if (previewBackends) return proxyToPreviewBackend(previewBackends.authApiUrl, context.request);
  return context.env.AUTH_API.fetch(context.request);
};
