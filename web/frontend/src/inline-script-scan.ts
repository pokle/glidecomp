/**
 * Finds what a `script-src 'self'` Content-Security-Policy refuses in a page's
 * HTML: an inline `<script>` the browser would EXECUTE, and an `on*=` event
 * handler attribute. A `<script src>` and a JSON data block
 * (`type="application/json"` / `"application/ld+json"`) are fine.
 *
 * Shared by security-headers.test.ts (the page sources) and the SSR e2e suite
 * (the built dist/), so both say the same thing about the same markup.
 */
export interface InlineScriptFinding {
  kind: "inline-script" | "event-handler";
  /** The start of the offending markup, for the failure message. */
  snippet: string;
}

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const DATA_TYPE = /\btype\s*=\s*["']?application\/(ld\+)?json\b/i;
const HAS_SRC = /\bsrc\s*=/i;
// ` onclick="…"` in a tag. Anchored on whitespace before a lowercase `on…=` so
// prose like "Depends on=" or a `data-on…` attribute doesn't match.
const HANDLER = /<[a-z][^>]*?\s(on[a-z]+)\s*=\s*["'{]/gi;

/** HTML comments hold examples and notes, not markup. */
function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

export function findInlineScripts(html: string): InlineScriptFinding[] {
  const src = stripComments(html);
  const findings: InlineScriptFinding[] = [];
  for (const m of src.matchAll(SCRIPT)) {
    const [, attrs, body] = m;
    if (HAS_SRC.test(attrs) || DATA_TYPE.test(attrs) || !body.trim()) continue;
    findings.push({ kind: "inline-script", snippet: m[0].slice(0, 120) });
  }
  for (const m of src.matchAll(HANDLER)) {
    findings.push({ kind: "event-handler", snippet: m[0].slice(0, 120) });
  }
  return findings;
}
