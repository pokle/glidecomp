# Monthly standards check

You are the monthly standards routine for GlideComp. GlideComp follows a set of
external standards: the FAI Sporting Code (S7F GAP scoring, S7A), the IGC flight
recorder format, the XCTrack task format, MCP and its server-card extension,
OAuth, Agentic Resource Discovery, the AI Catalog, llms.txt, WCAG, and more.
Your job is to find out which of them have moved since the last run, then:

- **land one green PR** with every change that is safe to make without the
  owner, and
- **raise every other change with the owner**, one GitHub issue per
  standard, with enough in it to decide.

Leave the register and the log so the next run starts where you stopped.

The register is [`docs/standards/registry.json`](../../docs/standards/registry.json):
every standard, the edition GlideComp follows (`follows`), the files that pin it
(`statedIn`), search terms that find the code following it (`searchFor`), how
to check the source (`check`), what a change requires here (`onChange`), and
what the last run saw (`seen`). The log is
[`docs/standards/review-log.md`](../../docs/standards/review-log.md).

## 1. Read the log first

Read the two most recent entries of `docs/standards/review-log.md` and every
"Lessons" section. A change the last run already raised with the owner shows
up again as `behind`; don't raise it twice — find its issue and add to it only
if something new happened.

## 2. Run the check

```
git fetch origin master && git checkout -B claude/standards-$(date -u +%Y-%m) origin/master
bun install
bun web/scripts/standards-check.ts
```

It prints one row per standard:

| Status | Meaning | What you do |
|---|---|---|
| `current` | The source matches what we follow | Nothing |
| `new` | The source moved since the last run | Investigate (step 3) |
| `behind` | Differs from what we follow, but the last run already saw it | Make sure it has an open issue (raise one if not, step 6); nothing else unless it moved again |
| `unreachable` | The fetch failed or the version pattern no longer matches | Look at the source by hand (WebFetch, WebSearch). If the page moved or changed shape, fix the `check` in the register |
| `research` | No machine-checkable source | Do the searches in its `detail` (step 3) |

For a fingerprinted source (`check.kind: hash`) that is `new`, the row gives
a `diff` command between the kept snapshot and today's text. Run it: that is
what changed.

## 3. Investigate each change

For every `new`, `unreachable` and `research` row:

1. **Find out what changed.** Read the changelog, the release notes, the diff
   (`git diff --no-index` for a vendored file against the upstream copy, the
   snapshot `diff` for a page), or the new edition's own change marking.
   Don't judge a change by its version number alone.
2. **Classify it.** The script's `major` / `minor` / `revision` / `content` is
   a guess from the strings. Correct it from what you read:
   - **major**: a new edition, or anything that changes behaviour, required
     fields, scoring or security semantics;
   - **minor**: errata, clarifications, new optional fields, editorial
     changes.
3. **Find what it touches here.** Search the tree for the entry's
   `searchFor` terms (`git grep -F`) and for the clause numbers or field names
   the change involves. That finds the implementation and its tests as they
   are today; the register deliberately keeps no list of them. `statedIn`
   lists the files that pin the edition, which an adoption must update.
4. **Decide**, using the rules in step 4.

**The FAI sources need searching.** fai.org answers scripted fetches and
WebFetch with 403, and its PDF filenames change from edition to edition, so
the S7F, S7A and IGC entries are `research`:
- Run the entry's queries with WebSearch.
- Look for FAI news posts ("<year> edition of Section 7 published") and
  CIVL plenary decisions.
- Sporting Code editions take effect on **1 May**. Expect a new S7F/S7A
  between January and May, and errata ("V1.1") at any time.
- A PDF link under `www.fai.org/sites/default/files/civl/documents/` downloads
  fine with `curl`, even though the pages don't. When you find one, download
  it and compare it against `docs/reference/fai-s7f-xc-scoring-*/`.
- If you can't confirm a new edition from a primary source, say so in the log
  rather than guess.

## 4. Safe to PR, or the owner's call

**Make the change yourself**, in this month's PR, only if ALL of these hold:

- It changes **no score**. Nothing under `web/engine/src/` moves, or only
  comments and docs there do. `bun run engine:fingerprint` must not change
  the generation.
- It changes **no words a person reads** in the UI. CLAUDE.md: "Propose UI
  wording before you change it."
- It changes **no authentication, authorisation or security behaviour.**
- It is **mechanical**. Examples:
  - refreshing a vendored schema or fixture (`check.kind: same-as`) when every
    test still passes against the new copy;
  - updating a version string we publish when the code already meets the new
    version;
  - adding an optional field a discovery spec now recommends;
  - reshaping `llms.txt` or the `.well-known` files to a revised format;
  - correcting a spec URL, a clause reference or a doc that names the old
    version.
- The repo's checks pass (step 5).

**Raise it with the owner** (step 6) for everything else. That includes,
always:

- **Any new S7F or S7A edition, or errata.** Adopting one is a scoring
  decision: which edition applies to which comps, and from which date. It
  needs a note in `web/engine/scoring-changes/` measured over the archive, a
  new transcription under `docs/reference/` (follow
  `docs/reference/fai-s7f-xc-scoring-2024/INGESTION.md`), and the owner's
  decision.
- **An IGC format change** that touches parsing or validation.
- **A new MCP protocol revision.** What the endpoint speaks comes from
  `@modelcontextprotocol/server` (`SUPPORTED_PROTOCOL_VERSIONS`). Adopting a
  revision is an SDK upgrade plus a read of what the revision changes, for the
  owner and the dependency routine together.
- **Anything in OAuth or the MCP authorisation spec.**
- **A new WCAG version, or one that moves from draft to Recommendation.**
  Adopting it is a policy change to `docs/accessibility-standard.md`.
- **A major change to anything**, a change you couldn't fully read, and
  anything you're unsure about.

Never change a test to make it pass, never skip one, and never adopt a scoring
edition, however small its change looks.

## 5. Verify, then push

If you made changes, run what the repo runs before pushing:

```
bun run test              # root tests and typecheck:all
bun run test:workspaces   # competition-api, auth-api, frontend
```

Add `bun run test:e2e` when you touched `web/frontend/` or anything a page
serves (the `.well-known` files, `llms.txt`). `docs/local-dev.md` has the e2e
notes. Then, and only after the findings are dealt with:

```
bun web/scripts/standards-check.ts --record
```

This records what this run saw in the register and refreshes the text
snapshots, so next month compares against today. It touches only entries
that changed. Update an entry's `follows` (and every place its `statedIn`
lists) when this PR adopts the new version.

## 6. Report

- **Issues**, one per standard needing the owner.
  - First search open issues for `Standards:` and the standard's name. Add a
    comment to an existing issue rather than open a second.
  - Title: `Standards: <name> <new version> published`.
  - Body: what changed (link the source), what it touches here (files), how
    big it is (major/minor, scores affected or not), and the options with
    your recommendation.
- **The PR**, when there are safe changes: title
  `Standards check <YYYY-MM>: <short summary>`. List every row that wasn't
  `current`, what you did about it, and links to the issues. Include the
  branch preview URL from `bun run preview-url`. Then watch CI to green: no
  `gh` CLI on Claude Code on the web, so use the GitHub MCP tools.
- **The log**: add a dated entry to `docs/standards/review-log.md`, with:
  - the report table;
  - per change: what it was and what you did (PR'd, or the issue link);
  - Lessons, recording anything that tripped you up so the next run doesn't
    relearn it, including a `check` you had to fix.

  The log entry rides in the PR. If there were no safe changes but something
  needed the owner, open the PR anyway with just the log entry and the
  register update, so the next run knows what it already raised.
- **A quiet month** (every row `current`, every research search turning up
  nothing new): push nothing and open nothing. Say so in one line.

## Not in the register, on purpose

These are followed too, but nothing about them moves on a monthly scale or a
version check can't see it. Don't add them back without a reason:

- **Fixed or frozen**: GPX 1.1, KML 2.2, OziExplorer and PCX5 `.wpt`, SeeYou
  `.cup`, sitemap protocol 0.9, Google's encoded polyline, the Ding (2018)
  touring-circles paper, WGS84 and the Vincenty formulas, RFC 6749, 7636
  (PKCE), 9068 and 6750, and OpenID Connect Discovery.
- **Unversioned upstream data, guarded by fixtures instead**: the civlcomps.org
  ranking export (`web/samples/civl-rankings/` and its tests), the legacy
  AirScore endpoints, and Mapbox Terrain-RGB.
- **Covered by the weekly dependency routine** (`upgrade-deps`): Cloudflare
  compatibility dates, the MCP SDK and Better Auth versions.
- **Policies, not external editions**: the CSP and Trusted Types headers, and
  ASD-STE100 writing (where Australian English overrides Rule 1.14).

---

This routine lives at `.claude/commands/standards-check.md`. When you find a
missing step or a stale instruction, fix it in the same PR. Add a standard to
the register when GlideComp starts following a new one. The register test
(`web/scripts/standards-check.test.ts`) checks every entry is complete, every
path in it exists, and every `searchFor` term still finds something.
