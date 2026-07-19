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
 * A task with no ρ renders as a hollow marker ON the zero line and reads as
 * "not applicable" — never silently skipped, or a 5-dot row over a 6-task
 * comp would misrepresent coverage.
 */

const SLOT = 14;
const PAD = 6;
const H = 26;
const MID = H / 2;
/** ρ ∈ [-1, 1] → vertical offset. Positive ρ plots above the line. */
const AMPLITUDE = MID - 4;

export function RhoSparkline({
  perTaskRho,
  taskLabels,
  metricLabel,
}: {
  perTaskRho: (number | null)[];
  taskLabels: string[];
  metricLabel: string;
}) {
  const width = PAD * 2 + SLOT * perTaskRho.length;

  const label = `${metricLabel}, ρ by task: ${perTaskRho
    .map((rho, i) => `${taskLabels[i] ?? `task ${i + 1}`} ${rho === null ? "not applicable" : rho.toFixed(2)}`)
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
        return (
          <circle
            key={i}
            cx={cx}
            cy={MID - clamped * AMPLITUDE}
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
