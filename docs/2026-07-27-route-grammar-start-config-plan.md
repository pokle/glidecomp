# Route grammar: say the start config out loud — 2026-07-27

Plan for [issue #436](https://github.com/pokle/glidecomp/issues/436). Implements
the agreed design in that issue's comment: the "Enter task" route line gains an
optional set of modifiers on the `sss` turnpoint, so start **direction**,
**timing** and **start gates** stop being invisible dialog defaults.

## The problem, precisely

Typing `ELLIOT 400m to, PINEMT 400m sss, TOWONG 400m, GRGGRG 400m ess, CORRY 400m goal`
in the route editor produces an **EXIT / RACE** start with no gates. Nothing in
the line says so. The direction lives in separate dialog state
(`RouteEditorDialog.tsx:236-238`, and the same `?? "EXIT"` fallback on import at
`:459-461`), inside a `Disclosure` that is collapsed by default. The engine then
faithfully honours the declared value — the SSS is the one turnpoint whose
crossing direction is *declared* rather than inferred from geometry
(`web/engine/src/task-optimizer.ts:389-391`) — so the silent default is a real
scoring input that the user never saw.

EXIT is the right default (the paragliding race-to-goal norm, and both
directions are valid under FAI S7). The defect is that it is applied silently,
far from where the user is working.

Two fixes, both in scope here, smallest first:

1. **Surface it** — put the existing `startConfigSummary()` one-liner where it
   can be read without expanding anything.
2. **Let the line say it** — extend the grammar so the start config is text you
   can type and edit, and so the route reads its real config back.

## 1. Grammar

Everything after `sss` is a **modifier attaching to the start turnpoint**, in any
order, every part optional. All defaults match today's behaviour, so `sss` alone
is unchanged.

| Setting   | Tokens                          | Default | Notes |
|-----------|---------------------------------|---------|-------|
| Direction | `exit` / `enter`                | `exit`  | |
| Timing    | `race` / `elapsed` (alias `et`) | `race`  | |
| Gates     | bare `HH:MM`, repeated          | none    | comp-local; for `elapsed` the first is "start opens" |

```
PINEMT 400m sss                           → exit · race · no gates   (today's default)
PINEMT 400m sss enter                     → enter · race
PINEMT 400m sss 13:15 13:30 13:45         → exit · race · 3 gates
PINEMT 400m sss elapsed 13:15             → elapsed · start opens 13:15
```

Full route:

```
ELLIOT 400m to, PINEMT 400m sss exit 13:15 13:30 13:45, TOWONG 400m, GRGGRG 400m ess, CORRY 400m goal
```

### Why these tokens

- **`HH:MM` is self-identifying.** A colon can't appear in a radius
  (`RADIUS_RE`, `quick-task.ts:21`), and doesn't appear in any of the 219
  waypoint codes across the bundled competitions (checked). So a time token
  needs no sigil, and `sss 13:15` reads like English rather than `@13:15`.
- **`exit`/`enter`/`race`/`elapsed`/`et` are words**, so they ride the existing
  `isWaypointCode` guard (`quick-task.ts:338`) that already protects the type
  words: a comp with a waypoint literally coded `RACE` still wins. (No
  collisions in the bundled set either — also checked.) The same guard is
  applied to time-shaped tokens, so a hypothetical code containing a colon is
  still typeable.
- **Modifiers attach to `last`**, exactly like radius (`:246-254`) and the type
  word (`:255-259`) do now — so ordering stays forgiving (`sss 400m exit 13:15`
  and `PINEMT 400m exit sss` both work) with no new tokenizer rules.
- **The gate generator stays a UI button, not grammar.** It only fills the gate
  list; the stored xctsk holds the expanded times, so representing the list *is*
  representing the real state — more honest than hiding "4×15" logic in text.

## 2. The one design hazard: convergence

The field and the route are two views of one thing, kept in step by comparing
text (`QuickTaskField.tsx:175-197`): the dialog renders rows → `routeText`; the
field parses the line → route → `builtText`; a difference pushes. Putting start
config in the line means both sides must render it *identically*, or the two
views disagree forever and the field either loops or silently clobbers the
Start panel.

**The rule that makes it converge: emit a modifier only when it is not the
default.**

- Dialog with EXIT / RACE / no gates renders `… sss …` — byte-identical to
  today. Field parses it, gets the defaults back, `builtText` matches. No push.
- Dialog with ENTER renders `… sss enter …`; the field parses ENTER; match.
- Deleting `enter` from the line therefore means "make it exit" — a deliberate
  edit with the obvious result, and safe *because* any non-default is always
  spelled out in the mirror. There is no state the line can't see.

Two consequences worth stating:

- **Absence means default, not "unstated"** — but only for a route that *has* an
  SSS turnpoint. When the parsed line has no SSS, the start config is left
  untouched (the panel keeps its gates; the dialog already warns that gates have
  no cylinder to apply to). Same for open-distance comps, where the panel is
  hidden and `assembleTask` carries the loaded task's `sss` through.
- **`quickTaskText`'s `"all"` mode spells the start out in full** —
  `sss exit race`. That mode is what Enter (and blur) writes into the box
  (`normalise()`), which makes this the direct answer to the issue: press Enter
  and the invisible default becomes visible, editable text. It still round-trips
  to the same route, and `normalise()` already no-ops when the text is already
  spelled, so it's stable.

## 3. Time zone

Gate pickers are **comp-local** already, converted at the dialog boundary
(`toDisplayTime`/`toUtcTime`, `RouteEditorDialog.tsx:148-151`), anchored to the
task date so DST is the day's own. Grammar times use the same convention:

- `quick-task.ts` stays timezone-free and pure — it parses and emits `HH:MM`
  strings in *display* time, exactly like the dialog's `gates` state.
- The dialog converts to/from UTC at the same boundary it already does.
- With no comp timezone set, everything is UTC — today's fallback, and what
  `startConfigSummary` already does.
- The field shows the zone label inline (new optional `timeZoneLabel` prop) so
  `13:15` is never ambiguous.

## 4. Changes, file by file

**`web/frontend/src/react/comp/quick-task.ts`**

- `QuickToken` gains `kind: "time"` for a token containing a colon, with a
  parsed `hhmm?: string` when it's a valid `HH:MM` (invalid ones stay time
  tokens so they can be reported rather than fuzzy-matched into a bogus
  waypoint miss). A token that exactly matches a waypoint code is a name token
  regardless, mirroring `isWaypointCode`.
- `startModifier(word)` alongside `typeAlias()`, mapping
  `exit|enter` → direction and `race|elapsed|et` → timing.
- `QuickTaskItem` gains optional `startDirection`, `startTiming`, `startGates`
  and `badTimes: string[]`; the parse loop records them onto `last`.
- `startConfigFromItems(items, types)` — reads the modifiers off whichever item
  `resolveTypes` made the SSS (so they work on an *implied* start too) and
  returns `{ direction, type, gates }` with the defaults filled in, plus the
  problems worth reporting. Keeping this separate leaves `parseQuickTask`'s
  signature untouched.
- `quickTaskText(route, { types, start })` — emits modifiers on the SSS
  turnpoint: non-defaults always, everything in `"all"` mode. Gates are emitted
  in given (display) order.

**`QuickTaskField.tsx`**

- `onApply` hands back `{ picks, start }`; `builtText`/`spelledText` are
  computed with the parsed start config so the comparison in the sync effect
  stays like-for-like.
- New optional props: the incoming start config is already encoded in
  `routeText`, so only `timeZoneLabel` is needed for display.
- Status line reports start problems next to the existing unmatched-names
  message: an invalid time, a duplicate gate, gates with no SSS turnpoint,
  `elapsed` with more than one gate (only the first is used).

**`RouteEditorDialog.tsx`**

- `quickText` memo includes the current `sssType` / `direction` / `gates` state,
  so the mirror states the truth.
- `applyQuickTask` sets `sssType` / `direction` / `gates` alongside `setRows`,
  converting gates display → the state the panel holds; skipped entirely when
  `openDistance` or the parsed route has no SSS.
- Help text under the field mentions the modifiers, matching the existing
  `to, sss, ess, tp, goal` line (`:745-750`).
- **Fix 1:** pass `startConfigSummary(...)` as the `Start (SSS)` `Disclosure`'s
  `badge` — the component already documents that slot as "an inline annotation
  next to the title (e.g. a summary)", so the active start type reads back
  without expanding the panel. The task detail page already renders the same
  summary (`pages/TaskDetail.tsx:519`), so this makes the editor agree with the
  page it's editing.

**No server work.** Verified: the task PATCH already audit-logs start direction,
type and gate changes (`competition-api/src/xctsk-summary.ts:214-226`) and
already bumps the materialized scores. This change adds no endpoint and no new
mutation path, so the CLAUDE.md `audit()` + `bumpAndRevalidateScores()` rules
are satisfied by the existing save path.

## 5. Tests

`web/frontend/src/react/comp/quick-task.test.ts`:

- each modifier parses; order-independence (`sss 400m exit 13:15` ≡
  `sss exit 13:15 400m` ≡ `exit sss 400m 13:15`);
- modifiers on an *implied* SSS;
- waypoint-code collision — a comp with a waypoint coded `RACE` or `EXIT` still
  types it as a turnpoint;
- absence yields today's defaults, and a route with no SSS reports rather than
  invents;
- invalid/duplicate times are reported, not silently dropped;
- **round-trip stability** for both `"needed"` and `"all"`:
  `parse(quickTaskText(route, opts))` reproduces the route *and its start
  config*, and `quickTaskText(parse(text))` is a fixed point — this is the test
  that guards the convergence rule in §2.

`route-editor.test.ts`: display ↔ UTC gate conversion round-trips through the
grammar for a comp zone (an Australian morning is the previous UTC evening —
the existing `startConfigSummary` zone tests cover the same trap).

Manual/e2e: none required — the route editor is admin-only and not SSR'd, so
`test:e2e:ssr` is untouched. `bun run test` and `bun run typecheck:all` are the
gate.

## 6. Out of scope, and one thing to leave alone

- **Goal-side settings** (`goal line`, deadline) are a natural extension of the
  same idea, deliberately not here.
- **The pre-existing default asymmetry** the issue notes: v1 `.xctsk` parsing
  defaults a missing `direction` to **ENTER** (`xctsk-parser.ts:177`), v2
  compact to **EXIT** (`:271`), IGC-declared tasks hard-code **EXIT**
  (`:646-649`), and the editor is a fourth spot. Don't "fix" it in this change —
  `xctsk-parser.ts` feeds scoring, so altering how an existing file is read
  changes results for already-scored tasks and needs a `SCORING_ENGINE_VERSION`
  bump and its own parity check. This work must simply be *consistent* with the
  editor's EXIT, which it is. Worth its own issue.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Field ↔ dialog push loop, or the line silently clobbering the Start panel | The emit-non-defaults rule (§2) plus the fixed-point round-trip tests; the "no SSS → leave the panel alone" guard |
| A waypoint code shaped like a modifier or a time | The existing `isWaypointCode` guard, extended to time tokens; verified clean across the bundled comps |
| Gate times read as UTC when they're comp-local (or vice versa) | One conversion boundary, the dialog's existing `toDisplayTime`/`toUtcTime`; the zone label shown inline in the field |
| Extra verbosity in the mirrored line | Only non-defaults are emitted, so the common task's line is byte-identical to today's |
