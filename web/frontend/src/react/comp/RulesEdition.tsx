/**
 * The scoring-rules edition line every GAP scores surface shows
 * (docs/2026-08-09-s7f-2026-migration-plan.md): a small "FAI S7F 2026"
 * badge linking to /scoring/gap, and — for a competition flown before that
 * edition took effect — a warning that the scores are indicative, because
 * GlideComp scores every task under the current rules rather than the
 * rules in force on the day.
 *
 * Degrades honestly: a stale cached payload written before `rules_edition`
 * was published gets plain "FAI S7F" with no edition claim.
 */
import { Alert, AlertDescription } from "@/react/rac/alert";

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

/**
 * The badge itself: "FAI S7F 2026" (or plain "FAI S7F" when the payload
 * predates the edition field), linking to the scoring documentation.
 */
export function RulesEditionBadge({
  edition,
}: {
  /** The payload's `rules_edition`, or undefined for pre-field payloads. */
  edition: "s7f-2026" | undefined;
}) {
  return (
    <a
      href="/scoring/gap"
      className="text-xs text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground"
    >
      {edition === "s7f-2026" ? "FAI S7F 2026" : "FAI S7F"}
    </a>
  );
}

/**
 * The indicative-scores notice for a historical competition: shown when the
 * task was flown before the 2026 edition took effect AND the payload was
 * scored under it. Nothing renders for current comps or pre-field payloads.
 */
export function HistoricalRulesNotice({
  edition,
  taskDate,
}: {
  edition: "s7f-2026" | undefined;
  /** The task's (or competition's earliest task's) ISO date. */
  taskDate: string | null | undefined;
}) {
  if (edition !== "s7f-2026" || !predatesS7f2026(taskDate)) return null;
  return (
    <Alert>
      <AlertDescription>
        This competition was flown before the FAI S7F 2026 scoring rules took
        effect (1 May 2026). GlideComp scores every task under the 2026
        rules, so the scores shown here are indicative and can differ from
        the officially published results.
      </AlertDescription>
    </Alert>
  );
}
