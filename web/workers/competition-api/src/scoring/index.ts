/**
 * The scoring path.
 *
 * `scoring/` is layered bottom-up, and the layering is what keeps the two
 * things that must never disagree — the published score and the per-pilot
 * explanation of it — provably in step:
 *
 *   types      the shapes, imported by everything, importing nothing
 *   geom-hash  the cache keys, so no pass can invent its own format
 *   track-store  R2 + the `track_analysis` table + the data-quality interlock
 *   config     the one place a task's parameters and field are resolved
 *   class-score  penalties, ranking, and the response shape
 *   task-score   the two scoring formats
 *
 * This module re-exports what the rest of the worker uses. Reaching past it
 * into a specific module is fine and often clearer — it is a convenience, not
 * a boundary.
 */

export { computeScoreStateKey } from "./state-key";
export { shortHash } from "./geom-hash";
export {
  excludedPilotsByClass,
  hardFindingTitles,
  mergeStoredGapParamsJson,
  partitionByQuality,
  resolveTaskGeometry,
  resolveTaskScoringConfig,
} from "./config";
export { rankByTotalScore } from "./class-score";
export { fetchIgcFile, fetchIgcFixes } from "./track-store";
export { computeTaskScore } from "./task-score";

export type {
  ClassScore,
  ClassStoppedInfo,
  ClassValidityInputs,
  ExcludedPilot,
  OfficialResultsWire,
  PilotScoreEntry,
  ScoredTrackRow,
  StoredOfficialResults,
  TaskScoreResponse,
  TaskScoringConfig,
  TaskScoringGeometry,
} from "./types";
