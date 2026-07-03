/**
 * Escape a string for safe interpolation into an HTML template literal, in both
 * text and double/single-quoted attribute contexts.
 *
 * This is the render-time XSS boundary for values that are NOT HTML-encoded at
 * their source. In particular, competition pilot names (`registered_pilot_name`)
 * are stored only length-bounded server-side and served back verbatim, so any
 * name interpolated into an `innerHTML` string must pass through here first.
 * Escaping the five characters `& < > " '` neutralises both tag injection
 * (text context) and attribute breakout (`"`/`'` closing an attribute early).
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
