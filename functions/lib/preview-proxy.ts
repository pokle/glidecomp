/**
 * Forward a Pages Function request to a per-branch preview worker by public
 * URL — the preview-deploy replacement for `env.<BINDING>.fetch(request)`.
 * Method, headers (including Cookie/Origin) and body pass through unchanged;
 * only the scheme/host are rewritten. Redirects are not followed so auth
 * redirects reach the browser intact, mirroring service-binding behaviour.
 */
export function proxyToPreviewBackend(baseUrl: string, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const target = new URL(baseUrl);
  url.protocol = target.protocol;
  url.host = target.host;
  return fetch(new Request(url.toString(), request), { redirect: "manual" });
}
