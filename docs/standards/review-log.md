# Standards review log

One entry per run of the monthly standards routine
([`.claude/commands/standards-check.md`](../../.claude/commands/standards-check.md)),
newest first. The register it works from is [`registry.json`](registry.json).

## 2026-10-25: baseline

The first run, made when the routine was written. It recorded a `seen` value
for every machine-checkable source and kept the first text snapshots, so the
next run compares against today. Nothing was adopted, and no issue was raised:
the first scheduled run raises the two owner items below, because they now
show as `behind`.

| Standard | Follows | Latest | Status |
|---|---|---|---|
| XCTrack task format | task file v1, QR v2 | `4244c8531f7ce4da` | new (first fingerprint) |
| Model Context Protocol | 2025-11-25 | 2026-07-28 | new (revision) |
| AI Catalog specification | 1.0 | `05a18c1154f62e3b` | new (first fingerprint) |
| MCP Server Card discovery | SEP-2127 Final | `b058f6587630cb90` | new (first fingerprint) |
| llms.txt format | llmstxt.org proposal | `59279b2eccb6c032` | new (first fingerprint) |
| OAuth 2.1 (IETF draft) | 13 | 16 | new |
| FAI S7F | 2026 V1.0 | | research |
| FAI S7A | not pinned | | research |
| IGC flight recorder format | not pinned | | research |
| MCP Server Card schema | v1 | | current |
| ARD specification | 0.91 | 0.91 | current |
| ARD schema | v0.91 | | current |
| WCAG | 2.2 | 2.2 | current |
| RFC 9728, 8414, 8707, 7591 | not obsoleted | not obsoleted | current |

### Changes

- **Model Context Protocol 2026-07-28.** A newer protocol revision than the
  2025-11-25 that `@modelcontextprotocol/server` advertises today. Owner's
  call (an SDK upgrade plus a read of the revision's changes). Not yet raised.
- **OAuth 2.1 draft 16.** The MCP 2025-11-25 authorisation spec cites draft 13.
  Informational until an MCP revision cites a newer draft, or the draft becomes
  an RFC. Raise it together with the MCP revision, since adopting 2026-07-28 is
  when the cited draft would move.
- **Fingerprints.** The four `new (first fingerprint)` rows are the baseline
  itself, not changes.
- **FAI research.** Searches found nothing newer than S7F 2026 V1.0, which is
  already transcribed in `docs/reference/fai-s7f-xc-scoring-2026/`. Search
  engines still index the 2024 S7F PDF ahead of the 2026 one, so a result
  that doesn't mention a new edition proves little. The latest IGC flight
  recorder specification found is the 2024 edition with Amendment List 9
  (December 2024).

### For the first scheduled run

An inventory of the tree, made while writing the register, found two things
that are probably safe fixes. Check them and include them in that run's PR:

- **Two S7A editions are linked.** `/scoring/track-validity` links the 2025
  S7A PDF and `/scoring/gap` links the 2022 one. Point both at the current
  edition once you have confirmed that the clauses they cite didn't move.
- **Old S7F 2024 clause numbers remain in prose.** Stopped tasks are cited as
  "§12.3" in `README.md` and `docs/database.md`, and launch validity as
  "§9.1" in `CLAUDE.md`. The 2026 edition moved both one section on (§13,
  §10). Confirm the exact clause in the transcription; the renumbering table
  is in `docs/2026-08-09-s7f-2026-migration-plan.md`.

### Lessons

- fai.org answers scripted fetches and WebFetch with 403. PDFs under
  `/sites/default/files/` still download with `curl`.
- The OAuth draft number is a single integer, so the script calls any change
  "major". Read the draft's change log before you believe that.
