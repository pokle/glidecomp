/**
 * GAP scoring parameters and their resolution — FAI S7F 2026 edition.
 *
 * The GAPParameters config surface (every knob the 2026 formula still
 * exposes, documented with its spec section), the fixed spec constants that
 * used to be parameters, the raw engine baseline DEFAULT_GAP_PARAMETERS, and
 * the per-category resolution (defaultsFor, resolveCompGapParams) a
 * competition is scored from.
 *
 * GlideComp scores every task under the 2026 edition — there is no
 * multi-edition support. Parameters that earlier editions exposed and 2026
 * fixed (nominal launch, nominal goal, score-back time, the leading-weight
 * formula generations, the time-points exponent) are gone from the surface;
 * stored gap_params that still carry them are accepted and ignored.
 */

// ---------------------------------------------------------------------------
// Spec constants — values the 2026 edition fixes (no longer parameters)
// ---------------------------------------------------------------------------

/** S7F 2026 §10.1: Nominal Launch is a fixed value, not a parameter. */
export const NOMINAL_LAUNCH = 0.96;

/**
 * S7F 2026 §10.2: the Nominal Goal / "DistanceWeight" of the distance
 * validity formula is a fixed value, not a parameter.
 */
export const NOMINAL_GOAL = 0.3;

/** S7F 2026 §11: default LeadingTimeRatio per discipline. */
export const DEFAULT_LEADING_TIME_RATIO_PG = 0.26;
export const DEFAULT_LEADING_TIME_RATIO_HG = 0.175;

/** S7F 2026 §11: the LeadingTimeRatio range is 0..26%. */
export const MAX_LEADING_TIME_RATIO = 0.26;

// ---------------------------------------------------------------------------
// Competition parameters
// ---------------------------------------------------------------------------

/** GAP competition parameters (S7F 2026 §5) — set once per competition. */
export interface GAPParameters {
  /** Expected task distance in meters (§5.1) */
  nominalDistance: number;
  /** Expected task duration in seconds (§5.3; default 5400 = 90 min) */
  nominalTime: number;
  /** Minimum scored distance in meters (§5.2; default 5000) */
  minimumDistance: number;
  /** Sport type — affects arrival points and some weight calculations */
  scoring: 'PG' | 'HG';
  /** Whether to compute leading (departure) points (default true) */
  useLeading: boolean;
  /** Whether to compute arrival points (default true for HG, ignored for PG) */
  useArrival: boolean;
  /**
   * S7F 2026 §6.1/§11 "LeadingTimeRatio": the fraction (0–0.26) of the
   * non-distance weight allocated to leading points, for both disciplines.
   * Defaults per discipline (§11): 26% for PG, 17.5% for HG. For PG, when
   * nobody makes goal the *entire* non-distance weight goes to leading
   * regardless of this value (nobody can earn PG time points without goal).
   */
  leadingTimeRatio?: number;
  /**
   * Where scored task distance begins:
   * - 'takeoff' — measure from the route's first point through the SSS to
   *   goal, per FAI CIVL GAP / PWCA. The default. The first point is the
   *   first turnpoint's CENTRE regardless of its type or radius, so a
   *   take-off→SSS leg counts, and a task that begins at the SSS still
   *   carries the centre→boundary start radius.
   * - 'start'   — measure from the start (SSS) cylinder edge, excluding
   *   everything before the start crossing (the HGFA/SAFA rule wording;
   *   "Move Origin" in the Davis/SeeYou hang-gliding toolchain). See
   *   XCTask.firstTurnpointAtBoundary.
   *
   * The two differ by the distance from the route's first point to the
   * start cylinder's edge: the take-off→SSS leg when a TAKEOFF turnpoint
   * exists, or exactly the start radius when the route begins at the SSS.
   */
  distanceOrigin: DistanceOrigin;
  /**
   * Hang-gliding "distance difficulty" (S7F 2026 §12.1.1). When true (the
   * default), HG distance points are half linear + half difficulty, where
   * the difficulty half rewards flying past clusters of landed-out pilots.
   * When false, HG uses a pure linear distance fraction. Has no effect on
   * paragliding — the FAI spec excludes difficulty for PG, so PG is always
   * pure linear.
   */
  useDistanceDifficulty: boolean;
  /**
   * Hang-gliding "jump the gun" (S7F 2026 §13.3): seconds of early start
   * per 1 penalty point (the spec's X; default 2). Only applies to HG in
   * gated races — a PG early starter is instead scored only for the
   * launch→SSS distance.
   */
  jumpTheGunFactor: number;
  /**
   * Hang-gliding "jump the gun" (S7F 2026 §13.3): maximum seconds a pilot
   * may start early and still be scored for the complete flight (the
   * spec's Y; default 300). Beyond this the pilot is scored for minimum
   * distance only.
   */
  jumpTheGunMaxSeconds: number;
  /**
   * Hang-gliding "ESS but not goal" (S7F 2026 §13.2): the fraction of time
   * and arrival points KEPT by a pilot who reaches the end of the speed
   * section but fails to reach goal (reaching goal "validates" the speed
   * section). The spec recommends 0.8 for hang gliders; local regulations
   * may change it. Paragliding is fixed at 0 by the spec (no goal → no
   * time points), so this setting never affects PG scoring — the engine
   * treats PG as factor 0 regardless of the configured value.
   */
  essNotGoalFactor: number;
}

/**
 * Leading coefficient variant (S7F 2026 §12.3.1). The 2026 edition pins the
 * variant per discipline — 'classic' (squared-distance) for hang gliding,
 * 'weighted' (weighted-area) for paragliding — so this is no longer a
 * parameter; use {@link leadingFormulaFor}.
 */
export type LeadingFormula = 'classic' | 'weighted';

/** The §12.3.1 leading-coefficient variant for a discipline. */
export function leadingFormulaFor(scoring: 'PG' | 'HG'): LeadingFormula {
  return scoring === 'PG' ? 'weighted' : 'classic';
}

/** The §11 default LeadingTimeRatio for a discipline. */
export function defaultLeadingTimeRatio(scoring: 'PG' | 'HG'): number {
  return scoring === 'PG'
    ? DEFAULT_LEADING_TIME_RATIO_PG
    : DEFAULT_LEADING_TIME_RATIO_HG;
}

/**
 * The effective §11 LeadingTimeRatio for a parameter set: the stored value
 * clamped to the spec's 0..26% range, or the discipline default when unset.
 */
export function resolveLeadingTimeRatio(
  params: Pick<GAPParameters, 'leadingTimeRatio' | 'scoring'>,
): number {
  const ltr = params.leadingTimeRatio;
  if (ltr == null || !Number.isFinite(ltr)) {
    return defaultLeadingTimeRatio(params.scoring);
  }
  return Math.min(MAX_LEADING_TIME_RATIO, Math.max(0, ltr));
}

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
  nominalDistance: 70000,
  nominalTime: 5400,
  minimumDistance: 5000,
  scoring: 'HG',
  useLeading: false,
  useArrival: false,
  distanceOrigin: 'takeoff',
  useDistanceDifficulty: true,
  jumpTheGunFactor: 2,
  jumpTheGunMaxSeconds: 300,
  essNotGoalFactor: 0.8,
};

/**
 * Scoring-defaults preset. Only the current FAI / CIVL GAP formula (S7F
 * 2026) is implemented today; future presets (e.g. an Australian SAFA
 * variant that runs leading/arrival off) slot in here without changing call
 * sites.
 */
export type ScoringPreset = 'fai';

/**
 * The recommended default GAP parameters for a new competition of the given
 * category, per the FAI Sporting Code S7F 2026 edition. These are the
 * "official" settings a comp starts from, before any organiser override:
 *
 * - Leading (departure) points: on for both PG and HG — part of the S7F score.
 * - Arrival points: on for HG, off for PG (S7F arrival applies to HG only).
 * - Distance difficulty: on for HG, off for PG (§12.1.1; PG is pure-linear).
 * - LeadingTimeRatio: the §11 defaults — 26% PG, 17.5% HG.
 * - ESS-but-not-goal (§13.2): 0.8 HG (recommended default), 0 PG (fixed).
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
    useLeading: true,
    useArrival: !pg,
    useDistanceDifficulty: !pg,
    leadingTimeRatio: pg
      ? DEFAULT_LEADING_TIME_RATIO_PG
      : DEFAULT_LEADING_TIME_RATIO_HG,
    // §13.2 fixes the PG ESS-but-not-goal parameter at 0 (no goal → no
    // time points); the HG recommended default is 0.8. The engine ignores
    // the value for PG either way — this keeps the displayed default honest.
    essNotGoalFactor: pg ? 0 : 0.8,
  };
}

/** The GAPParameters keys a stored gap_params JSON is allowed to set. */
const STORED_PARAM_KEYS = [
  'nominalDistance',
  'nominalTime',
  'minimumDistance',
  'scoring',
  'useLeading',
  'useArrival',
  'leadingTimeRatio',
  'distanceOrigin',
  'useDistanceDifficulty',
  'jumpTheGunFactor',
  'jumpTheGunMaxSeconds',
  'essNotGoalFactor',
] as const satisfies ReadonlyArray<keyof GAPParameters>;

/**
 * Merge a competition's stored GAP parameters over the official per-category
 * defaults, resolving the effective parameter set the scorer (and the score
 * explainer) should use.
 *
 * Stored gap_params saved under earlier editions may carry keys the 2026
 * surface no longer exposes (nominalLaunch, nominalGoal, scoreBackTime,
 * leadingFormula, leadingWeightFormula, timePointsExponent). They are
 * accepted and IGNORED — every task scores under the 2026 edition.
 *
 * @param category - 'hg' or 'pg' (drives {@link defaultsFor})
 * @param stored - the comp's saved gap_params, or null when it never saved any
 */
export function resolveCompGapParams(
  category: 'hg' | 'pg',
  stored: Partial<GAPParameters> | null,
): GAPParameters {
  const merged: GAPParameters = defaultsFor(category);
  if (stored) {
    for (const key of STORED_PARAM_KEYS) {
      const value = (stored as Partial<Record<string, unknown>>)[key];
      if (value !== undefined) {
        (merged as unknown as Record<string, unknown>)[key] = value;
      }
    }
  }
  return merged;
}
