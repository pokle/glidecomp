/**
 * Splicing a server-rendered page into the app shell (app.html).
 *
 * Pure string work, in a module of its own so it can be tested: the Pages
 * Function that calls it (functions/comp/[[path]].ts) imports a built
 * artifact and only runs under `wrangler pages dev`. The client reads the
 * data block back with readSsrData() (ssr-data.ts).
 */

export interface HeadTags {
  title: string;
  description: string;
  /** Emit <meta robots noindex> — for pages with no substantive content yet
   * (a pending or empty task analysis). */
  noindex?: boolean;
  /** Extra raw tags (JSON-LD) already HTML-serialized. */
  extra: string;
}

/**
 * Splice the rendered page into the shell: per-route <head> tags, the markup
 * into #root, and the __SSR_DATA__ JSON block before the client module script.
 */
export function injectSsr(
  template: string,
  path: string,
  bodyHtml: string,
  head: HeadTags,
  ssrData: { path: string; data: unknown; user?: unknown }
): string {
  const headTags =
    (head.noindex ? `<meta name="robots" content="noindex">\n` : "") +
    `<title>${escapeHtml(head.title)}</title>\n` +
    `<meta name="description" content="${escapeAttr(head.description)}">\n` +
    `<meta property="og:title" content="${escapeAttr(head.title)}">\n` +
    `<meta property="og:description" content="${escapeAttr(head.description)}">\n` +
    head.extra;

  // Replace the shell's placeholder <title> and add the rest before </head>.
  //
  // Every insertion below is a FUNCTION, never a replacement string. In a
  // replacement string `$&`, `$'`, `` $` `` and `$$` are patterns, and what is
  // inserted here is a competition's own text: a pilot called `Jo "$" Blow`
  // renders as `$&quot;`, which put a second `<div id="root">` in the middle
  // of the page, and `$'` in the data block ended it early and spilled the
  // rest of the JSON onto the page. A function's result is inserted as it is.
  let out = template
    .replace(/<title>[\s\S]*?<\/title>/, "")
    .replace("</head>", () => `${headTags}</head>`);

  // __SSR_DATA__ must precede the client entry module (which sits after the
  // root div in app.html), so the client hydrates from the same loader data.
  // A JSON data block, not an executable script: the CSP (`script-src 'self'`,
  // public/_headers) runs no inline script, and this needs none — the client
  // reads it with readSsrData() (src/ssr-data.ts).
  // JSON.stringify drops an `undefined` value entirely, which is exactly the
  // encoding the client wants: no `user` key means "unknown, go and ask",
  // distinct from `"user":null` meaning a known signed-out visitor.
  const ssrScript = `<script type="application/json" id="__SSR_DATA__">${serialize(ssrData)}</script>`;
  out = out.replace(
    '<div id="root"></div>',
    () => `<div id="root">${bodyHtml}</div>${ssrScript}`
  );
  return out;
}

/** JSON for embedding in <script>: block `</script>` and `<!--` breakouts. */
export function serialize(obj: unknown): string {
  return JSON.stringify(obj)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}
