# The engine generation is derived from the code

NO scoring change — every pilot's points are identical. This is a change to
how the engine's *generation* is identified, and it rolls every scoring cache
once as a side effect.

The generation used to be a hand-maintained integer (`SCORING_ENGINE_VERSION =
39`) beside a hand-pasted hash of the scoring sources, kept honest by a test
that failed until the two agreed. Both are gone. The generation is now the
leading 48 bits of that same hash, derived on every build, so a scoring change
rolls the caches on its own and there is nothing to bump.

The hash itself is computed exactly as before: the same 27-file import
closure, the same NUL-delimited construction. Run against master's tree it
reproduces the fingerprint recorded against change 039 byte for byte, which is
how the port was checked. The number the engine publishes changes from a
two-digit count to a 15-digit read-out of that hash, and this branch also
touches doc comments in two hashed sources (`format-distance.ts` among them,
to correct references to the machinery being replaced), so the fingerprint
moves for that reason too — a comment-only edit, no arithmetic anywhere near
it.

Every cached score, comp score, per-track analysis and per-pilot transparency
payload is therefore stale on deploy and recomputes. They recompute
**identically**: no scoring source changed, so the same inputs go through the
same code. The visible effect is a re-score pass across the site and nothing
else.

The reason for the change is that the two hand-maintained constants conflicted
between parallel engine branches, and the fingerprint conflict could not be
resolved by picking a side — a hash over the merged tree matches neither
parent, so the correct value existed on neither branch and had to be
re-derived by hand after every merge. Deriving it makes the merged tree
produce the right key by construction.

This changelog is the other half of that change: it used to be one comment
block at the top of `scoring-version.ts`, where two branches appending an
entry collided every time. One file per change cannot collide. It is now
published — linked from `/scoring` and `/scoring/gap` — because a pilot whose
points moved is entitled to read why.

See [docs/scoring-version.md](../../../docs/scoring-version.md).
