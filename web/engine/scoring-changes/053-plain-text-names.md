# Names are read as plain text, not HTML

NO points move. Names are not a scoring input: no expression, threshold or
constant reads one, so every scored number and every task analysis is
identical before and after. Rescoring all four bundled competitions (every
task, with `--analysis`) produced byte-identical output.

What changed is how the IGC and XCTask parsers read text — pilot and glider
names from IGC headers, turnpoint names from C records and task files, event
descriptions from E records. They used to pass every one through
`sanitizeText()`, which deleted anything tag-shaped and then HTML-encoded
`& < > " '`. That was meant to keep the names safe to drop into HTML, but it
made them wrong everywhere else:

- The route editor's "import a task file" read turnpoint names through the
  parser, so a route imported from an `.xctsk` stored `Tom &amp; Jerry` as the
  turnpoint's name, and every page showing the route showed the entity.
- A signed-in pilot's personal library named a track after its IGC header
  (`O&#39;Brien - 2026-01-05`), and a task after its start turnpoint.
- The analysis page escaped names again on output, so it showed the entity
  too, and its task editor saved the entity back into any `.xctsk` it
  downloaded.
- On the analysis page, a task declared in an IGC file is matched to the
  waypoint file by name. A name containing `&` was encoded on one side and not
  the other, so it fell back to matching by coordinates.

The parsers now return the text exactly as the file wrote it
(`web/engine/src/text.ts`, `toText()`), still coercing a non-string field
rather than throwing. Safety comes from encoding where text is OUTPUT: React
and the analysis page's templates render it as text, and the page head, emails
and exporters escape it. See `docs/security-output-encoding.md`.

The engine generation rolls (`igc-parser.ts` and `xctsk-parser.ts` are in the
scoring closure), so every competition recomputes once; the recompute changes
no number. Migration 0035 decodes the names already stored encoded — the IGC
pilot name kept beside a track, and the personal library's track and task
names. The old tag-stripping cannot be undone, so a name that lost a `<…>` run
stays as it was.

Not rewritten: a competition route imported from a file before this change
keeps its encoded turnpoint names in the stored task. The route is a scoring
input, and an `&amp;` an import wrote cannot be told apart from one an
organiser typed, so the organiser renames the turnpoint (or re-imports the
file) instead.
