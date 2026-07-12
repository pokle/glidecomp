/**
 * See wrangler.toml: this worker exists so preview Pages Functions that
 * accidentally use a service binding (instead of the per-branch preview
 * backend URLs) fail loudly instead of touching production.
 */
export default {
  async fetch(request: Request): Promise<Response> {
    return new Response(
      JSON.stringify({
        error:
          'Preview service bindings are intentionally disconnected. Branch previews must ' +
          'reach their per-branch workers via functions/lib/preview-backends.ts (written by ' +
          'web/scripts/preview/deploy-stack.ts). This request hit a code path that still ' +
          `uses a service binding: ${new URL(request.url).pathname}`,
      }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    );
  },
};
