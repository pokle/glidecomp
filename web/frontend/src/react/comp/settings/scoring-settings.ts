/**
 * The Scoring settings form, as values: what each field starts at (the
 * EFFECTIVE parameters the scorer uses — the wing's official CIVL GAP
 * defaults under the comp's saved overrides, issue #343), what Reset puts
 * back, and the PATCH body a save sends. Pure, so ScoringSettings' rules are
 * unit-testable.
 */
import {
  defaultsFor,
  resolveCompGapParams,
  resolveLeadingTimeRatio,
  storedHgClass2Classes,
} from "@glidecomp/engine";
import type { CompDetailData, ScoringFormat, SeriesScoring } from "../types";

export interface ScoringFormValues {
  scoringFormat: ScoringFormat;
  seriesScoring: SeriesScoring;
  /** "" = automatic (0.2 / 0.25 from the task count); else a percentage. */
  ftvFactorPct: string;
  /** Kilometres; NaN = auto (70% of each task's distance). */
  nominalDistance: number;
  /** Minutes. */
  nominalTime: number;
  /** Kilometres. */
  minimumDistance: number;
  useLeading: boolean;
  useArrival: boolean;
  useDifficulty: boolean;
  /** Percent, one decimal (the HG default is 17.5). */
  leadingTimeRatio: number;
  distanceOrigin: "takeoff" | "start";
  jtgFactor: number;
  jtgMax: number;
  /** Percent of time and arrival points kept. */
  essNotGoal: number;
  class2Classes: string[];
}

type CompScoringFields = Pick<
  CompDetailData,
  "category" | "gap_params" | "scoring_format" | "series_scoring" | "ftv_factor" | "pilot_classes"
>;

export function wingOf(comp: Pick<CompDetailData, "category">): "hg" | "pg" {
  return comp.category === "pg" ? "pg" : "hg";
}

/** What each field starts at: the effective parameters the scoreboard is computed from. */
export function scoringFormValues(comp: CompScoringFields): ScoringFormValues {
  const wing = wingOf(comp);
  const { nominalDistance: _nd, ...stored } = comp.gap_params ?? {};
  void _nd;
  const gp = resolveCompGapParams(wing, comp.gap_params ? stored : null);
  return {
    scoringFormat: comp.scoring_format ?? "gap",
    seriesScoring: comp.series_scoring ?? "total",
    ftvFactorPct: comp.ftv_factor != null ? String(Math.round(comp.ftv_factor * 100)) : "",
    // Keyed off the STORED value, not the default, so a comp that never
    // pinned a nominal distance shows auto — the scorer's own behaviour.
    nominalDistance:
      comp.gap_params?.nominalDistance != null ? Math.round(comp.gap_params.nominalDistance / 1000) : NaN,
    nominalTime: Math.round(gp.nominalTime / 60),
    minimumDistance: gp.minimumDistance / 1000,
    useLeading: gp.useLeading,
    useArrival: gp.useArrival,
    useDifficulty: gp.useDistanceDifficulty ?? true,
    leadingTimeRatio: Math.round(resolveLeadingTimeRatio(gp) * 1000) / 10,
    distanceOrigin: gp.distanceOrigin ?? "takeoff",
    jtgFactor: gp.jumpTheGunFactor ?? 2,
    jtgMax: gp.jumpTheGunMaxSeconds ?? 300,
    essNotGoal: Math.round((gp.essNotGoalFactor ?? 0.8) * 100),
    // Only classes still on the roster are offered, and only those saved.
    class2Classes: storedHgClass2Classes(comp.gap_params).filter((c) => comp.pilot_classes.includes(c)),
  };
}

/**
 * Reset: the GAP fields back to the official defaults for the wing (issue
 * #343); nominal distance back to auto. The format, series and Class 2
 * choices are not GAP defaults and are kept.
 */
export function scoringDefaults(wing: "hg" | "pg", current: ScoringFormValues): ScoringFormValues {
  const d = defaultsFor(wing);
  return {
    ...current,
    nominalDistance: NaN,
    nominalTime: Math.round(d.nominalTime / 60),
    minimumDistance: d.minimumDistance / 1000,
    useLeading: d.useLeading,
    useArrival: d.useArrival,
    useDifficulty: d.useDistanceDifficulty,
    leadingTimeRatio: Math.round(resolveLeadingTimeRatio(d) * 1000) / 10,
    distanceOrigin: d.distanceOrigin,
    jtgFactor: d.jumpTheGunFactor,
    jtgMax: d.jumpTheGunMaxSeconds,
    essNotGoal: Math.round(d.essNotGoalFactor * 100),
  };
}

const num = (value: number, fallback: number) => (Number.isNaN(value) ? fallback : value);

/**
 * The comp PATCH body for a save. The scoring class follows the wing; FTV is
 * GAP-only; an open-distance comp omits `gap_params` entirely rather than
 * writing parameters its format does not use.
 */
export function scoringPatch(v: ScoringFormValues, comp: CompScoringFields): Record<string, unknown> {
  const wing = wingOf(comp);
  const gapParams = {
    scoring: (wing === "pg" ? "PG" : "HG") as "PG" | "HG",
    nominalDistance: Number.isNaN(v.nominalDistance) ? null : v.nominalDistance * 1000,
    nominalTime: num(v.nominalTime, 90) * 60,
    minimumDistance: num(v.minimumDistance, 5) * 1000,
    useLeading: v.useLeading,
    useArrival: v.useArrival,
    leadingTimeRatio: num(v.leadingTimeRatio, wing === "pg" ? 26 : 17.5) / 100,
    distanceOrigin: v.distanceOrigin,
    useDistanceDifficulty: v.useDifficulty,
    jumpTheGunFactor: num(v.jtgFactor, 2),
    jumpTheGunMaxSeconds: num(v.jtgMax, 300),
    essNotGoalFactor: num(v.essNotGoal, 80) / 100,
    // In the roster's order, so the stored list doesn't depend on tap order.
    ...(wing === "hg" ? { hgClass2Classes: comp.pilot_classes.filter((c) => v.class2Classes.includes(c)) } : {}),
  };
  return {
    scoring_format: v.scoringFormat,
    series_scoring: v.scoringFormat === "gap" ? v.seriesScoring : "total",
    ftv_factor:
      v.scoringFormat === "gap" && v.seriesScoring === "ftv" && v.ftvFactorPct ? Number(v.ftvFactorPct) / 100 : null,
    ...(v.scoringFormat !== "open_distance" ? { gap_params: gapParams } : {}),
  };
}

/** The Settings index's one-line summary of the scoring row. */
export function scoringSummary(comp: Pick<CompDetailData, "scoring_format" | "series_scoring">): string {
  if (comp.scoring_format === "open_distance") return "Open distance";
  return comp.series_scoring === "ftv" ? "GAP · FTV" : "GAP";
}

/** The Settings index's one-line summary of the access row. */
export function accessSummary(comp: Pick<CompDetailData, "test" | "open_registration">): string {
  return [comp.test ? "Hidden" : null, (comp.open_registration ?? true) ? "Open registration" : "Admins add pilots"]
    .filter(Boolean)
    .join(" · ");
}
