/**
 * Sanitize text from external sources (IGC files, XCTask JSON, AirScore API).
 *
 * Strips HTML tags and escapes entities to prevent XSS when values
 * are later inserted via innerHTML.
 *
 * Defensive: the IGC/XCTask/AirScore parsers feed this attacker-controlled
 * values that are only *typed* as strings (e.g. a `waypoint.name` read out of
 * untrusted JSON could actually be a number, object, or null). Coerce rather
 * than throw so the XSS boundary can never crash its caller — `null`/`undefined`
 * collapse to the empty string, other non-strings are stringified before
 * escaping.
 */
export function sanitizeText(input: string): string {
  if (typeof input !== 'string') {
    if (input == null) return '';
    input = String(input);
  }
  return input
    .replace(/<[^>]*>/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
