// Copyright (c) 2026, Tushar Pokle.  All rights reserved.
/**
 * Map a legacy-AirScore formula block (as published by xc.highcloud.net's
 * `get_task_result.php`, saved verbatim in each task folder's
 * `airscore-result-raw.json`) onto GlideComp GAP parameters, so imported
 * competitions seed with the settings AirScore actually scored them with
 * rather than today's defaults.
 *
 * SCRIPT-SIDE ON PURPOSE: the engine must not know the legacy AirScore
 * vocabulary; only the importer does. The semantics below were verified
 * against the legacy Perl scoring source (geoffwong/airscore: Gap.pm,
 * GGap.pm, get_task_result.php) and empirically against published task
 * results — see docs/2026-07-21-airscore-history-import-plan.md ("Legacy
 * vocabulary inventory") for the full derivation. The key facts:
 *
 * - `formula` is `forClass-forVersion` ("gap-2018", "ggap-2018", "gap-hg2013").
 *   Version < 2020 scored time points with the classic 2/3-exponent curve
 *   (verified against Corryong 2021's published points); 2020+ uses 5/6.
 * - `goal_penalty` is the legacy `forGoalSSpenalty`: the fraction of speed
 *   AND arrival points LOST by a pilot who reaches ESS but not goal
 *   (`Pspeed -= Pspeed * sspenalty` in Gap.pm). GlideComp's
 *   essNotGoalFactor is the fraction KEPT, so factor = 1 − goal_penalty.
 * - `departure` is per task: 'off' | 'Dpt' (classic time-delay departure
 *   points) | 'Ldo' (lead-out, LC-based) | 'Lkm' (km-marker bonus). Only
 *   'Ldo' maps onto GlideComp leading points; 'Dpt'/'Lkm' are unimplemented.
 * - `arrival` (on/off, per task) is the real arrival switch;
 *   `arrival_scoring` ('place' | 'timed') only picks the curve when it's on.
 *   The published `height_bonus` is a legacy PHP publishing bug (it copies
 *   the arrival flag) — the real ESS-height-bonus flag is the task block's
 *   `hbess`.
 * - `error_margin` is the per-comp cylinder tolerance fraction (0.0005 =
 *   0.05%); GlideComp's task files carry it natively (XCTask.cylinderTolerance).
 *
 * Every value this mapper can't faithfully express produces a WARNING, not a
 * silent default — the warnings are recorded in the comp manifest and belong
 * in the import's parity report.
 */

import type { GAPParameters } from '@glidecomp/engine';

/** The `formula` block of a legacy-AirScore published task result, verbatim. */
export interface AirscoreFormulaBlock {
  formula?: string;
  goal_penalty?: string;
  nominal_goal?: string;
  minimum_distance?: string;
  nominal_distance?: string;
  nominal_time?: string;
  arrival_scoring?: string;
  departure?: string;
  arrival?: string;
  height_bonus?: string;
  stop_glide_bonus?: string;
  start_weight?: string;
  arrival_weight?: string;
  speed_weight?: string;
  scale_to_validity?: string;
  error_margin?: number;
}

export interface MappedAirscoreFormula {
  /** GAP parameters for the task, ready to store. GlideComp scores every
   * task under the FAI S7F 2026 edition, so only the parameters that edition
   * still exposes are mapped; formula-generation differences (exponent,
   * leading-weight generation, nominal goal/launch) become warnings. */
  gapParams: Partial<GAPParameters>;
  /** Cylinder tolerance fraction for the task's xctsk (from error_margin),
   * or undefined when unpublished. */
  cylinderTolerance: number | undefined;
  /** Everything the published formula says that GlideComp cannot (or does
   * not) reproduce. Empty means the task should be exactly reproducible. */
  warnings: string[];
}

/** "35 km" → 35000 (metres); null when unparsable. */
function parseKm(v: string | undefined): number | null {
  if (!v) return null;
  const m = v.match(/^\s*([\d.]+)\s*km\s*$/i);
  return m ? Number(m[1]) * 1000 : null;
}

/** "30%" → 0.3; null when unparsable. */
function parsePercent(v: string | undefined): number | null {
  if (!v) return null;
  const m = v.match(/^\s*([\d.]+)\s*%\s*$/);
  return m ? Number(m[1]) / 100 : null;
}

/** "90 mins" → 5400 (seconds); null when unparsable. */
function parseMins(v: string | undefined): number | null {
  if (!v) return null;
  const m = v.match(/^\s*([\d.]+)\s*mins?\s*$/i);
  return m ? Number(m[1]) * 60 : null;
}

/**
 * Split "gap-2018" / "ggap-2018" / "gap-hg2013" into class + numeric year.
 * "hg2013" reads as 2013 (the HG GAP 2013 edition).
 */
export function parseFormulaName(
  formula: string | undefined,
): { cls: string; year: number | null } {
  if (!formula) return { cls: '', year: null };
  const m = formula.match(/^([a-z]+)-(?:[a-z]*)(\d{4})$/i);
  if (!m) return { cls: formula, year: null };
  return { cls: m[1].toLowerCase(), year: Number(m[2]) };
}

export function mapAirscoreFormula(
  block: AirscoreFormulaBlock,
  category: 'hg' | 'pg',
  taskInfo?: { hbess?: string },
): MappedAirscoreFormula {
  const warnings: string[] = [];
  const p: Partial<GAPParameters> = {};
  const { cls, year } = parseFormulaName(block.formula);

  // --- formula generation → parity warnings --------------------------------
  // GlideComp scores everything under the FAI S7F 2026 edition, so a comp
  // published under an earlier generation cannot be reproduced exactly; the
  // warnings record the known formula-level differences for the import's
  // parity report.
  if (cls === 'gap' && year !== null) {
    if (year < 2020) {
      warnings.push(
        `formula "${block.formula}" scored time points with the classic 2/3-exponent ` +
          'curve; GlideComp scores with the S7F 2026 5/6 exponent — time points will differ',
      );
    }
    if (category === 'pg' && year < 2025) {
      warnings.push(
        `PG formula "${block.formula}" used an earlier leading-weight generation; ` +
          'GlideComp applies the S7F 2026 §11 LeadingTimeRatio split — leading/time ' +
          'points will differ',
      );
    }
  } else if (cls === 'ggap') {
    // GGap.pm is Geoff Wong's own variant: median-based distance validity,
    // LINEAR distance quality, time curve 1−(Δt/√(Tmin/1800))^(2/3), and a
    // flat weightstart×1000 leading allocation off the top. None of that is
    // GAP; scores under it are not reproducible by the GAP engine.
    warnings.push(
      `formula "${block.formula}" is GGap (Geoff's GAP variant) — median distance validity, ` +
        'linear distance quality, √(Tmin/1800) time curve and flat leading weight are not ' +
        'reproducible; scored under the S7F 2026 formula instead',
    );
  } else {
    warnings.push(
      `unknown formula "${block.formula ?? '(missing)'}" — only nominal parameters mapped`,
    );
  }

  const gapYear = cls === 'gap' ? year : null;

  // --- nominal parameters --------------------------------------------------
  const nomDist = parseKm(block.nominal_distance);
  if (nomDist !== null) p.nominalDistance = nomDist;
  else if (block.nominal_distance !== undefined)
    warnings.push(`unparsable nominal_distance "${block.nominal_distance}"`);

  const minDist = parseKm(block.minimum_distance);
  if (minDist !== null) p.minimumDistance = minDist;
  else if (block.minimum_distance !== undefined)
    warnings.push(`unparsable minimum_distance "${block.minimum_distance}"`);

  const nomTime = parseMins(block.nominal_time);
  if (nomTime !== null) p.nominalTime = nomTime;
  else if (block.nominal_time !== undefined)
    warnings.push(`unparsable nominal_time "${block.nominal_time}"`);

  // Nominal goal is fixed at 30% in the S7F 2026 edition; a published value
  // that differs shifts the distance validity and cannot be reproduced.
  const nomGoal = parsePercent(block.nominal_goal);
  if (nomGoal !== null) {
    if (Math.abs(nomGoal - 0.3) > 1e-9) {
      warnings.push(
        `nominal_goal "${block.nominal_goal}" differs from the S7F 2026 fixed 30% — ` +
          'distance validity will differ',
      );
    }
  } else if (block.nominal_goal !== undefined) {
    warnings.push(`unparsable nominal_goal "${block.nominal_goal}"`);
  }

  // --- departure (leading) — per task --------------------------------------
  const departure = (block.departure ?? '').toLowerCase();
  switch (departure) {
    case 'off':
    case '':
      p.useLeading = false;
      break;
    case 'ldo':
    case 'leadout':
      p.useLeading = true;
      if (gapYear === null || gapYear <= 2022) {
        // Legacy AirScore computed pre-2023 lead-out points from the
        // LINEAR-area leading coefficient (tarLeadingCoeff); the
        // squared-distance/weighted LC (tarLeadingCoeff2) only applies to
        // version > 2022. GlideComp has no linear-area LC.
        warnings.push(
          'departure "Ldo" on a pre-2023 formula: legacy AirScore used the linear-area ' +
            'leading coefficient; GlideComp scores the classic squared-distance (HG) / ' +
            'weighted-area (PG) LC — leading points will differ',
        );
      }
      break;
    case 'dpt':
      p.useLeading = false;
      warnings.push(
        'departure "Dpt" (classic time-delay departure points) is not implemented — ' +
          'published scores include departure points GlideComp omits',
      );
      break;
    case 'lkm':
    case 'kmbonus':
      p.useLeading = false;
      warnings.push(
        'departure "Lkm" (km-marker bonus points) is not implemented — published scores ' +
          'include bonus points GlideComp omits',
      );
      break;
    default:
      warnings.push(`unknown departure mode "${block.departure}"`);
  }

  // --- arrival — per task --------------------------------------------------
  const arrival = (block.arrival ?? '').toLowerCase();
  if (arrival === 'on') {
    p.useArrival = true;
    if (category === 'pg') {
      warnings.push('PG arrival points: GlideComp scores paragliding without arrival points');
    }
    if ((block.arrival_scoring ?? '').toLowerCase() === 'timed') {
      warnings.push(
        'timed (OzGAP) arrival scoring is not implemented — GlideComp scores place-based ' +
          'arrival instead',
      );
    }
  } else if (arrival === 'off' || arrival === '') {
    p.useArrival = false;
  } else {
    warnings.push(`unknown arrival mode "${block.arrival}"`);
  }

  // --- ESS-but-not-goal ----------------------------------------------------
  if (block.goal_penalty !== undefined) {
    const lost = Number(block.goal_penalty);
    if (Number.isFinite(lost) && lost >= 0 && lost <= 1) {
      p.essNotGoalFactor = 1 - lost;
    } else {
      warnings.push(`unparsable goal_penalty "${block.goal_penalty}"`);
    }
  }

  // --- fidelity checks that don't map to a parameter -----------------------
  if (block.scale_to_validity !== undefined && Number(block.scale_to_validity) !== 0) {
    warnings.push('scale_to_validity is not implemented');
  }
  const glide = Number(block.stop_glide_bonus ?? 0);
  const engineGlide = category === 'pg' ? 2.5 : 5;
  if (Number.isFinite(glide) && glide > 0 && glide !== engineGlide) {
    warnings.push(
      `stopped-task glide bonus ${glide}:1 differs from the engine's spec-fixed ` +
        `${engineGlide}:1 for ${category} — only matters for stopped tasks`,
    );
  }
  if ((taskInfo?.hbess ?? 'off').toLowerCase() === 'on') {
    warnings.push('ESS height bonus (hbess) is not implemented');
  }

  return { gapParams: p, cylinderTolerance: block.error_margin, warnings };
}

/**
 * The subset of a mapped parameter set shared by every task of a comp — what
 * the comp row stores (and the settings dialog shows). Tasks store only their
 * differences from this base, so a comp-level edit still reaches every task
 * that didn't diverge.
 */
export function sharedGapParams(
  perTask: Array<Partial<GAPParameters>>,
): Partial<GAPParameters> {
  if (perTask.length === 0) return {};
  const shared: Record<string, unknown> = {};
  const first = perTask[0] as Record<string, unknown>;
  for (const key of Object.keys(first)) {
    const v = first[key];
    if (perTask.every((t) => (t as Record<string, unknown>)[key] === v)) {
      shared[key] = v;
    }
  }
  return shared as Partial<GAPParameters>;
}

/** A task's overrides: the mapped entries that differ from the shared base. */
export function taskGapParamOverrides(
  task: Partial<GAPParameters>,
  shared: Partial<GAPParameters>,
): Partial<GAPParameters> | null {
  const out: Record<string, unknown> = {};
  const t = task as Record<string, unknown>;
  const s = shared as Record<string, unknown>;
  for (const key of Object.keys(t)) {
    if (t[key] !== s[key]) out[key] = t[key];
  }
  return Object.keys(out).length > 0 ? (out as Partial<GAPParameters>) : null;
}
