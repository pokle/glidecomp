/**
 * Whichever chart an explanation section or row carries. A chart kind this
 * build does not know is ignored, never a crash: the engine may add kinds
 * that an older app on someone's phone has never heard of.
 */
import type { ScoreChart } from '@glidecomp/engine';

import { DistributionStrip } from './DistributionStrip';
import { ScoreCurve } from './ScoreCurve';
import { ValiditySparkline } from './ValiditySparkline';

export function ScoreChartView({ chart }: { chart: ScoreChart }) {
  switch (chart.kind) {
    case 'curve':
      return <ScoreCurve chart={chart} />;
    case 'validity':
      return <ValiditySparkline chart={chart} />;
    case 'distribution':
      return <DistributionStrip chart={chart} />;
    default:
      return null;
  }
}
