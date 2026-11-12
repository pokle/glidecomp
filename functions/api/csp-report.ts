/**
 * Collects Content-Security-Policy violation reports. The policy in
 * web/frontend/public/_headers names this endpoint twice: `report-to` (the
 * Reporting API — Chrome, Safari; batched `application/reports+json`) and
 * `report-uri` (the older `application/csp-report`, still what Firefox sends).
 *
 * Nothing is stored. Each violation becomes one log line, read with
 * `wrangler pages deployment tail`. Two policies report here (both in
 * web/frontend/src/security-headers.ts):
 *
 * - the site-wide CSP, which is ENFORCED: a line with `disposition: "enforce"`
 *   is something a visitor's browser REFUSED — a broken feature to fix, most
 *   likely an origin missing from the policy;
 * - Trusted Types on /analysis and /replay, which is REPORT-ONLY
 *   (`disposition: "report"`, directive `require-trusted-types-for`): a string
 *   that reached a DOM sink without a policy, and would break once Trusted
 *   Types is enforced. `sample` names the sink and the value's first 40
 *   characters (e.g. `Element innerHTML|<span>…`), which is how to find it.
 *
 * Public and unauthenticated by necessity (a browser sends these with no
 * credentials), so the body is capped and a request never gets anything back
 * but an empty 204.
 *
 * A report names the page it came from, and a hidden competition's page URL
 * carries its share key (lib/slug.ts). Every string is passed through
 * `redactShareKeys` before it is logged, so the logs never hold a working link.
 */
import { redactShareKeys } from "../../web/frontend/src/react/lib/slug";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_REPORTS = 20;

interface Violation {
  page?: unknown;
  directive?: unknown;
  blocked?: unknown;
  source?: unknown;
  line?: unknown;
  disposition?: unknown;
  sample?: unknown;
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
          sample: b.sample,
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
        sample: b["script-sample"],
      },
    ];
  }
  return [];
}

function clip(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const s = redactShareKeys(v);
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

/**
 * The body as text, or null once it passes `max` bytes. Counted as it
 * streams, so a body sent without a Content-Length (chunked) is never read
 * past the cap; a declared length over the cap is refused unread.
 */
export async function readCapped(request: Request, max: number): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= max)) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

export const onRequestPost: PagesFunction = async ({ request }) => {
  const text = await readCapped(request, MAX_BODY_BYTES);
  if (text === null) return new Response(null, { status: 204 });
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
        sample: clip(v.sample),
      })
    );
  }
  return new Response(null, { status: 204 });
};
