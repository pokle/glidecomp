/**
 * Collects Content-Security-Policy violation reports. The policy in
 * web/frontend/public/_headers names this endpoint twice: `report-to` (the
 * Reporting API — Chrome, Safari; batched `application/reports+json`) and
 * `report-uri` (the older `application/csp-report`, still what Firefox sends).
 *
 * Nothing is stored. Each violation becomes one log line, read with
 * `wrangler pages deployment tail`: while the policy is Report-Only this is how
 * we learn what enforcing it would break. Public and unauthenticated by
 * necessity (a browser sends these with no credentials), so the body is capped
 * and a request never gets anything back but an empty 204.
 */

const MAX_BODY_BYTES = 64 * 1024;
const MAX_REPORTS = 20;

interface Violation {
  page?: unknown;
  directive?: unknown;
  blocked?: unknown;
  source?: unknown;
  line?: unknown;
  disposition?: unknown;
}

/** Both report shapes, reduced to the fields worth a log line. */
function violations(body: unknown): Violation[] {
  // Reporting API: [{ type: "csp-violation", body: { documentURL, ... } }, ...]
  if (Array.isArray(body)) {
    return body
      .filter((r) => r && typeof r === "object" && r.type === "csp-violation")
      .map((r) => {
        const b = (r.body ?? {}) as Record<string, unknown>;
        return {
          page: b.documentURL,
          directive: b.effectiveDirective,
          blocked: b.blockedURL,
          source: b.sourceFile,
          line: b.lineNumber,
          disposition: b.disposition,
        };
      });
  }
  // report-uri: { "csp-report": { "document-uri", ... } }
  const r = (body as Record<string, unknown> | null)?.["csp-report"];
  if (r && typeof r === "object") {
    const b = r as Record<string, unknown>;
    return [
      {
        page: b["document-uri"],
        directive: b["effective-directive"] ?? b["violated-directive"],
        blocked: b["blocked-uri"],
        source: b["source-file"],
        line: b["line-number"],
        disposition: b.disposition,
      },
    ];
  }
  return [];
}

function clip(v: unknown): unknown {
  return typeof v === "string" && v.length > 300 ? `${v.slice(0, 300)}…` : v;
}

export const onRequestPost: PagesFunction = async ({ request }) => {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared <= MAX_BODY_BYTES) {
    const text = await request.text();
    if (text.length <= MAX_BODY_BYTES) {
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        // Not JSON: nothing to report.
      }
      for (const v of violations(body).slice(0, MAX_REPORTS)) {
        console.warn(
          "csp-violation",
          JSON.stringify({
            page: clip(v.page),
            directive: clip(v.directive),
            blocked: clip(v.blocked),
            source: clip(v.source),
            line: v.line,
            disposition: clip(v.disposition),
          })
        );
      }
    }
  }
  return new Response(null, { status: 204 });
};
