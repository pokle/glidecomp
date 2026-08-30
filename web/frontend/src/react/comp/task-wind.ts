/**
 * The day's wind, reduced to one vector and resolved against each task leg.
 *
 * A pilot reading a task wants one thing from the weather before launch: which
 * legs are the slog. That is a per-leg head/cross/tail component, and it needs
 * exactly two inputs — a wind vector and a leg bearing. This module is that
 * arithmetic, kept pure so it can be tested without a network or a chart.
 *
 * **One vector for the whole task, deliberately.** A task that hasn't been
 * flown has no per-leg timing to hang hourly wind on — nobody knows when the
 * field will be on leg 4 — so pretending to a per-leg wind would be inventing
 * precision. The combined wind over the task's window at flying height is the
 * honest summary, and the UI says as much. (Once a task HAS been flown, the
 * task analysis computes real per-leg wind from the pilots' own circling;
 * that is a different, better number for a different, later question.)
 *
 * The hourly estimates are combined by the engine's `combineWindEstimates` —
 * the ONE policy every wind-reporting surface shares (median magnitude,
 * vector-mean direction) — so this page and the task-analysis report cannot
 * disagree about the same wind.
 *
 * Wind direction is degrees the wind blows FROM, matching the engine's weather
 * module and every met convention; speeds are km/h, converted at the display
 * boundary like the other weather charts.
 */
import {
  combineWindEstimates,
  flyingHeightLevel,
  type TaskWeather,
} from "@glidecomp/engine";

export interface TaskWind {
  /** Degrees the wind blows FROM, 0–360 true. */
  fromDeg: number;
  speedKmh: number;
  /** How many hourly samples went into the combined wind. */
  hours: number;
  /**
   * Which part of the column the wind came from. `flying` is a pressure level
   * near typical thermal height; `surface` is screen height — all some
   * datasets carry (ERA5 has no pressure-level winds), and a much weaker
   * proxy for what a glider feels, so the UI labels it.
   */
  level: "flying" | "surface";
  /** Approximate height AMSL of the level used; null at the surface. */
  heightM: number | null;
}

/** One leg's wind, resolved into along-course and across-course components. */
export interface LegWind {
  /** Along-course component, km/h. Positive = headwind, negative = tailwind. */
  alongKmh: number;
  /** Across-course magnitude, km/h. */
  crossKmh: number;
  /** Which component dominates — what the leg mostly IS. */
  kind: "head" | "tail" | "cross";
}

/**
 * Reduce a task's modelled weather to a single flying-height wind.
 *
 * Prefers pressure-level winds and falls back to surface only when NO hour has
 * a usable level — never mixing the two into one combination, which would
 * average numbers that mean different things. Returns null when neither is
 * available.
 */
export function taskWindFromWeather(weather: TaskWeather | null): TaskWind | null {
  if (!weather || weather.hours.length === 0) return null;

  const levelSamples: Array<{ direction: number; speed: number }> = [];
  const surfaceSamples: Array<{ direction: number; speed: number }> = [];
  let heightSum = 0;

  for (const hour of weather.hours) {
    const level = flyingHeightLevel(hour.levels ?? [], weather.resolved.elevationM);
    if (level?.windDirectionDeg != null && level.windSpeedKmh != null) {
      levelSamples.push({ direction: level.windDirectionDeg, speed: level.windSpeedKmh });
      heightSum += level.heightM;
    }
    if (hour.surface.windDirectionDeg != null && hour.surface.windSpeedKmh != null) {
      surfaceSamples.push({
        direction: hour.surface.windDirectionDeg,
        speed: hour.surface.windSpeedKmh,
      });
    }
  }

  const useLevels = levelSamples.length > 0;
  const samples = useLevels ? levelSamples : surfaceSamples;
  const combined = combineWindEstimates(samples);
  if (!combined) return null;

  return {
    fromDeg: combined.direction,
    speedKmh: combined.speed,
    hours: combined.n,
    level: useLevels ? "flying" : "surface",
    heightM: useLevels ? Math.round(heightSum / levelSamples.length) : null,
  };
}

/**
 * Resolve a wind against a leg's bearing.
 *
 * Both are "from"/"toward" quantities in the same frame, so the along-course
 * component is `speed · cos(windFrom − bearing)`: flying straight into the
 * wind's source (windFrom === bearing) gives cos 0 = +1, a full headwind.
 *
 * The dominant component decides what to call the leg, so the head/tail and
 * cross labels change hands at 45° off course rather than a leg being forced
 * into head or tail whatever the angle. A cross leg still reports its
 * along-course number — the sign is what tells a pilot whether the quartering
 * helps or hurts.
 */
export function legWind(wind: TaskWind, bearingDeg: number): LegWind {
  const rad = ((wind.fromDeg - bearingDeg) * Math.PI) / 180;
  const alongKmh = wind.speedKmh * Math.cos(rad);
  const crossKmh = Math.abs(wind.speedKmh * Math.sin(rad));
  const kind =
    Math.abs(alongKmh) >= crossKmh ? (alongKmh >= 0 ? "head" : "tail") : "cross";
  return { alongKmh, crossKmh, kind };
}

/** One word for a leg's wind, for a label or a screen reader. */
export function legWindWord(kind: LegWind["kind"]): string {
  return kind === "head" ? "headwind" : kind === "tail" ? "tailwind" : "crosswind";
}
