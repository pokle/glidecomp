/**
 * Per-task ρ as a diverging dot-row — one dot per task, above or below a
 * zero line.
 *
 * The comp page's substance is whether a metric HOLDS ITS SIGN across tasks
 * (a real flying signal) or swings (that day's weather). Reading that off a
 * row of signed decimals is slow; a dot-row makes it a glance. The numeric
 * per-task cells stay in the same table row — they are the accessible and
 * precise reading, this is the shape of it.
 *
 * Marker vocabulary:
 *  - filled dot: an informative ρ (cleared its task's noise floor) — these
 *    are the dots that vote on sign consistency;
 *  - hollow dot off the line: a ρ within noise for its n — positioned
 *    honestly, but not evidence of a direction;
 *  - hollow marker ON the zero line: no ρ at all — never silently skipped,
 *    or a 5-dot row over a 6-task comp would misrepresent coverage.
 */

const SLOT = 14;
const PAD = 6;
const H = 26;
const MID = H / 2;
/** ρ ∈ [-1, 1] → vertical offset. Positive ρ plots above the line. */
const AMPLITUDE = MID - 4;

export function RhoSparkline({
  perTaskRho,
  perTaskInformative,
  taskLabels,
  metricLabel,
}: {
  perTaskRho: (number | null)[];
  /** Whether each task's |ρ| cleared its noise floor; parallel to
   * perTaskRho. Omitted (older callers/data): every dot draws filled. */
  perTaskInformative?: (boolean | null)[];
  taskLabels: string[];
  metricLabel: string;
}) {
  const width = PAD * 2 + SLOT * perTaskRho.length;

  const label = `${metricLabel}, ρ by task: ${perTaskRho
    .map((rho, i) => {
      const name = taskLabels[i] ?? `task ${i + 1}`;
      if (rho === null) return `${name} not applicable`;
      const noise = perTaskInformative?.[i] === false ? " (within noise)" : "";
      return `${name} ${rho.toFixed(2)}${noise}`;
    })
    .join(", ")}`;

  return (
    <svg width={width} height={H} role="img" aria-label={label}>
      <line
        x1={PAD - 2}
        x2={width - PAD + 2}
        y1={MID}
        y2={MID}
        className="stroke-border"
        strokeWidth={1}
      />
      {perTaskRho.map((rho, i) => {
        const cx = PAD + SLOT * i + SLOT / 2;
        if (rho === null) {
          return (
            <circle
              key={i}
              cx={cx}
              cy={MID}
              r={2.5}
              className="fill-none stroke-muted-foreground"
              strokeWidth={1}
            />
          );
        }
        const clamped = Math.max(-1, Math.min(1, rho));
        const cy = MID - clamped * AMPLITUDE;
        if (perTaskInformative?.[i] === false) {
          return (
            <circle
              key={i}
              cx={cx}
              cy={cy}
              r={3}
              className="fill-none stroke-foreground/50"
              strokeWidth={1.2}
            />
          );
        }
        return (
          <circle
            key={i}
            cx={cx}
            cy={cy}
            r={3.5}
            // Same ink as the DivergingMeter bar — sign is encoded by which
            // side of the line, never by colour.
            className="fill-foreground/60"
          />
        );
      })}
    </svg>
  );
}
