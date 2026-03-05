/**
 * Sanitize text from external sources (IGC files, XCTask JSON, AirScore API).
 *
 * Strips HTML tags and escapes entities to prevent XSS when values
 * are later inserted via innerHTML.
 */
export function sanitizeText(input: string): string {
  return input
    .replace(/<[^>]*>/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
