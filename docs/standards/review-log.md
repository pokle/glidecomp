# Standards review log

One entry per run of the monthly standards routine
([`.claude/commands/standards-check.md`](../../.claude/commands/standards-check.md)),
newest first. The register it works from is [`registry.json`](registry.json).

## 2026-10-31: monthly run

Two sources moved: the AI Catalog specification text and the OAuth 2.1 draft.
Neither needs a change here. The FAI searches found nothing new. This run's
PR carries one clause-number fix left over from the last run.

| Standard | Follows | Latest | Status |
|---|---|---|---|
| AI Catalog specification | 1.0 | `7e73801d137ca4d6` | new (content): no effect here |
| OAuth 2.1 (IETF draft) | 13 | 17 | new: comment on #780 |
| FAI S7F | 2026 V1.0 | | research: nothing newer |
| FAI S7A | 2025 edition | | research: nothing newer |
| IGC flight recorder format | 2008 file format; spec 2024 + AL9 | | research: nothing newer |
| Model Context Protocol | 2026-07-28 | 2026-07-28 | current (adopted in #783) |
| All other entries | | | current |

### Changes

- **AI Catalog: trust manifests reworked.** `specVersion` stays "1.0". The
  single `trustManifest` on an entry became a `trustManifests` array, one per
  contributor. The catalog `signature` became a Signature object. An entry
  gained an optional `digest`, and `additionalSignatures` is reserved. All of
  this is optional trust metadata. Our `ai-catalog.json` uses only
  `specVersion` and entries with `identifier`, `type` and `url`, which did not
  change, and the well-known path and media type are the same. Classified
  minor for us. Snapshot refreshed, nothing else changed.
- **OAuth 2.1 draft 17** (31 October 2026). The change log lists
  clarifications and editorial work: it adds "obsoletes 6749, 6750", folds in
  RFC 10017 (browser-based apps), and clarifies redirect URI comparison,
  refresh-token rotation and client impersonation. Nothing a public-client
  provider must newly do. The MCP 2026-07-28 authorisation spec still cites
  draft 13, so this stays informational. Commented on #780.
- **MCP 2026-07-28 (#779).** Adopted by #783, so the row is now `current`.
  #779 is still open; its last comment recommends closing it once #783
  merged, which it has. Left for the owner.
- **CLAUDE.md report-card rule (c)** cited "§12.1, §12.3.5", the 2024 numbers.
  `score-explanation-charts.ts` excludes the ESS-but-not-goal reduction and
  the stopped-task time reduction for goal pilots, which the 2026
  transcription numbers §13.2 and §13.4.5. Corrected. PR'd.
- **The OAuth register entry** said the MCP spec we implement is 2025-11-25.
  It now names 2026-07-28. PR'd.
- **FAI research.** Searches for S7F 2027 / 2026 V1.1, S7A 2026/2027, the
  2026 CIVL plenary changes and IGC AL10 found nothing new. Probes under
  `/sites/default/files/civl/documents/` for the S7F 2027, S7F 2026 V1.1 and
  S7A 2026/2027 filenames, and for `igc_specification_2024_with_al10.pdf`, all
  answer 404.

### Lessons

- The scoring-changes notes (`017-…`, `022-…`) still cite §12.1 and §12.3.5.
  They are dated records written under the 2024 edition, so leave them.
- `fai.org/sites/...` answers 301 to `www.fai.org/sites/...` for any path,
  real or not. Probe the `www.` host, or follow the redirect, before you read
  a 301 as "exists".

## 2026-10-25: first scheduled run

Ran the same day as the baseline, so no fingerprinted source had moved. The
two owner items were already raised as #779 and #780 before this run, so
nothing new was opened. This run landed the two safe fixes the baseline
listed.

| Standard | Follows | Latest | Status |
|---|---|---|---|
| Model Context Protocol | 2025-11-25 | 2026-07-28 | behind (revision): #779 |
| OAuth 2.1 (IETF draft) | 13 | 16 | behind: #780 |
| FAI S7F | 2026 V1.0 | | research: nothing newer |
| FAI S7A | 2025 edition (was not pinned) | | research: nothing newer |
| IGC flight recorder format | 2008 file format; spec 2024 + AL9 | | research: nothing newer |
| All other entries | | | current |

### Changes

- **MCP 2026-07-28 (#779), OAuth 2.1 draft 16 (#780).** Both issues are open
  and nothing has happened since they were filed, so no comment was added.
- **S7A: both pages now link the 2025 edition.** `/scoring/gap` linked the
  2022 PDF for §5.2.4–5.2.5 (female and nation sub-rankings). The 2025 PDF
  (effective 1 May 2025) keeps §4.4.2, §4.4.6, §5.2.4 and §5.2.5 at the same
  numbers and titles, so the link moved to it. A `…_2026.pdf` URL answers 404:
  2025 is the current S7A. The register's `follows` is now "2025 edition".
  PR'd.
- **S7F 2024 clause numbers corrected to 2026.** Stopped tasks §12.3 → §13.4
  (`README.md` twice, `docs/database.md`). Launch validity §9.1 → §10.1
  (`CLAUDE.md` twice). Checked against the 2026 transcription's headings.
  PR'd.
- **FAI research.** Searches for S7F 2026 V1.1 / 2027, S7A 2026/2027 and an
  IGC AL10 found nothing new. The AL9 PDF's amendment table still leaves AL10
  blank.

### Lessons

- `CLAUDE.md`'s report-card rule (c) still cites "§12.1, §12.3.5", the 2024
  numbers for ESS-not-goal and the stopped-task time reduction. The 2026
  edition inserted §13.1 (Elevated Goal), so the mapping is not a plain +1. Read
  `score-explanation-charts.ts` to see which reductions it actually excludes
  before renumbering. Left for the next run.
- To probe whether a new S7A/S7F edition exists, `curl` the expected filename
  under `/sites/default/files/civl/documents/`. A 404 there is quick evidence
  that the edition has not been published.

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
