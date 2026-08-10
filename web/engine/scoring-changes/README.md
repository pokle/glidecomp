# Scoring changes

Every change to how GlideComp scores a flight, in the order it was made.

A competition's scores are recomputed whenever this engine's scoring code
changes, so a pilot's published points can move without anyone touching the
competition. These notes are the record of why, and they are linked from
[/scoring](https://glidecomp.com/scoring) and
[/scoring/gap](https://glidecomp.com/scoring/gap), because a pilot whose points
moved is entitled to read the reason.

## Adding one

One file per change, named `NNN-short-slug.md`, where `NNN` is the next free
number. Start with an H1 title, then say what changed:

```markdown
# Goal-line tolerance and crossing direction

Two changes at a LINE goal, both at the margins of the line: …
```

Say whether **points move**, and if they do, by how much and for whom —
several notes below quantify this against the 211-comp archive, which is the
standard to aim for. If nothing observable changes (a refactor, a corrected
comment), say so explicitly: the engine generation still rolls and every
competition still recomputes, and a reader deserves to know the recompute was
harmless. Cite the FAI S7F/S7A clause where there is one.

CI checks that a branch touching a hashed scoring source adds a note
(`web/scripts/check-scoring-change-note.ts`).

## The number is editorial

Nothing reads it. Numbers 002–045 are the entries that used to live as one
comment block in `web/engine/src/scoring-version.ts`, back when each one
carried a hand-maintained `SCORING_ENGINE_VERSION` — so `045-…` here is the
old "v45", and the older docs that say things like "bumped 12 → 13" still
point at the right note.

The cache key is no longer that sequence. It is a content hash of the scoring
sources, derived on every build — see [docs/scoring-version.md](../../../docs/scoring-version.md).

Two branches that both take the same number are **not** a conflict: the
filenames differ, git merges both, and you can renumber afterwards or leave
it. Avoiding that conflict is exactly why this is a directory and not a list.
