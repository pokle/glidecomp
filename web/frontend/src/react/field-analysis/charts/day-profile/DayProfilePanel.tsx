/**
 * The day, flown and modelled, on ONE shared time axis — the body of the
 * field-analysis page's "What the weather did" section.
 *
 * TWO labelled groups, stacked deliberately rather than overlaid:
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
 * disagreement stays legible as a disagreement. Each group carries an
 * explicit source label so a reader always knows which evidence they are
 * looking at; every modelled chart additionally carries its provider inside
 * the plot.
 *
 * Each chart is a labelled `role="img"`; the day metrics' tables further
 * down the page remain the exact, screen-reader-navigable reading, and one
 * shared readout line voices whatever the pointer is over.
 *
 * The task page shows the modelled group alone (TaskWeatherPanel) — it has
 * no per-pilot series to set against the model.
 */
import { useMemo, useState } from "react";
import type {
  ClimbHourlySeries,
  DayTimingSeries,
  MetricReport,
  WindHourlySeries,
  WindLegsSeries,
} from "../../types";
import type { TaskWeather } from "@/react/weather/types";
import { sourceKindLabel } from "@/react/weather/types";
import { zoneAbbrev } from "@/react/lib/time";
import { buildTimeAxis } from "./time-axis";
import { PLOT_LEFT, PLOT_RIGHT } from "./shared";
import { TimeAxisTitle } from "./TimeAxisParts";
import { WindHourlyChart } from "./WindHourlyChart";
import { ClimbHourlyChart } from "./ClimbHourlyChart";
import { WindLegsGantt } from "./WindLegsGantt";
import { MetChartsGroup, MetAttribution } from "./MetChartsGroup";
import { weatherInstants } from "./met-shared";

const HOUR_MS = 3_600_000;

/** How far the axis extends past the field's own flying, each side. Enough
 * to show the morning that set the day up and the glass-off after the last
 * landing, without the whole-day weather answer dragging the axis out to
 * midnight. */
const WINDOW_PAD_MS = 2 * HOUR_MS;

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

/** A group's source label: the one line that says which evidence the charts
 * beneath it are drawn from. h3 because the panel lives inside the page's
 * h2 "What the weather did" section. */
function GroupHeading({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="space-y-0.5 pt-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

export function DayProfilePanel({
  metrics,
  compTimezone,
  weather = null,
  weatherPending = false,
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

  // The axis window: when the field actually flew, plus two hours either
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
        ? buildTimeAxis([windowStartMs, windowEndMs], timeZone, [PLOT_LEFT, PLOT_RIGHT])
        : null,
    [windowStartMs, windowEndMs, timeZone]
  );

  const showWind = wind !== null && wind.hours.length > 0;
  const showClimb = climb !== null && climb.hours.length > 0;
  const showLegs = legs !== null && legs.legs.some((l) => l.n > 0);
  const showFlown = showWind || showClimb || showLegs;
  const showWeather = weather !== null && shownWeatherHours.length > 0;
  // Whether the modelled group occupies the top slot (charts or the pending
  // placeholder) — the flown group only draws its dividing rule beneath one.
  const showModelGroup = showWeather || weatherPending;
  if (!axis || (!showFlown && !showWeather)) return null;

  const zone = zoneAbbrev(new Date(axis.domainStart), timeZone);

  // The ⓘ text of every metric whose series is actually drawn, inline under
  // the group label — the panel composes several metrics, so each line
  // carries its metric's name. Reads with the charts on screen and in print.
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
      {/* ── Group 1: modelled — the day as predicted ──────────────────── */}
      {showWeather && weather ? (
        <>
          <GroupHeading
            title="From the weather model"
            detail={`Independent of the tracklogs: ${sourceKindLabel(weather.source.kind)} conditions for the task area from ${weather.source.attribution}.`}
          />
          <MetChartsGroup
            weather={weather}
            hours={shownWeatherHours}
            axis={axis}
            timeZone={timeZone}
            setReadout={setReadout}
          />
        </>
      ) : weatherPending ? (
        <>
          <GroupHeading
            title="From the weather model"
            detail="Independent of the tracklogs: modelled conditions for the task area."
          />
          <p className="text-sm text-muted-foreground">
            Fetching the day&rsquo;s weather — it will appear here in a moment.
          </p>
        </>
      ) : null}

      {/* ── Group 2: measured, on the same clock ──────────────────────────
          A labelled break, because everything above is modelled and
          everything below is measured from the pilots' own tracks. */}
      {showFlown ? (
        <div className={showModelGroup ? "space-y-1 border-t" : "space-y-1"}>
          <GroupHeading
            title="From the pilots' tracks"
            detail="What the field actually flew — wind, climb strength and leg timing measured from every pilot's tracklog."
          />
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
        </div>
      ) : null}

      {/* The axis all of them share, named once at the foot of the stack. */}
      <TimeAxisTitle zone={zone} />

      <p aria-hidden className="min-h-4 text-xs text-muted-foreground print:hidden">
        {readout ?? "Hover a chart for exact figures."}
      </p>
      <p className="text-xs text-muted-foreground">
        All charts — measured and modelled alike — share that one time axis, so a vertical scan
        compares the two at the same moment. Arrows fly WITH the wind — direction figures are
        degrees the wind blows from; arrow length and opacity track speed and sample count. On the
        per-leg chart the pale bar is when the field flew that leg and the solid band inside it is
        the circling its wind was measured from — a leg the field glided is measured in a sliver of
        the time it was flown. Exact numbers are in the day family&rsquo;s tables under &ldquo;The
        metrics in detail&rdquo;.
      </p>
      {showWeather && weather ? <MetAttribution weather={weather} /> : null}
    </figure>
  );
}
