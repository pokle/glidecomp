/**
 * GAP scoring parameters and their resolution.
 *
 * The GAPParameters config surface (every knob the FAI S7F formula exposes,
 * heavily documented with its spec section), the raw engine baseline
 * DEFAULT_GAP_PARAMETERS, and the per-category / date-based resolution
 * (defaultsFor, resolveCompGapParams) a competition is scored from.
 */

// ---------------------------------------------------------------------------
// Competition parameters
// ---------------------------------------------------------------------------

/** GAP competition parameters — set once per competition. */
export interface GAPParameters {
  /** Fraction of pilots expected to launch (default 0.96) */
  nominalLaunch: number;
  /** Expected task distance in meters */
  nominalDistance: number;
  /** Expected fraction of pilots reaching goal (default 0.2) */
  nominalGoal: number;
  /** Expected task duration in seconds (default 5400 = 90 min) */
  nominalTime: number;
  /** Minimum scored distance in meters (default 5000) */
  minimumDistance: number;
  /** Sport type — affects arrival points and some weight calculations */
  scoring: 'PG' | 'HG';
  /** Whether to compute leading (departure) points (default true) */
  useLeading: boolean;
  /** Whether to compute arrival points (default true for HG, ignored for PG) */
  useArrival: boolean;
  /**
   * Leading-coefficient (departure points) variant — see {@link LeadingFormula}.
   * Since issue #258 this selects ONLY the LC envelope, independently of the
   * time-points exponent ({@link timePointsExponent}):
   * - 'weighted' — GAP2020+ / current FAI S7F paragliding: weighted-area
   *   leading envelope.
   * - 'classic'  — GAP2016/2018 & current FAI S7F hang gliding: squared-distance
   *   leading, time from each pilot's own start.
   * When {@link timePointsExponent} is unset the exponent falls back to the
   * value this formula historically implied (weighted → 5/6, classic → 2/3),
   * preserving the scores of competitions saved before the two were split.
   */
  leadingFormula: LeadingFormula;
  /**
   * Which generation of the *leading-weight* formula distributes the
   * non-distance weight between leading and time — a paragliding-only
   * choice (hang-gliding weights are identical across generations):
   * - 'gap2020'  — GAP2020/2021, matching AirScore's presets (the default,
   *   preserving historical scores). PG leading weight is 0.35 × (1 − DW)
   *   when someone makes goal, and 0.1 × BestDist/TaskDist when nobody does.
   * - 's7f2024'  — the 2024 FAI Sporting Code S7F §10 formula. PG leading
   *   weight is (1 − DW) × {@link GAPParameters.leadingTimeRatio} when
   *   someone makes goal, and the *entire* non-distance weight (1 − DW)
   *   when nobody does (nobody can earn PG time points without goal).
   *
   * See issue #257 and the `/scoring/gap` "Differences from the Official
   * Spec" section. Only the leading↔time split changes; distance and
   * arrival weights are unaffected, so hang-gliding scores never move.
   */
  leadingWeightFormula: LeadingWeightFormula;
  /**
   * S7F 2024 §10 "LeadingTimeRatio": for paragliding under the
   * {@link GAPParameters.leadingWeightFormula} `'s7f2024'` formula, the
   * fraction (0–0.5, default 0.26) of the non-distance weight allocated to
   * leading when someone makes goal; the remainder goes to time. Ignored
   * for hang gliding, and for PG under the `'gap2020'` formula.
   */
  leadingTimeRatio: number;
  /**
   * Speed-points exponent for the time-points curve (FAI S7F §11.2), decoupled
   * from {@link leadingFormula} since issue #258:
   * - '5/6' — current FAI S7F (2024), for both sports.
   * - '2/3' — the older GAP2016/2018 curve (slightly more generous).
   * Optional: when unset the exponent is derived from {@link leadingFormula}
   * for backward compatibility (see its doc). The per-category defaults
   * ({@link defaultsFor}) set it to '5/6' for both sports, so the exact
   * 2024-spec hang-gliding pairing (classic LC + 5/6) is expressible.
   */
  timePointsExponent?: SpeedExponent;
  /**
   * Where scored task distance begins, for tasks that define a take-off
   * turnpoint before the SSS:
   * - 'takeoff' — measure from the take-off point through the SSS to goal,
   *   per FAI CIVL GAP / PWCA (the take-off→SSS leg counts). The default.
   * - 'start'   — measure from the start (SSS) cylinder edge, excluding the
   *   take-off→SSS leg (the HGFA/SAFA rule wording; "Move Origin" in the
   *   Davis/SeeYou hang-gliding toolchain).
   *
   * Only affects tasks whose first turnpoint is a TAKEOFF; tasks that
   * begin at the SSS score identically either way.
   */
  distanceOrigin: DistanceOrigin;
  /**
   * Hang-gliding "distance difficulty" (FAI S7F §11.1.1). When true (the
   * default), HG distance points are half linear + half difficulty, where
   * the difficulty half rewards flying past clusters of landed-out pilots.
   * When false, HG uses a pure linear distance fraction. Has no effect on
   * paragliding — the FAI spec excludes difficulty for PG, so PG is always
   * pure linear.
   */
  useDistanceDifficulty: boolean;
  /**
   * Hang-gliding "jump the gun" (FAI S7F §12.2): seconds of early start
   * per 1 penalty point (the spec's X; default 2). Only applies to HG in
   * gated races — a PG early starter is instead scored only for the
   * launch→SSS distance.
   */
  jumpTheGunFactor: number;
  /**
   * Hang-gliding "jump the gun" (FAI S7F §12.2): maximum seconds a pilot
   * may start early and still be scored for the complete flight (the
   * spec's Y; default 300). Beyond this the pilot is scored for minimum
   * distance only.
   */
  jumpTheGunMaxSeconds: number;
  /**
   * Paragliding score-back time in seconds (FAI S7F §5.6, §12.3.1): when a
   * task is stopped, the PG task stop time is the stop announcement time
   * minus this competition parameter (default 300 s = 5 minutes). Ignored
   * for hang gliding, whose score-back is one start-gate interval (or 15
   * minutes with a single gate) per §12.3.1.
   */
  scoreBackTime: number;
  /**
   * Hang-gliding "ESS but not goal" (FAI S7F §12.1): the fraction of time
   * and arrival points KEPT by a pilot who reaches the end of the speed
   * section but fails to reach goal (reaching goal "validates" the speed
   * section). The spec recommends 0.8 for hang gliders; local regulations
   * may change it. Paragliding is fixed at 0 by the spec (no goal → no
   * time points), so this setting never affects PG scoring — the engine
   * treats PG as factor 0 regardless of the configured value.
   *
   * The factor also selects the "best time" source (AirScore parity, see
   * {@link scoreFlights}): while it keeps a share of the points (factor
   * > 0), the best time comes from all ESS pilots; at 0 it is
   * goal-validated per §11.2.1.
   */
  essNotGoalFactor: number;
}

/** Leading coefficient variant — see {@link GAPParameters.leadingFormula}. */
export type LeadingFormula = 'classic' | 'weighted';

/** Leading-weight formula generation — see {@link GAPParameters.leadingWeightFormula}. */
export type LeadingWeightFormula = 'gap2020' | 's7f2024';

/** Time-points exponent (FAI S7F §11.2) — see {@link GAPParameters.timePointsExponent}. */
export type SpeedExponent = '5/6' | '2/3';

/** Where scored task distance begins — see {@link GAPParameters.distanceOrigin}. */
export type DistanceOrigin = 'takeoff' | 'start';

/**
 * Raw engine baseline — the merge target for {@link scoreFlights} when a
 * caller supplies only a partial parameter set. It is *not* the per-category
 * "official" default a competition should start from: for that, use
 * {@link defaultsFor}, which turns on the leading/arrival/difficulty terms the
 * FAI formula actually uses for each category. Kept HG-shaped with those terms
 * off so partial-param engine callers stay backwards-compatible.
 */
export const DEFAULT_GAP_PARAMETERS: GAPParameters = {
  nominalLaunch: 0.96,
  nominalDistance: 70000,
  nominalGoal: 0.2,
  nominalTime: 5400,
  minimumDistance: 5000,
  scoring: 'HG',
  useLeading: false,
  useArrival: false,
  leadingFormula: 'weighted',
  leadingWeightFormula: 'gap2020',
  leadingTimeRatio: 0.26,
  distanceOrigin: 'takeoff',
  useDistanceDifficulty: true,
  jumpTheGunFactor: 2,
  jumpTheGunMaxSeconds: 300,
  scoreBackTime: 300,
  essNotGoalFactor: 0.8,
};

/**
 * Scoring-defaults preset. Only the current FAI / CIVL GAP formula is
 * implemented today; future presets (e.g. an Australian SAFA variant that
 * runs leading/arrival off) slot in here without changing call sites.
 */
export type ScoringPreset = 'fai';

/**
 * The recommended default GAP parameters for a new competition of the given
 * category, per the current FAI Sporting Code S7F / CIVL GAP formula
 * (issue #343). These are the "official" settings a comp starts from, before
 * any organiser override:
 *
 * - Leading (departure) points: on for both PG and HG — part of the S7F score.
 * - Arrival points: on for HG, off for PG (S7F arrival applies to HG only).
 * - Distance difficulty: on for HG, off for PG (S7F §11.1.1; PG is pure-linear).
 * - Leading formula + time-points exponent: the 2024-spec sport pairing
 *   (issue #258) — HG uses the classic squared-distance LC (S7F §11.3.1 HG
 *   variant), PG the weighted-area LC (PG variant), and BOTH use the 5/6
 *   time-points exponent (§11.2). These two knobs are independent, so an
 *   organiser can pick any (LC variant, exponent) combination for AirScore
 *   parity — e.g. weighted + 5/6 for the gap2020/2021 preset the Corryong
 *   fixture is scored with, or classic + 2/3 for gap2016/2018.
 * - Nominal goal 30% — the FAI / AirScore norm.
 *
 * `nominalDistance` keeps the engine baseline (70 km); the competition backend
 * still auto-computes it per task (70% of the task distance) whenever a comp
 * hasn't pinned an explicit value.
 *
 * On FAI classes: S7F GAP defines only these *two* scoring profiles, so 'hg'
 * and 'pg' cover every FAI XC class — 'pg' is FAI Class 3 (paragliders); 'hg'
 * is FAI Class 1 (flexwing) AND Classes 2 and 5 (rigid wings), which S7F /
 * AirScore score with the HG ruleset. The arrival / difficulty / jump-the-gun
 * distinctions are hang-glider-vs-paraglider only, never flexwing-vs-rigid, so
 * there is no separate rigid-wing profile to add. Distinguishing specific
 * classes within an event (e.g. flex vs rigid ranked separately, or Sport
 * Class — itself an FAI sub-class of Class 1) is a results subdivision and
 * belongs in the comp's pilot classes, not here.
 */
export function defaultsFor(
  category: 'hg' | 'pg',
  _preset: ScoringPreset = 'fai'
): GAPParameters {
  const pg = category === 'pg';
  return {
    ...DEFAULT_GAP_PARAMETERS,
    scoring: pg ? 'PG' : 'HG',
    nominalGoal: 0.3,
    useLeading: true,
    useArrival: !pg,
    useDistanceDifficulty: !pg,
    // 2024-spec sport pairing (issue #258): PG weighted LC, HG classic LC,
    // both with the modern 5/6 time-points exponent.
    leadingFormula: pg ? 'weighted' : 'classic',
    timePointsExponent: '5/6',
    // S7F §12.1 fixes the PG ESS-but-not-goal parameter at 0 (no goal → no
    // time points); the HG recommended default is 0.8. The engine ignores
    // the value for PG either way — this keeps the displayed default honest.
    essNotGoalFactor: pg ? 0 : 0.8,
  };
}

/**
 * Paragliding competitions created on or after this instant default to the
 * S7F-2024 leading-weight formula; earlier comps keep the GAP2020/AirScore-
 * parity default, so no pre-existing comp's paragliding scores shift when the
 * 2024 formula ships (issue #257). A comp that explicitly saves a
 * {@link GAPParameters.leadingWeightFormula} overrides this either way, and
 * hang gliding is generation-independent. Expressed as a fixed UTC constant
 * (2026-07-15T00:00:00Z) so the resolution stays deterministic.
 */
export const S7F2024_PG_DEFAULT_SINCE_MS = Date.UTC(2026, 6, 15);

/**
 * Merge a competition's stored GAP parameters over the official per-category
 * defaults, resolving the effective parameter set the scorer (and the score
 * explainer) should use.
 *
 * Backward compatibility (issue #258): a comp that explicitly saved a
 * `leadingFormula` but predates the independent {@link
 * GAPParameters.timePointsExponent} keeps the exponent that formula used to
 * imply (classic → 2/3, weighted → 5/6), rather than inheriting the category
 * default's 5/6. A comp with no stored params — or stored params that never
 * pinned a formula — takes the category default pairing.
 *
 * Paragliding leading-weight default (issue #257): a PG comp that never pinned
 * a {@link GAPParameters.leadingWeightFormula} defaults to S7F-2024 when it was
 * created on/after {@link S7F2024_PG_DEFAULT_SINCE_MS}, and to GAP2020/AirScore
 * parity otherwise. Pass `createdAtMs` (the comp's creation time in epoch ms)
 * to opt into the date-based default; omit it — as the CLI does — to keep the
 * GAP2020 baseline.
 *
 * @param category - 'hg' or 'pg' (drives {@link defaultsFor})
 * @param stored - the comp's saved gap_params, or null when it never saved any
 * @param createdAtMs - the comp's creation time (epoch ms), or null/undefined
 *   when unknown (keeps the GAP2020 leading-weight default)
 */
export function resolveCompGapParams(
  category: 'hg' | 'pg',
  stored: Partial<GAPParameters> | null,
  createdAtMs?: number | null,
): GAPParameters {
  const merged: GAPParameters = { ...defaultsFor(category), ...(stored ?? {}) };
  if (stored && stored.timePointsExponent == null && stored.leadingFormula != null) {
    merged.timePointsExponent = stored.leadingFormula === 'classic' ? '2/3' : '5/6';
  }
  if (
    category === 'pg' &&
    stored?.leadingWeightFormula == null &&
    createdAtMs != null &&
    Number.isFinite(createdAtMs) &&
    createdAtMs >= S7F2024_PG_DEFAULT_SINCE_MS
  ) {
    merged.leadingWeightFormula = 's7f2024';
  }
  return merged;
}
