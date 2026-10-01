/**
 * Read a text field out of an external file (IGC, XCTask, AirScore JSON) as
 * the text it is.
 *
 * The parsers type these values as `string`, but they come out of
 * attacker-controlled input, where a `waypoint.name` read from untrusted JSON
 * may really be a number, an object or null. This coerces rather than throws,
 * so a malformed field can never crash its caller: `null`/`undefined` become
 * the empty string, and any other non-string is stringified.
 *
 * It deliberately does NOT HTML-encode. Until 2026-10 this was
 * `sanitizeText()`, which stripped anything tag-shaped and then encoded
 * `& < > " '` at parse time. That made every name wrong for every consumer
 * that is not an HTML string — a pilot called O'Brien read `O&#39;Brien` on
 * the React pages, in the 3D replay, in the waypoint exports and on the map —
 * and encoded twice where a page also escaped on output. Text is now encoded
 * where it is OUTPUT, for that output: React and the lit-html templates on the
 * analysis page render it as text, the SSR head and emails escape it, the
 * XML and CSV exporters quote it. See docs/security-output-encoding.md.
 */
export function toText(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input == null) return '';
  return String(input);
}
