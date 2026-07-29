/**
 * Renders whichever chart an explanation section or row carries.
 *
 * The engine emits a discriminated union so a UI that meets a chart kind it
 * does not know can ignore it rather than crash — the same forward-compatible
 * contract the field-analysis `ReportSeries` follows. A new kind added to the
 * engine must therefore fall through here silently, not throw.
 */
import type { ScoreChart } from "@glidecomp/engine";
import { ScoreCurve } from "./ScoreCurve";
import { ValiditySparkline } from "./ValiditySparkline";
import { DistributionStrip } from "./DistributionStrip";

export function ScoreChartView({ chart }: { chart: ScoreChart }) {
  switch (chart.kind) {
    case "curve":
      return <ScoreCurve chart={chart} />;
    case "validity":
      return <ValiditySparkline chart={chart} />;
    case "distribution":
      return <DistributionStrip chart={chart} />;
    default:
      return null;
  }
}
