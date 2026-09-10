/**
 * Control-char / angle-bracket rejection + NFC normalisation for name-type
 * text (pilot, team, comp, and account display names), shared between
 * competition-api's Zod validators and auth-api's plain handlers.
 *
 * SEC-22 defence-in-depth (issue #232): the value is still stored exactly as
 * typed and every sink still encodes for its own grammar — this only closes
 * a door the obviously-hostile does not get through, it does not replace
 * output encoding. See competition-api's `validators.ts` for the fuller
 * rationale and the sibling `plainText`/`proseText` variants that allow
 * angle brackets or line breaks for non-name fields.
 */

/** Unicode category Cc — C0, DEL and C1 — matched by code point. */
function isControlChar(c: number): boolean {
  return c < 0x20 || (c >= 0x7f && c <= 0x9f);
}

function hasControlChars(v: string): boolean {
  for (let i = 0; i < v.length; i++) {
    if (isControlChar(v.charCodeAt(i))) return true;
  }
  return false;
}

const ANGLE_BRACKETS = /[<>]/;

export const NAME_TEXT_ERROR = "must not contain control characters or < or >";

/** True when `v` is legal name-type text: no control chars, no angle brackets. */
export function isValidNameText(v: string): boolean {
  return !hasControlChars(v) && !ANGLE_BRACKETS.test(v);
}

/** Canonical-equivalence normalisation applied to name-type text once valid. */
export function normaliseNameText(v: string): string {
  return v.normalize("NFC");
}
