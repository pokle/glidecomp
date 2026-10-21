# A file that holds no flight is withheld, not dropped; DNF and ranks at the server seams

**Points move, for the fields of tasks with a DNF pilot who also uploaded a
withheld file, and ranks move wherever two published totals are equal.** The
bundled tasks carry neither case, so their points are unchanged; the ranks of
pilots tied at the minimum distance now share a place. Engine code review
2026-10-20, findings 2.1–2.5.

## What changed

- **A file with no fixes is a HARD data-quality finding** (`no-fixes`, "Track
  holds no flight"). A file that would not parse, or parsed without a single B
  record, used to be skipped when the scores were computed: the pilot vanished
  from the results and from every other pilot's numFlying. They are now seated
  last at 0 with the reason, like any other withheld track (FAI S7A §4.4.2),
  and the upload neither marks them Landed nor supersedes their manual flight.
  No scorekeeper override can score such a file — there is nothing in it to
  score; a manual flight is the way to record the pilot's result.
- **A DNF pilot whose upload is withheld still counts as present** for launch
  validity (S7F §10.1). The withheld file used to make the DNF query skip the
  pilot, so launch validity rose and every other pilot's points moved on the
  strength of a file nobody scored — in the review's case 775.1 → 1000.
- **A withheld upload beside a manual flight no longer seats the pilot twice.**
  The manual flight is their one entry, as it was before the upload.
- **Equal published totals share a task rank** (S7A §5.2.5.4): three pilots at
  13.9 are #2, #2, #2, as the engine ranks them, not #2, #3, #4. Withheld
  pilots, all at 0, share the rank below the field.
- **Competition ranks tie on the one-decimal total** S7F 2026 §15 publishes,
  not on whole points: 812.4 and 811.6 are no longer both first.
- Deleting or reclassing a DNF-only pilot now marks the task's scores stale
  (previously the 3 → 2 change to numPresent waited for an unrelated re-score),
  and the scores' ETag now changes with every re-score, so a client can no
  longer revalidate a body that changed through an input the state key does not
  cover, such as `gap_params`.
