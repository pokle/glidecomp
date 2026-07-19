/**
 * Dispatch an engine ReportSeries to the chart that draws its kind. Unknown
 * kinds render nothing — an older UI in front of a newer engine degrades to
 * the tables, never crashes.
 */
import type { FieldAnalysisReport, ReportSeries } from "../types";
import { HorseraceLines } from "./HorseraceLines";
import { LegWaterfall } from "./LegWaterfall";

export function SeriesChart({
  series,
  report,
}: {
  series: ReportSeries;
  report: FieldAnalysisReport;
}) {
  switch (series.kind) {
    case "horserace":
      return <HorseraceLines series={series} report={report} />;
    case "waterfall":
      return <LegWaterfall series={series} report={report} />;
    default:
      return null;
  }
}
