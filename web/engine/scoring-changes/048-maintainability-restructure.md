# Maintainability restructure of the scoring sources

NO scoring change — every pilot's points are identical. This is a structural
clean-up of the scoring sources following a deep code-quality review, and it
rolls every scoring cache once because the generation is derived from the
code it reorganises.

Value-identity was measured, not assumed: the archive parity audit
(`web/scripts/audit-scoring-change.ts`) was run over all 211 archived
competitions before and after, and the two outputs are identical — the same
validities, weights, available points, and per-pilot components on every
task.

What moved, without changing any number:

- `gap-formulas.ts` is split: the leading-coefficient machinery (weight
  envelope, aggregates, coefficient and points) now lives in
  `gap-leading.ts`. Code moved verbatim; the public surface is unchanged.
- The stopped-task machinery is consolidated in `gap-stopped.ts`: the
  §13.4.4 scored window is derived in one place instead of two, and the
  §13.4.5 time-points reduction is a pure function, so the published
  `StoppedTaskScore` is constructed once with final values instead of being
  patched after the fact.
- One definition each for ideas that were spelled several times: the
  neutralising early-start outcomes, the official start time's gate-else-SSS
  fallback, and the tie-sharing rank assignment (now shared with
  open-distance scoring).
- `calculateTimePoints` derives the discipline behaviour from the effective
  §13.2 ESS-not-goal factor its caller already resolves, instead of
  re-branching on HG/PG. For every input the sequence resolver can produce,
  the result is unchanged.
- Stored GAP parameters are validated at the database boundary (finite
  numbers, booleans, known enum values) instead of being cast; a malformed
  stored value now falls back to the format's default instead of flowing
  into arithmetic. Well-formed rows — all known rows — score identically.
- The dead cylinder-tolerance axis is deleted. Since the S7F 2026 adoption
  the band has been the fixed ±5 m spec minimum; the percentage arithmetic
  and its parameter threading could never execute, and stale comments still
  described the pre-2026 behaviour. The band is unchanged.
- A manual flight whose remaining-route lookup failed used to be scored as
  having reached goal by an unreachable fallback branch; it now throws. No
  reachable input hits the branch.
- `.xctsk` parsing validates every format path (a malformed file now fails
  with a clear error instead of feeding NaN into geometry), serialisation
  round-trips a declared `cylinderTolerance` again, and the IGC parser's
  duplicated date/rollover handling is deduplicated with identical output.
- Timezone-offset arithmetic shared with track quality lives in
  `zone-offset.ts`, which joins the hashed closure.

Every cached score therefore recomputes on deploy and lands on the same
numbers it had before.
