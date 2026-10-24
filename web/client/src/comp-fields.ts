/**
 * The competition and task form fields' shared rules, so the website's
 * dialogs and the app's organiser screens take the same input the same way.
 */

/**
 * Ready-made class sets offered as one-tap presets under the Pilot Classes
 * field, per wing. `open` (one ranking) leads both as the simple-club default;
 * the wing-specific variants follow:
 * - HG: `open, sport` (topless vs the kingposted Sport Class) and
 *   `open, sport, floater` (adding a lower-performance floater tier).
 * - PG: `open, sport` (open/CCC wings vs the ≤EN-C sport class) and
 *   `open, serial` (competition wings vs serial-certified gliders).
 */
export const PILOT_CLASS_EXAMPLES: Record<"hg" | "pg", string[]> = {
  hg: ["open", "open, sport", "open, sport, floater"],
  pg: ["open", "open, sport", "open, serial"],
};

/** "Open, Sport" → ["open", "sport"]; nothing at all → ["open"]. */
export function parsePilotClasses(text: string): string[] {
  const classes = text
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return classes.length > 0 ? [...new Set(classes)] : ["open"];
}

export const WING_CHOICES: { value: "hg" | "pg"; label: string }[] = [
  { value: "hg", label: "Hang Gliding" },
  { value: "pg", label: "Paragliding" },
];
