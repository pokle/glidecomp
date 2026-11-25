/**
 * The day, flown and modelled, on ONE shared time axis — the body of Task
 * analysis → Weather.
 *
 * TWO cards, stacked deliberately rather than overlaid:
 *
 * 1. "From the weather model" — what an outside provider says the day did
 *    (wind, cloud, thermal ceiling); see the engine's weather/ module. The
 *    forecast leads: it is the day as predicted, before any pilot flew it.
 *
 * 2. "From the pilots' tracks" — the day family's charting series: wind by
 *    hour on top, the climb quantile fan (with the day-timing overlays) in
 *    the middle, the per-leg wind Gantt at the bottom. The series come from
 *    THREE different metrics (day.wind, day.climb_by_hour,
 *    day.airtime_quality); this panel is why SeriesChart deliberately
 *    doesn't render them per-metric.
 *
 * The two answer the same questions from incompatible evidence (a field of
 * tracklogs versus a grid cell kilometres wide), and overlaying them would
 * imply one is a correction of the other. Side by side on a shared clock, a
 * vertical scan reads "at 2pm: the model had 30 km/h NW, the field's circles
 * said 24; climbs at their best, most of the field on leg 3" — and a
 * disagreement stays legible as a disagreement. Each card's title says which
 * evidence it holds, and every chart repeats it in its own stamp.
 *
 * The page is the charts. What each metric measures is behind the ⓘ on the
 * chart it draws, not a block of prose between the two cards; the same text
 * is printed in full on "How this was measured", and the metrics' tables on
 * "Metric details" remain the exact, screen-reader-navigable reading. One
 * hour is selected for the whole stack, and each chart prints its figures
 * for it in its own legend row; nothing is hover-only.
 *
 * The task page shows the modelled charts alone (TaskWeatherPanel) — it has
 * no per-pilot series to set against the model.
 */
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Card, CardTitle } from "@/react/rac/card";
import { Explain } from "@/react/rac/explain";
import type {
  ClimbHourlySeries,
  DayTimingSeries,
  MetricReport,
  WindHourlySeries,
  WindLegsSeries,
} from "../../types";
import type { TaskWeather } from "@/react/weather/types";
import { zoneAbbrev } from "@/react/lib/time";
import { buildTimeAxis } from "./time-axis";
import { TimeAxisTitle } from "./TimeAxisParts";
import { WindHourlyChart } from "./WindHourlyChart";
import { ClimbHourlyChart } from "./ClimbHourlyChart";
import { WindLegsGantt } from "./WindLegsGantt";
import { MetChartsGroup, MetAttribution } from "./MetChartsGroup";
import { useChartFrame } from "./frame";
import { weatherInstants } from "./met-shared";

const HOUR_MS = 3_600_000;

/** How far the axis extends past the field's own flying, each side. An hour
 * shows the air before the first launch and after the last landing; two
 * spent a quarter of every chart on hours nobody flew, which on a phone is
 * 60px of a 270px plot. The whole-day weather answer is clamped into this
 * window rather than allowed to drag the axis out to midnight. */
const WINDOW_PAD_MS = HOUR_MS;

/**
 * Every instant the FLOWN evidence occupies, as epoch ms: the pilot-derived
 * hour buckets (start and end of each), the per-leg spans, and every
 * takeoff. Deliberately NOT the task-clock markers (window open, gates,
 * deadline) or the weather hours — the axis window is framed by when the
 * field actually flew, and everything else is clamped into it.
 */
function flownInstants(
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
    // The flown window outruns the circling one — a leg's last pilot leaves
    // it after the last circle on it — so the axis must cover it or the
    // Gantt's outer bars clip at the plot edge.
    push(l.flownFrom);
    push(l.flownTo);
  }
  timing?.takeoffs.forEach(push);
  return out.filter((t) => Number.isFinite(t));
}

/** One card of the stack: its title, and its charts. The title is an h2,
 * because the page's h1 is the bar's and nothing sits between them. */
function GroupCard({
  title,
  measureRef,
  children,
}: {
  title: string;
  /** The chart frame is measured on the first card's body (useChartFrame). */
  measureRef?: (el: HTMLElement | null) => void;
  children: ReactNode;
}) {
  return (
    // Tighter than a card's usual 20px on a phone: 16px more of a 360px
    // screen goes to the charts.
    <Card className="gap-3 px-3 py-4 sm:p-5">
      <CardTitle>{title}</CardTitle>
      <div ref={measureRef} className="space-y-5">
        {children}
      </div>
    </Card>
  );
}

/** One ⓘ for a chart: the explanation of each metric it draws. The first
 * metric names the popover; any after it name their own paragraph. */
function MetricInfo({
  label,
  metrics,
  extra,
}: {
  label: string;
  metrics: MetricReport[];
  extra?: ReactNode;
}) {
  if (metrics.length === 0 && !extra) return null;
  return (
    <Explain label={label}>
      {metrics.map((m, i) => (
        <p key={m.id}>
          {i > 0 ? <span className="font-medium">{m.label}. </span> : null}
          {m.explanation}
        </p>
      ))}
      {extra}
    </Explain>
  );
}

export function DayProfilePanel({
  metrics,
  compTimezone,
  weather = null,
  weatherPending = false,
  trackCount = null,
  tablesHref = null,
}: {
  metrics: MetricReport[];
  /** Competition IANA zone; the axis ticks in it (viewer-local when null). */
  compTimezone: string | null;
  /** Modelled conditions for the task window; null while loading, when the
   * task has no route, or when every provider failed. The panel degrades to
   * the pilot-derived charts alone rather than showing an empty group. */
  weather?: TaskWeather | null;
  /** True while an answer is still on its way — the modelled group shows a
   * placeholder line rather than vanishing and popping in. */
  weatherPending?: boolean;
  /** How many tracks the analysis read, for the track charts' stamp. */
  trackCount?: number | null;
  /** "Metric details", where the day metrics' tables are. */
  tablesHref?: string | null;
}) {
  const timeZone = compTimezone ?? undefined;
  // One hour selected for the whole stack: tap or drag on a phone, hover with
  // a mouse, arrow keys from a keyboard (HourColumns.tsx). Each chart prints
  // its own figures for it in its legend row.
  const [selectedMs, setSelectedMs] = useState<number | null>(null);
  // The stack is laid out at the width it is really drawn — measured once
  // here, so the six charts cannot disagree about where an hour is.
  const { ref: frameRef, frame } = useChartFrame();

  const { wind, climb, legs, timing } = useMemo(() => {
    const all = metrics.flatMap((m) => m.extraSeries ?? []);
    return {
      wind: (all.find((s) => s.kind === "wind-hourly") ?? null) as WindHourlySeries | null,
      climb: (all.find((s) => s.kind === "climb-hourly") ?? null) as ClimbHourlySeries | null,
      legs: (all.find((s) => s.kind === "wind-legs") ?? null) as WindLegsSeries | null,
      timing: (all.find((s) => s.kind === "day-timing") ?? null) as DayTimingSeries | null,
    };
  }, [metrics]);

  // The axis window: when the field actually flew, plus an hour either
  // side. The task's clock markers and the weather answer (which can span a
  // whole day when the task defines no times) are clamped INTO this window
  // rather than allowed to stretch it — an axis running to midnight is dead
  // space on a chart about a flying day. With no flown series at all, the
  // weather hours are the only evidence and frame the window themselves.
  const { windowStartMs, windowEndMs, shownWeatherHours } = useMemo(() => {
    const flown = flownInstants(wind, climb, legs, timing);
    const allWeather = weather?.hours ?? [];
    if (flown.length === 0) {
      const instants = weatherInstants(allWeather);
      if (instants.length === 0)
        return { windowStartMs: NaN, windowEndMs: NaN, shownWeatherHours: [] };
      return {
        windowStartMs: Math.min(...instants),
        windowEndMs: Math.max(...instants),
        shownWeatherHours: allWeather,
      };
    }
    const start = Math.min(...flown) - WINDOW_PAD_MS;
    const end = Math.max(...flown) + WINDOW_PAD_MS;
    return {
      windowStartMs: start,
      windowEndMs: end,
      // Whole hour cells only: a partially-inside hour would draw past the
      // plot edge.
      shownWeatherHours: allWeather.filter((h) => {
        const t = new Date(h.t).getTime();
        return Number.isFinite(t) && t >= start && t + HOUR_MS <= end;
      }),
    };
  }, [wind, climb, legs, timing, weather]);

  const axis = useMemo(
    () =>
      Number.isFinite(windowStartMs)
        ? buildTimeAxis([windowStartMs, windowEndMs], timeZone, [frame.plotLeft, frame.plotRight])
        : null,
    [windowStartMs, windowEndMs, timeZone, frame]
  );

  const showWind = wind !== null && wind.hours.length > 0;
  const showClimb = climb !== null && climb.hours.length > 0;
  const showLegs = legs !== null && legs.legs.some((l) => l.n > 0);
  const showFlown = showWind || showClimb || showLegs;
  const showWeather = weather !== null && shownWeatherHours.length > 0;
  // Whether the modelled card is drawn at all: its charts, or the line that
  // says they are on their way.
  const showModelGroup = showWeather || weatherPending;
  if (!axis || (!showFlown && !showWeather)) return null;

  const zone = zoneAbbrev(new Date(axis.domainStart), timeZone);

  const metric = (id: string) => metrics.filter((m) => m.id === id);
  const windMetric = metric("day.wind");
  const climbMetrics = [...metric("day.climb_by_hour"), ...metric("day.airtime_quality")];
  const stamp = trackCount ? `${trackCount} tracks · measured` : "measured";

  return (
    <figure className="space-y-4">
      {/* ── Card 1: modelled — the day as predicted ───────────────────── */}
      {showModelGroup ? (
        <GroupCard title="From the weather model" measureRef={frameRef}>
          {showWeather && weather ? (
            <div>
              <MetChartsGroup
                weather={weather}
                hours={shownWeatherHours}
                axis={axis}
                frame={frame}
                timeZone={timeZone}
                selectedMs={selectedMs}
                onSelect={setSelectedMs}
              />
              <TimeAxisTitle zone={zone} frame={frame} />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Fetching the day&rsquo;s weather — it will appear here in a moment.
            </p>
          )}
        </GroupCard>
      ) : null}

      {/* ── Card 2: measured, on the same clock ───────────────────────── */}
      {showFlown ? (
        <GroupCard
          title="From the pilots’ tracks"
          measureRef={showModelGroup ? undefined : frameRef}
        >
          {showWind ? (
            <WindHourlyChart
              series={wind}
              axis={axis}
              frame={frame}
              timeZone={timeZone}
              selectedMs={selectedMs}
              onSelect={setSelectedMs}
              stamp={stamp}
              info={<MetricInfo label={windMetric[0]?.label ?? "Wind"} metrics={windMetric} />}
            />
          ) : null}
          {showClimb ? (
            <ClimbHourlyChart
              series={climb}
              timing={timing}
              axis={axis}
              frame={frame}
              timeZone={timeZone}
              selectedMs={selectedMs}
              onSelect={setSelectedMs}
              stamp={stamp}
              info={
                <MetricInfo label={climbMetrics[0]?.label ?? "Climbs"} metrics={climbMetrics} />
              }
            />
          ) : null}
          {showLegs && legs ? (
            <div>
              <WindLegsGantt
                series={legs}
                timing={timing}
                axis={axis}
                frame={frame}
                timeZone={timeZone}
                selectedMs={selectedMs}
                stamp={stamp}
                info={
                  <MetricInfo
                    label="The wind on each leg"
                    metrics={windMetric}
                    extra={<LegBarsNote />}
                  />
                }
              />
              <TimeAxisTitle zone={zone} frame={frame} />
            </div>
          ) : (
            <TimeAxisTitle zone={zone} frame={frame} />
          )}
        </GroupCard>
      ) : null}

      <div className="space-y-2 text-xs text-muted-foreground">
        {/* Two conventions a reader cannot deduce from the charts stay in
            view: the shared axis, and which way the arrows point. */}
        <p>
          <span className="print:hidden">
            Select an hour or a leg on a chart to see its exact figures.{" "}
          </span>
          All charts share one time axis. Arrows fly WITH the wind —
          direction figures are degrees the wind blows from.
        </p>
        {showWeather && weather ? <MetAttribution weather={weather} /> : null}
        {tablesHref ? (
          <p>
            <Link to={tablesHref} className="text-link underline">
              The same figures as tables: Metric details
            </Link>
          </p>
        ) : null}
      </div>
    </figure>
  );
}

/** How the per-leg bars are built: method, so behind the legs chart's ⓘ. */
function LegBarsNote() {
  return (
    <p>
      The pale bar is when the field flew that leg, and the solid band inside
      it is the circling its wind was measured from — a leg the field glided
      is measured in a sliver of the time it was flown. Arrow length and
      opacity track speed and sample count.
    </p>
  );
}
