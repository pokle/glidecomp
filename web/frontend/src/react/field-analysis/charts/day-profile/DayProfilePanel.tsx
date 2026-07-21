/**
 * The day at a glance: the day family's charting series composed onto ONE
 * shared time axis — wind by hour on top, the climb quantile fan (with the
 * day-timing overlays) in the middle, the per-leg wind Gantt at the bottom.
 * A vertical scan through the stack reads "at 2pm: wind 18 km/h NW, climbs
 * at their best, most of the field on leg 3" — which no single chart or
 * table can say.
 *
 * The series come from THREE different metrics (day.wind,
 * day.climb_by_hour, day.launch_timing); this panel is why SeriesChart
 * deliberately doesn't render them per-metric. Each chart is a labelled
 * `role="img"`; the metrics' tables below the panel remain the exact,
 * screen-reader-navigable reading, and one shared readout line voices
 * whatever the pointer is over.
 */
import { useMemo, useState } from "react";
import type {
  ClimbHourlySeries,
  DayTimingSeries,
  MetricReport,
  WindHourlySeries,
  WindLegsSeries,
} from "../../types";
import { zoneAbbrev } from "@/react/lib/time";
import { buildTimeAxis } from "./time-axis";
import { PLOT_LEFT, PLOT_RIGHT } from "./shared";
import { WindHourlyChart } from "./WindHourlyChart";
import { ClimbHourlyChart } from "./ClimbHourlyChart";
import { WindLegsGantt } from "./WindLegsGantt";

const HOUR_MS = 3_600_000;

/** Every instant a set of day-profile series mentions, as epoch ms. */
function collectInstants(
  wind: WindHourlySeries | null,
  climb: ClimbHourlySeries | null,
  legs: WindLegsSeries | null,
  timing: DayTimingSeries | null
): number[] {
  const out: number[] = [];
  const push = (iso: string | null | undefined) => {
    if (!iso) return;
    const t = new Date(iso).getTime();
    if (Number.isFinite(t)) out.push(t);
  };
  for (const h of wind?.hours ?? []) {
    push(h.t);
    out.push(new Date(h.t).getTime() + HOUR_MS);
  }
  for (const h of climb?.hours ?? []) {
    push(h.t);
    out.push(new Date(h.t).getTime() + HOUR_MS);
  }
  for (const l of legs?.legs ?? []) {
    push(l.from);
    push(l.to);
  }
  if (timing) {
    timing.takeoffs.forEach(push);
    timing.startGates.forEach(push);
    push(timing.launchOpen);
    push(timing.deadline);
    push(timing.bestHour?.from);
    push(timing.bestHour?.to);
  }
  return out.filter((t) => Number.isFinite(t));
}

export function DayProfilePanel({
  metrics,
  compTimezone,
}: {
  metrics: MetricReport[];
  /** Competition IANA zone; the axis ticks in it (viewer-local when null). */
  compTimezone: string | null;
}) {
  const timeZone = compTimezone ?? undefined;
  const [readout, setReadout] = useState<string | null>(null);

  const { wind, climb, legs, timing } = useMemo(() => {
    const all = metrics.flatMap((m) => m.extraSeries ?? []);
    return {
      wind: (all.find((s) => s.kind === "wind-hourly") ?? null) as WindHourlySeries | null,
      climb: (all.find((s) => s.kind === "climb-hourly") ?? null) as ClimbHourlySeries | null,
      legs: (all.find((s) => s.kind === "wind-legs") ?? null) as WindLegsSeries | null,
      timing: (all.find((s) => s.kind === "day-timing") ?? null) as DayTimingSeries | null,
    };
  }, [metrics]);

  const axis = useMemo(
    () => buildTimeAxis(collectInstants(wind, climb, legs, timing), timeZone, [PLOT_LEFT, PLOT_RIGHT]),
    [wind, climb, legs, timing, timeZone]
  );

  const showWind = wind !== null && wind.hours.length > 0;
  const showClimb = climb !== null && climb.hours.length > 0;
  const showLegs = legs !== null && legs.legs.some((l) => l.n > 0);
  if (!axis || (!showWind && !showClimb && !showLegs)) return null;

  const zone = zoneAbbrev(new Date(axis.domainStart), timeZone);

  // The ⓘ text of every metric whose series is actually drawn, inline under
  // the heading — the panel composes several metrics, so each line carries
  // its metric's name. Reads with the charts on screen and in print alike.
  const shownKinds = new Set<string>([
    ...(showWind ? ["wind-hourly"] : []),
    ...(showClimb ? ["climb-hourly", "day-timing"] : []),
    ...(showLegs ? ["wind-legs"] : []),
  ]);
  const contributors = metrics.filter((m) =>
    (m.extraSeries ?? []).some((s) => shownKinds.has(s.kind))
  );

  return (
    <figure className="space-y-1">
      <figcaption className="text-sm font-medium">The day at a glance</figcaption>
      {contributors.length > 0 ? (
        <div className="space-y-0.5 pb-1">
          {contributors.map((m) => (
            <p key={m.id} className="text-xs text-muted-foreground">
              <span className="font-medium">{m.label}.</span> {m.explanation}
            </p>
          ))}
        </div>
      ) : null}
      {showWind ? (
        <WindHourlyChart series={wind} axis={axis} timeZone={timeZone} setReadout={setReadout} />
      ) : null}
      {showClimb ? (
        <ClimbHourlyChart
          series={climb}
          timing={timing}
          axis={axis}
          timeZone={timeZone}
          setReadout={setReadout}
        />
      ) : null}
      {showLegs && legs ? (
        <WindLegsGantt series={legs} timing={timing} axis={axis} timeZone={timeZone} setReadout={setReadout} />
      ) : null}
      <p aria-hidden className="min-h-4 text-xs text-muted-foreground print:hidden">
        {readout ?? "Hover a chart for exact figures."}
      </p>
      <p className="text-xs text-muted-foreground">
        All charts share one time axis ({zone}). Arrows fly WITH the wind — the tables' direction
        figures are degrees the wind blows from; arrow length and opacity track speed and sample
        count. Exact numbers are in the tables below.
      </p>
    </figure>
  );
}
