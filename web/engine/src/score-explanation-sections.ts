/**
 * Score-explanation section builders — the entry module.
 *
 * Turns a scored result into the flight-narrative, validity, per-component,
 * penalty, and total sections (plus the task-position labels/anchors they
 * use). The public explain* entry points in ./score-explanation compose these.
 *
 * The builders themselves live one per concern under ./sections — `shared`
 * (task-position vocabulary and the published-payload adapters), `flight`,
 * `validity`, `distance`, `time`, `leading`, `arrival`, `rank`, `totals`,
 * `comparison` and `penalty`. This module is the door: it re-exports exactly
 * the names the rest of the engine reads, so a caller never has to know which
 * file a section was built in.
 */

export { bestTimeCandidate, leadingWeightDetail, turnpointLabel } from './sections/shared';
export { buildFlightSection, buildManualFlightSection } from './sections/flight';
export { buildValiditySection } from './sections/validity';
export { buildDistanceSection } from './sections/distance';
export { buildTimeSection } from './sections/time';
export { buildLeadingSection, leadingVariantSentence } from './sections/leading';
export { buildArrivalEssNotGoalItems, buildArrivalSection } from './sections/arrival';
export { buildTotalSection } from './sections/totals';
export { buildComparisonSection, buildWinnerHeadlineNote } from './sections/comparison';
export { buildPenaltySection } from './sections/penalty';
