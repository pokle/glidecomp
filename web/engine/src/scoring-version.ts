/**
 * The scoring engine's generation — the identity every scoring cache key is
 * folded around.
 *
 * The competition API stamps it on every cached scoring artefact (task
 * scores, comp scores, per-track analysis, per-pilot transparency), so
 * results computed by two different engine generations can never be served
 * side by side: a deploy that changes scoring behaviour rolls every key at
 * once. Because the engine is deterministic, a cached score and a cached
 * analysis under the same generation + inputs are guaranteed to agree — this
 * is what lets the score-details page present the narrative as exact, with no
 * "may not match the published score" hedging.
 *
 * **It is derived, not declared.** Both values below are a content hash over
 * the transitive import closure of the scoring entry modules, computed by
 * web/scripts/generate-scoring-fingerprint.ts and written into
 * ./scoring-fingerprint.generated.ts, which is gitignored. Change any file
 * that can affect a score and the generation changes on its own; change none
 * and it holds. There is nothing to bump and nothing to remember.
 *
 * This replaced a hand-maintained integer beside a hand-pasted hash. The
 * guard test that kept those two honest worked, but it put three merge
 * conflicts in this one file on every pair of parallel engine branches — and
 * the fingerprint conflict could not be resolved by picking a side, because a
 * hash over the MERGED tree matches neither parent. The correct value existed
 * on neither branch and had to be re-derived by hand after every single
 * merge. Deriving it makes the merged tree produce the right key by
 * construction. See docs/scoring-version.md.
 *
 * **Changing scoring behaviour still carries an obligation**, just not a
 * numeric one: write a note in web/engine/scoring-changes/ saying what moved
 * and why. That directory is this file's old changelog comment, one file per
 * change so two branches can never collide over it, and it is linked from
 * /scoring and /scoring/gap so a pilot whose points moved can read why. CI
 * enforces it — see web/scripts/check-scoring-change-note.ts.
 */
export {
  SCORING_ENGINE_VERSION,
  SCORING_SOURCE_FINGERPRINT,
} from './scoring-fingerprint.generated';
