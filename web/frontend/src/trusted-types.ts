/**
 * Trusted Types for the analysis page and the 3D replay (security review
 * proposal A4, 2026-10-01).
 *
 * Under `require-trusted-types-for 'script'` the browser refuses a plain
 * string at every DOM XSS sink (`innerHTML`, `insertAdjacentHTML`,
 * `DOMParser`, a Worker's or script's URL…) unless a policy minted it. Our
 * own code no longer has such a sink — it renders through lit-html
 * (src/render-html.ts), whose `lit-html` policy covers it — so the policies a
 * page needs are:
 *
 *  - `lit-html` — lit's own, for the template strings it parses.
 *  - `dompurify` — DOMPurify's own, for the DOM it builds while sanitising.
 *  - `default` — this file. The browser calls it for any string that reaches
 *    a sink WITHOUT a policy, which today means third-party code: Mapbox GL
 *    sets `innerHTML` for its attribution (style-supplied HTML), its scale
 *    bar and its popups, and starts its worker from a `blob:` URL; threebox
 *    sets tooltip `innerHTML`. HTML goes through DOMPurify; a script URL must
 *    be this origin's (or a `blob:` it minted); a script string is refused.
 *
 * The header that names these (`TRUSTED_TYPES_POLICY_NAMES` in
 * security-headers.ts) ships REPORT-ONLY first, as A4 proposes: a violation is reported to
 * /api/csp-report and nothing is blocked. The default policy still runs in
 * report-only mode, so what is reported is exactly what enforcement would
 * break — a value the default policy refused. `e2e/trusted-types.spec.ts`
 * loads both pages under the ENFORCED header and fails on any violation.
 *
 * A browser without Trusted Types (or with no TT header in force) never
 * consults the default policy, so installing it changes nothing there.
 */
import DOMPurify from 'dompurify';

/** Minimal shape of `window.trustedTypes`, which lib.dom does not type yet. */
interface TrustedTypePolicyFactoryLike {
  createPolicy(
    name: string,
    rules: {
      createHTML?: (input: string, sink?: string) => string | null;
      createScript?: (input: string, sink?: string) => string | null;
      createScriptURL?: (input: string, sink?: string) => string | null;
    }
  ): unknown;
  defaultPolicy?: unknown;
}

/** Sanitise third-party HTML: no script, no handlers, links keep `target`. */
export function sanitizeHtml(input: string): string {
  return DOMPurify.sanitize(input, {
    ADD_ATTR: ['target'],
    // Mapbox's attribution and controls are plain HTML; nothing here needs
    // SVG <use> or MathML, and forbidding styles keeps CSS out of it too.
    USE_PROFILES: { html: true },
  });
}

/**
 * A script URL may load only from this page's own origin, or be a `blob:`
 * this origin minted (Mapbox GL's worker). Anything else is refused (null).
 */
export function allowScriptUrl(input: string, origin: string): string | null {
  let url: URL;
  try {
    url = new URL(input, origin);
  } catch {
    return null;
  }
  if (url.protocol === 'blob:') {
    // `blob:https://glidecomp.com/<uuid>` — the inner URL's origin is the minter.
    try {
      return new URL(url.pathname).origin === origin ? input : null;
    } catch {
      return null;
    }
  }
  return url.origin === origin ? input : null;
}

/**
 * Install the `default` policy. Call it first thing in a page entry, before
 * anything creates a map. Idempotent; a no-op without Trusted Types.
 */
export function installDefaultTrustedTypesPolicy(): void {
  const tt = (globalThis as { trustedTypes?: TrustedTypePolicyFactoryLike }).trustedTypes;
  if (!tt || tt.defaultPolicy) return;
  const origin = globalThis.location?.origin ?? '';
  tt.createPolicy('default', {
    createHTML: (input) => sanitizeHtml(input),
    createScriptURL: (input) => allowScriptUrl(input, origin),
    createScript: () => null,
  });
}
