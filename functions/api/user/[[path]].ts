/**
 * Pages Function that proxies all /api/user/* requests to the competition-api
 * worker via a Cloudflare service binding. Branch previews route to the
 * branch's own worker by URL instead — see functions/lib/preview-backends.ts.
 */
import { previewBackends } from "../../lib/preview-backends";
import { proxyToPreviewBackend } from "../../lib/preview-proxy";

interface Env {
  COMPETITION_API: Fetcher;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  if (previewBackends) return proxyToPreviewBackend(previewBackends.compApiUrl, context.request);
  return context.env.COMPETITION_API.fetch(context.request);
};
