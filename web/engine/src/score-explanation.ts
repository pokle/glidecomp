/**
 * Score explanation builder.
 *
 * Turns a pilot's scored result into a structured, human-readable
 * explanation of every decision that shaped the score: the flight
 * narrative (start crossings — including re-entries and which crossing
 * was scored — turnpoint reachings, ESS, goal or best progress), the
 * task validity and available points, and each point component with the
 * formula and its substituted inputs.
 *
 * The output is pure data (sections -> items) so it can be unit-tested,
 * rendered as prose by any UI, and each item can carry a map anchor
 * (coordinates + time) so the UI can show the supporting evidence on a
 * map.
 *
 * Authoritative point values come from the caller (the published score);
 * this module never re-scores — it explains the numbers it is given,
 * deriving only presentation values (fractions, formula substitutions)
 * from the same inputs the scorer used.
 *
 * The output/input types live in ./score-explanation-types, the formatting
 * helpers in ./score-explanation-format, and the per-section builders in
 * ./score-explanation-sections; this module composes them into the three
 * public entry points and re-exports the vocabulary.
 */

import { fixAltitude } from './igc-parser';
import type { GAPParameters } from './gap-scoring';
import { DEFAULT_GAP_PARAMETERS } from './gap-scoring';
import type { TurnpointSequenceResult } from './turnpoint-sequence';
import { km, pts, fmtPoints, duration, defaultFormatTime } from './score-explanation-format';
import {
  buildFlightSection,
  buildValiditySection,
  buildDistanceSection,
  buildTimeSection,
  buildLeadingSection,
  buildArrivalSection,
  buildArrivalEssNotGoalItems,
  buildComparisonSection,
  buildTotalSection,
  buildPenaltySection,
  buildManualFlightSection,
  buildWinnerHeadlineNote,
  noEssPointsZeroed,
} from './score-explanation-sections';
import {
  buildTimeChart,
  buildLeadingChart,
  buildArrivalChart,
  buildDistanceChart,
  buildLaunchValidityChart,
  buildTimeValidityChart,
  buildDistanceValidityChart,
} from './score-explanation-charts';
import type {
  ScoreExplanation,
  ScoreExplanationSection,
  ScoreExplanationItem,
  ScoreEntryInput,
  ExplainGapScoreInput,
  ExplainOpenDistanceInput,
  ExplainManualFlightInput,
} from './score-explanation-types';

export type {
  ExplanationAnchorKind,
  ExplanationAnchor,
  ScoreExplanationItem,
  ScoreExplanationSectionId,
  ScoreExplanationSection,
  ScoreExplanation,
  ScoreEntryInput,
  ClassContextInput,
  ExplainGapScoreInput,
  OpenDistanceAnchorInfo,
  ExplainOpenDistanceInput,
  ExplainManualFlightInput,
  ScoreChart,
  ScoreCurveChart,
  ScoreValidityChart,
  ScoreDistributionChart,
  ScoreDistributionPoint,
  ScoreDistributionMarker,
  ScoreChartPilot,
  ScoreChartPoint,
  ScoreChartXUnit,
} from './score-explanation-types';
export { turnpointLabel } from './score-explanation-sections';

/**
 * Attach a chart to a section, when there is one to attach.
 *
 * A null chart is the normal case, not a failure: a component whose curve
 * would not explain this pilot's own points (the §12.1 or §12.3.5 reductions)
 * deliberately gets no chart, and the section's prose still explains the
 * score. See score-explanation-charts.ts.
 */
function withChart(
  section: ScoreExplanationSection,
  chart: ScoreExplanationSection['chart'] | null,
): ScoreExplanationSection {
  return chart ? { ...section, chart } : section;
}

/**
 * Attach small charts to individual rows of a section.
 *
 * The validity section is a table of three factors and a total, and each
 * factor wants its own sparkline — a section-level chart would have to
 * explain all three at once, which is exactly the conflation the rows exist
 * to avoid. Done here rather than inside buildValiditySection so the section
 * builders stay free of the chart module.
 */
function withItemCharts(
  section: ScoreExplanationSection,
  charts: Record<string, ScoreExplanationSection['chart'] | null>,
): ScoreExplanationSection {
  return {
    ...section,
    items: section.items.map((item) => {
      const chart = charts[item.id];
      return chart ? { ...item, chart } : item;
    }),
  };
}

/**
 * Does this card get an arrival section?
 *
 * Normally when there were arrival points to win, or the pilot won some. The
 * third case is FAI S7F §10: on an HG task with arrival points switched on
 * where nobody reached ESS, the available figure is now zero, and dropping the
 * section would delete the only place that says why the component is missing —
 * exactly what the reader of a no-ESS day came for.
 */
function showsArrival(
  entry: ScoreEntryInput,
  classContext: ExplainGapScoreInput['classContext'],
  params: GAPParameters,
): boolean {
  return (
    classContext.available_points.arrival > 0 ||
    entry.arrival_points > 0 ||
    (params.useArrival && noEssPointsZeroed(classContext, params))
  );
}

/**
 * Explain a GAP-scored pilot's result.
 *
 * The narrative uses the pilot's resolved turnpoint sequence; the point
 * values come from the published score entry so the explanation always
 * matches the scoreboard.
 */
export function explainGapScore(input: ExplainGapScoreInput): ScoreExplanation {
  const { task, result, entry, classContext } = input;
  const params: GAPParameters = { ...DEFAULT_GAP_PARAMETERS, ...input.params };
  const fmt = input.formatTime ?? defaultFormatTime;

  const sections: ScoreExplanationSection[] = [
    buildFlightSection(task, result, entry, fmt),
    withItemCharts(buildValiditySection(classContext, params), {
      'launch-validity': buildLaunchValidityChart(classContext, params),
      'time-validity': buildTimeValidityChart(classContext, params),
      'distance-validity': buildDistanceValidityChart(entry, classContext, params),
    }),
    withChart(
      buildDistanceSection(entry, classContext, result, params),
      buildDistanceChart(entry, classContext, params),
    ),
    withChart(
      buildTimeSection(entry, classContext, params, result, fmt),
      buildTimeChart(entry, classContext, params),
    ),
  ];

  if (classContext.available_points.leading > 0 || entry.leading_points > 0) {
    sections.push(
      withChart(
        buildLeadingSection(entry, classContext, params),
        buildLeadingChart(entry, classContext),
      ),
    );
  }

  if (showsArrival(entry, classContext, params)) {
    sections.push(
      withChart(
        buildArrivalSection(entry, classContext, params, fmt),
        buildArrivalChart(entry, classContext),
      ),
    );
  }

  const penalty = buildPenaltySection(entry, params.jumpTheGunFactor);
  if (penalty) sections.push(penalty);
  sections.push(buildTotalSection(entry, classContext.available_points.total));
  // After the total, deliberately: the reader needs their own arithmetic to
  // add up before being shown what it cost them against the winner.
  const comparison = buildComparisonSection(entry, classContext);
  if (comparison) sections.push(comparison);

  let headline: string;
  if (entry.early_start_outcome === 'pg_launch_to_sss') {
    headline = `Early start — scored to the start cylinder only — ${entry.total_score} points`;
  } else if (entry.early_start_outcome === 'hg_min_distance') {
    headline = `Early start beyond the limit — scored minimum distance — ${entry.total_score} points`;
  } else if (entry.made_goal && entry.speed_section_time !== null) {
    headline = `Made goal in ${duration(entry.speed_section_time)} — ${entry.total_score} points`;
  } else if (entry.made_goal) {
    headline = `Made goal — ${entry.total_score} points`;
  } else if (result.sssReaching) {
    headline = `Landed out at ${km(entry.flown_distance)} — ${entry.total_score} points`;
  } else {
    headline = `No valid start — ${entry.total_score} points`;
  }

  const headlineNote = buildWinnerHeadlineNote(entry, classContext);
  return {
    format: 'gap',
    headline,
    ...(headlineNote ? { headlineNote } : {}),
    sections,
  };
}

// ---------------------------------------------------------------------------
// Open-distance explanation
// ---------------------------------------------------------------------------

/**
 * Explain an open-distance-scored pilot's result: where the scored line
 * starts (the launch cylinder edge, toward the furthest point), where it
 * ends (the furthest fix), and how that becomes the score.
 */
export function explainOpenDistanceScore(
  input: ExplainOpenDistanceInput,
): ScoreExplanation {
  const { task, geometry, fixes, entry } = input;
  const fmt = input.formatTime ?? defaultFormatTime;
  const launchRadius = task.turnpoints[0]?.radius ?? 0;

  const items: ScoreExplanationItem[] = [];

  if (!geometry || entry.flown_distance <= 0) {
    items.push({
      id: 'no-exit',
      text: `The flight never left the ${km(launchRadius)} launch cylinder — open distance is measured from the cylinder edge, so the flight scores 0.`,
      emphasis: 'warning',
    });
  } else {
    const furthestFix = fixes?.[geometry.furthest.fixIndex];
    // The origin is the cylinder edge toward the furthest point — a derived
    // point, not a track fix, so it carries no time/altitude of its own
    // (anchorInfo may still supply them for older cached analyses).
    const originTimeMs = input.anchorInfo?.origin?.timeMs;
    const originAltitude = input.anchorInfo?.origin?.altitude;
    const furthestTimeMs =
      input.anchorInfo?.furthest?.timeMs ?? furthestFix?.time.getTime();
    const furthestAltitude =
      input.anchorInfo?.furthest?.altitude ??
      (furthestFix ? fixAltitude(furthestFix) : undefined);
    items.push({
      id: 'origin',
      text: input.manual
        ? `Take-off cylinder exit — the scored distance starts at the ${km(launchRadius)} take-off cylinder edge, toward the landing point.`
        : `The scored distance starts at the ${km(launchRadius)} launch cylinder edge, toward the furthest point — leaving the cylinder starts the score; where it was crossed (or crossed again later) doesn't matter.`,
      value: originTimeMs !== undefined ? fmt(new Date(originTimeMs)) : undefined,
      anchor: {
        kind: 'origin',
        latitude: geometry.origin.latitude,
        longitude: geometry.origin.longitude,
        altitude: originAltitude,
        timeMs: originTimeMs,
      },
    });
    items.push({
      id: 'furthest',
      text: input.manual
        ? 'Recorded landing point — the scored distance ends here.'
        : 'Furthest point reached from launch — the scored distance ends here.',
      value: furthestTimeMs !== undefined ? fmt(new Date(furthestTimeMs)) : undefined,
      anchor: {
        kind: 'furthest',
        latitude: geometry.furthest.latitude,
        longitude: geometry.furthest.longitude,
        altitude: furthestAltitude,
        timeMs: furthestTimeMs,
      },
    });
    items.push({
      id: 'distance',
      text: 'Straight-line distance between the two points',
      value: km(entry.flown_distance),
      detail: 'WGS84 ellipsoid distance — the score is this distance in metres.',
    });
  }

  const sections: ScoreExplanationSection[] = [
    {
      id: 'flight',
      title: 'The flight',
      summary: 'Open distance: fly as far as possible from the launch cylinder edge.',
      items,
    },
  ];

  const penalty = buildPenaltySection(entry);
  if (penalty) sections.push(penalty);

  sections.push({
    id: 'total',
    title: 'Total',
    points: entry.total_score,
    items: [
      {
        id: 'total-sum',
        text: 'The score is the flown distance in metres, minus any penalty',
        value: `${entry.total_score} pts`,
        detail:
          entry.penalty_points !== 0
            ? `${Math.round(entry.flown_distance)} ${entry.penalty_points > 0 ? '−' : '+'} ${Math.abs(entry.penalty_points)} penalty = ${entry.total_score}`
            : `${Math.round(entry.flown_distance)} m flown = ${entry.total_score} points`,
      },
    ],
  });

  const headline =
    entry.flown_distance > 0
      ? `Flew ${km(entry.flown_distance)} open distance — ${entry.total_score} points`
      : `Never left the launch cylinder — ${entry.total_score} points`;

  return { format: 'open_distance', headline, sections };
}

/**
 * Explain a manual-flight-scored pilot's result (FAI S7F §8.4). The narrative
 * states the last turnpoint reached and the landing point (with the routed
 * distance-to-goal line on the map); the point-component sections reuse the
 * same GAP builders, driven by the authoritative published score entry, so the
 * numbers always match the scoreboard.
 */
export function explainManualFlightScore(
  input: ExplainManualFlightInput,
): ScoreExplanation {
  const { task, geometry, entry, classContext } = input;
  const params: GAPParameters = { ...DEFAULT_GAP_PARAMETERS, ...input.params };

  // The point-component builders read only a few fields off a turnpoint result
  // (flownDistance for the minimum-distance caveat; startGate / sssReaching for
  // the gated-race note, both absent for a manual flight). Feed them a synthetic
  // result so a manual flight reuses the exact same points prose as a track.
  const synthResult: TurnpointSequenceResult = {
    crossings: [],
    sequence: [],
    sssReaching: null,
    essReaching: null,
    madeGoal: geometry.madeGoal,
    lastTurnpointReached: geometry.lastReachedIndex,
    bestProgress: null,
    taskDistance: geometry.madeGood + geometry.distanceToGoal,
    flownDistance: geometry.madeGood,
    legs: [],
    speedSectionTime: entry.speed_section_time ?? null,
  };

  const sections: ScoreExplanationSection[] = [
    buildManualFlightSection(task, geometry, entry),
    withItemCharts(buildValiditySection(classContext, params), {
      'launch-validity': buildLaunchValidityChart(classContext, params),
      'time-validity': buildTimeValidityChart(classContext, params),
      'distance-validity': buildDistanceValidityChart(entry, classContext, params),
    }),
    buildDistanceSection(entry, classContext, synthResult, params),
    buildTimeSection(entry, classContext, params, synthResult, defaultFormatTime),
  ];

  if (classContext.available_points.leading > 0 || entry.leading_points > 0) {
    // Not buildLeadingSection: a manual flight has no track to measure a
    // leading coefficient from, so there is no arithmetic to show and the
    // reason for the zero is the whole explanation.
    sections.push({
      id: 'leading',
      title: 'Leading points',
      points: entry.leading_points,
      ...(classContext.available_points.leading > 0
        ? { pointsAvailable: classContext.available_points.leading }
        : {}),
      docHref: '/scoring/gap#leading-points',
      items: [
        {
          id: 'leading',
          text: 'Leading points reward flying out front during the speed section. A manual flight has no tracklog to measure leading from, so it earns none.',
          value: pts(entry.leading_points),
        },
      ],
    });
  }

  if (showsArrival(entry, classContext, params)) {
    sections.push(buildArrivalSection(entry, classContext, params));
  }

  const penalty = buildPenaltySection(entry, params.jumpTheGunFactor);
  if (penalty) sections.push(penalty);
  sections.push(buildTotalSection(entry, classContext.available_points.total));
  const comparison = buildComparisonSection(entry, classContext);
  if (comparison) sections.push(comparison);

  const headline = geometry.madeGoal
    ? `Manual flight — made goal — ${fmtPoints(entry.total_score)} points`
    : `Manual flight — ${km(entry.flown_distance)} made good — ${fmtPoints(entry.total_score)} points`;

  const headlineNote = buildWinnerHeadlineNote(entry, classContext);
  return {
    format: 'gap',
    headline,
    ...(headlineNote ? { headlineNote } : {}),
    sections,
  };
}

/**
 * Explain a pilot whose tracklog a HARD data-quality check withheld from
 * scoring (track-quality.ts, FAI S7A §4.4.2).
 *
 * There is nothing to explain about points here — there is no valid flight to
 * measure — so this deliberately does NOT run the normal turnpoint narrative:
 * reviving a sequence from a track that isn't this task's produces confident,
 * meaningless prose ("landed out at 0.0 km") about a file from somewhere else.
 * The reader needs the findings and the remedy instead.
 *
 * Reuses the existing 'flight' and 'total' section ids, so every consumer
 * (SSR, the SPA, the CLI) renders it with no new cases.
 */
export function explainExcludedTrack(input: {
  entry: ScoreEntryInput;
  /** The hard findings' titles and details, in detector order. */
  findings: { title: string; detail: string }[];
}): ScoreExplanation {
  const items: ScoreExplanationItem[] = input.findings.map((f, i) => ({
    id: `quality-${i}`,
    text: f.title,
    detail: f.detail,
    emphasis: 'warning',
  }));
  items.push({
    id: 'quality-remedy',
    text:
      'Until this is resolved the flight scores nothing. Upload the correct ' +
      'tracklog for this task, or ask the scorekeeper to review it — under FAI ' +
      'S7A §4.4.6 accepting or rejecting a track log is the organiser’s decision, ' +
      'and they can overrule this check.',
  });

  return {
    format: 'gap',
    headline: `Tracklog excluded from scoring — ${fmtPoints(input.entry.total_score)} points`,
    sections: [
      { id: 'flight', title: 'Why this tracklog was excluded', items },
      buildTotalSection(input.entry),
    ],
  };
}
