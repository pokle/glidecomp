/**
 * Which edition of the FAI S7F scored a task, and whether the task predates
 * it (docs/2026-08-09-s7f-2026-migration-plan.md), for the RulesEdition
 * badge and notice.
 */

/**
 * The 2026 edition's effective date (1 May 2026). A task flown before this
 * was flown under earlier rules, so its GlideComp scores are indicative.
 */
export const S7F_2026_EFFECTIVE = "2026-05-01";

/** Is the given ISO date (YYYY-MM-DD…) before the 2026 edition took effect? */
export function predatesS7f2026(isoDate: string | null | undefined): boolean {
  if (!isoDate) return false;
  return isoDate.slice(0, 10) < S7F_2026_EFFECTIVE;
}

/** "FAI S7F 2026", or plain "FAI S7F" for a payload cached before the
 *  edition was published — never a guessed edition. */
export function rulesEditionLabel(edition: "s7f-2026" | undefined): string {
  return edition === "s7f-2026" ? "FAI S7F 2026" : "FAI S7F";
}
