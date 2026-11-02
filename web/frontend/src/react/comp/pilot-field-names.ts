/**
 * The `name` attributes of the pilot page's Name, Email and Team fields.
 *
 * Safari on an iPhone offered the ORGANISER's own name and email above the
 * keyboard in all three, and its list sat over the Team field's own. The
 * pilot being entered is almost never the person typing, so every suggestion
 * was wrong. `autocomplete="off"`, `autocorrect="off"` and a broken-up label
 * did not stop it. A field name with "search" in it did: Safari's AutoFill
 * leaves search fields alone. Tested on a phone, 2026-11-02 — change these
 * only with the phone in hand.
 *
 * The form's own problem keys stay "name", "email" and "team_name" (they are
 * the draft's keys); `asFieldNames` moves them onto these names, which are
 * what the kit form matches an error to.
 */
export const FIELD_NAME = {
  name: "search_pn",
  email: "search_pe",
  team_name: "search_pt",
} as const;

/** A problem list keyed by the draft's keys, keyed instead by field name. */
export function asFieldNames<T>(problems: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(problems).map(([key, value]) => [
      FIELD_NAME[key as keyof typeof FIELD_NAME] ?? key,
      value,
    ])
  );
}
