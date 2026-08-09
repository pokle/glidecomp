# The scoring engine generation

Every scoring cache key carries an **engine generation**, so results computed
by two different generations of the engine can never be served side by side. A
deploy that changes scoring behaviour rolls every key at once, and because the
engine is deterministic, a cached score and a cached analysis under the same
generation + inputs are guaranteed to agree. That guarantee is what lets the
report card present its narrative as exact, with no "may not match the
published score" hedging.

The generation is **derived from the code, not declared by a human**.

## How it works

```
web/scripts/scoring-fingerprint.ts            the closure + the hash
web/scripts/generate-scoring-fingerprint.ts   writes the generated module
web/engine/src/scoring-fingerprint.generated.ts   ← gitignored
web/engine/src/scoring-version.ts             re-exports it (stable import path)
```

`scoring-fingerprint.ts` walks the transitive import closure of the seven
scoring entry modules (`SCORING_ROOTS` — the two scorers, the sequence
resolver, the two parsers, plus `track-quality.ts` and `manual-flight.ts`,
which the backend calls directly and which would otherwise sit outside every
root's closure) and SHA-256s the result: path, NUL, bytes, NUL, in sorted path
order. That is 27 files today.

Two values come out of it:

| Export | What it is |
|---|---|
| `SCORING_SOURCE_FINGERPRINT` | the full hash, hex |
| `SCORING_ENGINE_VERSION` | its leading 48 bits, as a number |

48 bits because it has to stay an exact JS integer and fit the existing
`engine_version INTEGER NOT NULL` column in `task_scores` (migration 0012) and
`task_field_analysis` (0019). Every consumer compares it with `=` / `!=`
(`score-store.ts`, `field-analysis-store.ts`, `routes/cache.ts`) or
interpolates it into a string key (`state-key.ts`, `geom-hash.ts`) — nothing
orders it — so no consumer and no migration had to change when it stopped
being a sequence.

The engine is consumed as raw TypeScript everywhere (the package's `exports`
point at `src/index.ts`, wrangler's `main` is `src/index.ts`, and vite, tsc and
bun test all read the same files), so there is no bundle step to hook. The
generated module simply has to exist on disk before any of them run. It is
written by `postinstall`, by `deps` (which `test`, `test:all`, `typecheck:all`
and both e2e suites funnel through), and by the `dev`, `build` and `deploy:*`
scripts. Regenerate it by hand with:

```bash
bun run engine:fingerprint
```

The generator only writes when the content differs, so calling it from a dev
script does not touch the mtime and does not restart vite or wrangler.

## Why it is derived

It used to be a hand-maintained integer (`SCORING_ENGINE_VERSION = 39`) beside
a hand-pasted hash, kept honest by a test that failed until the two agreed.
That guard worked. What it cost was a merge conflict — three of them, in one
file — on every pair of parallel engine branches:

1. the integer, where both branches edited the same line;
2. the fingerprint, same line again;
3. the ~400-line changelog comment, where both branches appended at the same
   spot.

The second one is the one that mattered, because **it could not be resolved by
picking a side**. The correct fingerprint for a merged tree is a hash of that
merged tree, which matches neither parent — so the right answer existed on
neither branch and had to be re-derived by hand after every merge, conflict
markers or not. Resolving it by keeping either side shipped a key that
described neither generation.

Deriving it makes the merged tree produce the right key by construction, which
is both conflict-free and more correct than the manual step it replaces.

The trade is that the value is now opaque: you can no longer say "we're on
v39". Nothing in the code needed that, and the readable history moved to the
changelog below.

## The changelog

`web/engine/scoring-changes/` — one markdown file per change, `NNN-slug.md`.
This is the old changelog comment, split so that two branches adding two
different notes merge as pure additions. Numbers 002–039 are the entries that
used to live in `scoring-version.ts`, so `039-…` is the old "v39" and the older
docs that say "bumped 12 → 13" still point at the right note.

The number is editorial — nothing reads it. Two branches that both take `040-`
are not a conflict: the filenames differ and git merges both.

It is linked from `/scoring` and `/scoring/gap`, because a pilot whose points
moved is entitled to read why.

## The obligation that remains

The old guard's real value was never the hash. It was that it stopped an
author and made them write down what changed and why — several of those notes
cite the FAI clause and the archive measurements behind a decision, and they
are worth more than the number they were attached to.

So `web/scripts/check-scoring-change-note.ts` fails a branch that touches a
hashed scoring source without adding a note. It compares against the **merge
base**, deliberately keeping no baseline in the tree — which is what leaves
parallel branches nothing to conflict over. It runs in CI after `test:all`,
and skips itself rather than failing when the merge base is out of reach (a
shallow clone, a detached checkout).

Two tests still cover the machinery:

- `web/engine/tests/scoring-version.test.ts` — the generated module on disk
  matches the sources beside it. This catches a direct `bun test` after an
  edit, the one state in which the engine would ship a cache key that does not
  describe its own code.
- `web/scripts/scoring-source-closure.test.ts` — the import walk itself, over
  an in-memory tree. A dependency the walk fails to follow is a hole that stays
  open until a scoring change slips through it, and nothing else goes red.

## Adding a scoring root

If new code can affect a published score but no existing root imports it, add
it to `SCORING_ROOTS` in `web/scripts/scoring-fingerprint.ts`. That is how
`track-quality.ts` and `manual-flight.ts` got there.
