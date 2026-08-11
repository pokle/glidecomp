/**
 * What one tracklog says about the flight it holds — enough for a person who
 * has just uploaded a file to recognise it as the right one.
 *
 * This exists because the answer a pilot actually wants ("did my flight get
 * in?") is minutes away: scoring is deferred to a background revalidation and
 * depends on everyone else's tracks too. A summary the upload can return
 * immediately closes that gap, and it is the only chance to catch yesterday's
 * file before it quietly scores as today's.
 *
 * Deliberately cheap. It composes the takeoff/landing detector and the track
 * distance sum — NOT detectFlightEvents, which additionally runs thermal,
 * glide and circle detection and costs far more than this needs.
 *
 * Every derived field is nullable. This summarises whatever the file happens
 * to carry; a value that could not be determined is absent rather than zero,
 * because a confidently wrong "0 km" is worse than a blank.
 *
 * Times are epoch milliseconds (UTC). Rendering them in the competition's zone
 * is the caller's job — the engine holds no timezone opinion, and the SSR and
 * client trees must format identically.
 *
 * Header strings arrive already sanitised by the parser (igc-parser.ts, via
 * sanitizeText). Do not sanitise them again — that double-encodes.
 */

import { fixAltitude, type IGCFile, type IGCFix } from './igc-parser';
import { calculateTrackDistance } from './geo';
import { detectTakeoffLandingIndices } from './takeoff-landing-detector';
import { DEFAULT_THRESHOLDS, type DetectionThresholds } from './thresholds';

export interface FlightSummary {
  /**
   * The day the file claims, from its HFDTE header, as YYYY-MM-DD.
   *
   * Null when the header carried no parseable date — in which case the parser
   * stamps the fixes with the PARSE day, so `takeoffMs`/`landingMs` below are
   * a time of day and NOT evidence of a date. Track quality reports the same
   * condition as `headerDateMissing`.
   */
  flightDate: string | null;
  takeoffMs: number | null;
  landingMs: number | null;
  /**
   * Null unless BOTH takeoff and landing were detected — half a duration is a
   * wrong duration, not a partial one.
   */
  durationSeconds: number | null;
  /** Always present when the file has fixes: what a reader falls back to when
   * detection found nothing, which is why it is reported separately. */
  firstFixMs: number | null;
  lastFixMs: number | null;
  /** Ground track length in metres, over the airborne slice where one was
   * found. Andoyer, via geo.ts — never inline geo maths. */
  trackLengthMeters: number | null;
  /** False when detection failed and the length therefore covers the whole
   * file, walk to launch included. */
  trackLengthIsAirborneOnly: boolean;
  /** Highest fixAltitude() in metres — never raw gnssAltitude, or a single
   * dropout fix reads as sea level. */
  maxAltitudeMeters: number | null;
  maxAltitudeAboveTakeoffMeters: number | null;
  fixCount: number;
  /** A one-fix-per-minute file looks fine until it is scored. */
  medianFixIntervalSeconds: number | null;
  headerPilotName: string | null;
  headerGliderType: string | null;
  headerGliderId: string | null;
  headerCompetitionId: string | null;
}

/** The summary of a file with nothing in it. */
const EMPTY_SUMMARY: FlightSummary = {
  flightDate: null,
  takeoffMs: null,
  landingMs: null,
  durationSeconds: null,
  firstFixMs: null,
  lastFixMs: null,
  trackLengthMeters: null,
  trackLengthIsAirborneOnly: false,
  maxAltitudeMeters: null,
  maxAltitudeAboveTakeoffMeters: null,
  fixCount: 0,
  medianFixIntervalSeconds: null,
  headerPilotName: null,
  headerGliderType: null,
  headerGliderId: null,
  headerCompetitionId: null,
};

/** Placeholder header values that mean "the logger was never configured". */
const PLACEHOLDER_HEADER = /^(not[ _-]?set|unknown|pilot|n\/?a|none|-+)$/i;

function headerValue(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed || PLACEHOLDER_HEADER.test(trimmed)) return null;
  return trimmed;
}

/** YYYY-MM-DD in UTC, which is the frame the HFDTE date was parsed into. */
function toDateString(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * The airborne window, by the same rule the field analysis uses: take the
 * detector's takeoff/landing indices, and fall back to the whole file when
 * they are missing or the wrong way round.
 */
function airborneWindow(
  fixes: IGCFix[],
  thresholds: DetectionThresholds
): { takeoffIndex: number; landingIndex: number; detected: boolean } {
  const { takeoff, landing } = detectTakeoffLandingIndices(fixes, thresholds);
  const takeoffIndex = takeoff?.fixIndex ?? 0;
  const landingIndex = landing?.fixIndex ?? fixes.length - 1;

  // The detector's two scans are independent, so it does not guarantee the
  // landing follows the takeoff (see TakeoffLandingDetection). An inverted —
  // or empty — window is no window: fall back to the whole file.
  if (landingIndex <= takeoffIndex) {
    return { takeoffIndex: 0, landingIndex: fixes.length - 1, detected: false };
  }
  return { takeoffIndex, landingIndex, detected: takeoff !== null && landing !== null };
}

/**
 * The median gap between consecutive fixes, which is what tells a reader
 * whether the logger was recording once a second or once a minute. Median
 * rather than mean so one mid-flight dropout does not dominate.
 */
function medianInterval(fixes: IGCFix[], start: number, end: number): number | null {
  if (end - start < 1) return null;
  const gaps: number[] = [];
  for (let i = start; i < end; i++) {
    const gap = (fixes[i + 1].time.getTime() - fixes[i].time.getTime()) / 1000;
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  return gaps.length % 2 === 0 ? (gaps[mid - 1] + gaps[mid]) / 2 : gaps[mid];
}

/**
 * Summarise a parsed tracklog.
 *
 * Takes the whole `IGCFile` so a caller that has already parsed hands over its
 * one parse result rather than paying for a second.
 */
export function summariseFlight(
  igc: IGCFile,
  thresholds: DetectionThresholds = DEFAULT_THRESHOLDS
): FlightSummary {
  const header = {
    headerPilotName: headerValue(igc.header.pilot),
    headerGliderType: headerValue(igc.header.gliderType),
    headerGliderId: headerValue(igc.header.gliderId),
    headerCompetitionId: headerValue(igc.header.competitionId),
    flightDate:
      igc.header.date instanceof Date && !Number.isNaN(igc.header.date.getTime())
        ? toDateString(igc.header.date)
        : null,
  };

  const fixes = igc.fixes;
  if (fixes.length === 0) return { ...EMPTY_SUMMARY, ...header };

  const { takeoffIndex, landingIndex, detected } = airborneWindow(fixes, thresholds);

  let maxAltitude = fixAltitude(fixes[0]);
  for (const fix of fixes) {
    const alt = fixAltitude(fix);
    if (alt > maxAltitude) maxAltitude = alt;
  }
  const takeoffAltitude = fixAltitude(fixes[takeoffIndex]);

  return {
    ...header,
    takeoffMs: detected ? fixes[takeoffIndex].time.getTime() : null,
    landingMs: detected ? fixes[landingIndex].time.getTime() : null,
    durationSeconds: detected
      ? (fixes[landingIndex].time.getTime() - fixes[takeoffIndex].time.getTime()) / 1000
      : null,
    firstFixMs: fixes[0].time.getTime(),
    lastFixMs: fixes[fixes.length - 1].time.getTime(),
    trackLengthMeters: calculateTrackDistance(fixes, takeoffIndex, landingIndex),
    trackLengthIsAirborneOnly: detected,
    maxAltitudeMeters: maxAltitude,
    maxAltitudeAboveTakeoffMeters: maxAltitude - takeoffAltitude,
    fixCount: fixes.length,
    medianFixIntervalSeconds: medianInterval(fixes, takeoffIndex, landingIndex),
  };
}
