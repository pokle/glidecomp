/**
 * The site's security headers, including the enforced Content-Security-Policy —
 * the ONE definition both delivery paths share:
 *
 * - static assets get them from `public/_headers` (the `/*` block), which
 *   Cloudflare Pages applies itself. That file cannot import anything, so it
 *   carries a literal copy, and `security-headers.test.ts` fails when the copy
 *   and this module disagree;
 * - Pages Function responses (the SSR'd `/comp*` pages) never see `_headers`,
 *   so `functions/_middleware.ts` adds these to any HTML response lacking them.
 *
 * `script-src 'self'` holds because no page carries an executable inline
 * script. Keep it that way rather than adding 'unsafe-inline':
 * - a classic script that must run before paint is a file in `public/`
 *   (theme-init.js, site-header.js), loaded with `<script src>`;
 * - Astro never inlines a bundled script (`assetsInlineLimit` in
 *   static/astro.config.mjs);
 * - data for the client is a `<script type="application/json">` block, which
 *   never executes (the SSR payload: src/ssr-data.ts);
 * - no `on*=` attributes — wire a listener (analysis page: data-close-dialog).
 * Violations are reported to functions/api/csp-report.ts. The SSR e2e suite
 * (e2e/ssr.spec.ts, "Content-Security-Policy") fails on any it sees, and
 * security-headers.test.ts fails on an inline script in the page sources.
 */

const CSP_DIRECTIVES: ReadonlyArray<readonly [string, string]> = [
  ["default-src", "'self'"],
  ["base-uri", "'self'"],
  ["object-src", "'none'"],
  ["frame-ancestors", "'none'"],
  // googleusercontent: the Google profile picture on /onboarding.
  [
    "img-src",
    "'self' data: blob: https://*.tile.openstreetmap.org https://*.tile.opentopomap.org https://server.arcgisonline.com https://api.mapbox.com https://*.googleusercontent.com",
  ],
  // Mapbox GL (per its CSP guide) and Cloudflare Web Analytics' beacon POSTs.
  [
    "connect-src",
    "'self' https://api.mapbox.com https://*.tiles.mapbox.com https://events.mapbox.com https://cloudflareinsights.com",
  ],
  // Mapbox GL runs its worker from a blob: URL.
  ["worker-src", "'self' blob:"],
  ["child-src", "'self' blob:"],
  // Cloudflare Web Analytics, which Pages injects into every page.
  ["script-src", "'self' https://static.cloudflareinsights.com"],
  ["style-src", "'self' 'unsafe-inline' https://fonts.googleapis.com"],
  // data: is the KaTeX fonts Vite inlines into the /scoring/gap CSS.
  ["font-src", "'self' data: https://fonts.gstatic.com"],
  ["report-to", "csp"],
  ["report-uri", "/api/csp-report"],
];

export const CONTENT_SECURITY_POLICY = CSP_DIRECTIVES.map(([k, v]) => `${k} ${v}`).join("; ");

/**
 * Trusted Types for the two vanilla-TS pages, `/analysis` and `/replay`
 * (security review proposal A4, 2026-10-01). Under
 * `require-trusted-types-for 'script'` the browser refuses a plain string at
 * every DOM XSS sink unless a named policy minted it; `trusted-types` lists the
 * policies a page may create (src/trusted-types.ts explains each).
 *
 * REPORT-ONLY first, as A4 proposes: the browser reports to
 * functions/api/csp-report.ts what it would have refused and blocks nothing.
 * It is a separate header from the enforced CSP above (a page may carry both),
 * and `public/_headers` applies it to those two paths only — the SPA, with
 * Tabulator and React's own internals, is not yet covered.
 * `e2e/trusted-types.spec.ts` loads both pages with this policy ENFORCED and
 * fails on any violation, so the switch to enforcing is a header rename once
 * production reports are quiet.
 */
export const TRUSTED_TYPES_POLICY_NAMES = ["default", "lit-html", "dompurify"] as const;

export const TRUSTED_TYPES_POLICY = [
  "require-trusted-types-for 'script'",
  `trusted-types ${TRUSTED_TYPES_POLICY_NAMES.join(" ")}`,
].join("; ");

export const TRUSTED_TYPES_REPORT_ONLY_POLICY = `${TRUSTED_TYPES_POLICY}; report-to csp; report-uri /api/csp-report`;

/** The `_headers` paths that carry `TRUSTED_TYPES_HEADERS`. */
export const TRUSTED_TYPES_PATHS = ["/analysis*", "/replay*"] as const;

export const TRUSTED_TYPES_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy-Report-Only": TRUSTED_TYPES_REPORT_ONLY_POLICY,
};

/** Header name → value, in the order `_headers` lists them. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
  "Reporting-Endpoints": 'csp="/api/csp-report"',
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
};
