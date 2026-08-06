# SEC-39 — proposed solutions

**Status:** **decided — Options A + B + C implemented** in
[#556](https://github.com/pokle/glidecomp/pull/556) (2026-08-06). Option D was
considered and rejected; Option E is carried as gap #21. This document is kept
as the reasoning behind the shape of the fix, not as a live proposal.
**Finding:** `docs/security-review.md` → *SEC-39 — Anonymous-submission
rate-limit budgets chargeable before any legitimacy check* — Medium.
**Code:** `web/workers/competition-api/src/routes/igc-anon.ts`,
`web/workers/competition-api/src/rate-limit.ts`.

The review's own close-out note says SEC-39 "needs a decision, not just a fix":
reordering the budget check is easy, but whether to add a per-IP budget is a
product question against the route's stated "flag, don't reject" posture. This
document is the analysis behind that decision and the options it opens.

---

## 1. What is actually wrong

`igc-anon.ts` charges three budgets. Two of them are charged before the work
they exist to bound, and both are keyed on a value the caller chooses:

| Line | Budget | Key | Charged before |
|---|---|---|---|
| `:178` | `ANON_SUBMIT_PER_COMP` — 300/24 h | `comp_id` from the URL | the comp is known to exist (`:200`) |
| `:324` | `ANON_SUBMIT_PER_PILOT` — 6/24 h | `comp_pilot_id` of the named pilot | the file is read (`:336`) |
| `:284` | `ANON_SUBMIT_MISSES` — 20/24 h | `cf-connecting-ip` | — charged **on the outcome**, correctly |

A budget keyed on a value the attacker chooses, and charged before the work it
is meant to bound, is a denial-of-service primitive against whoever owns that
value. The miss budget is the one that gets both halves right, and it is the
template for the fix.

## 2. Why reordering alone does not close it

The review's headline remediation — charge `ANON_SUBMIT_PER_COMP` only once the
competition and task are confirmed to exist — is necessary but does not close
the finding. It raises the attacker's cost from *one public value* to *three
public values*:

- the `comp_id` is in the competition's own public URL;
- a `task_id` is on the public comp page;
- and a pilot identifier that resolves is on the **public roster**.

That last one is the load-bearing point. `GET /api/comp/:comp_id/pilot`
(`routes/pilot.ts:530`) uses `optionalAuth`, and its own SEC-15 comment states
the rule: *"for non-test comps we keep public visibility of names/IDs/classes
but redact the PII fields via `serializeCompPilotPublic`"*. National IDs are
public by design — `igc-anon.ts`'s header comment says so plainly ("the
identifier is a name, not a secret"), and that is a stated trade-off, not a
defect. But it means an anonymous attacker can read a real, resolving
identifier and walk straight past a reordered existence check.

Two consequences follow, and the second is worse than the finding as written:

- **The comp drain survives.** 300 POSTs naming a real roster pilot, each with
  an empty body, still exhaust the competition's whole daily allowance. The
  file is never read, so it costs the attacker nothing.
- **A single pilot can be locked out for six requests.** `ANON_SUBMIT_PER_PILOT`
  is 6/24 h and is charged at `:324`, *before* the body is read at `:336`.
  Six empty POSTs naming one pilot's public CIVL id take that pilot's entire
  daily allowance — so on landing day they cannot submit at all. This is the
  cheapest and most precisely targeted version of the attack, and **reordering
  does not touch it**, because the pilot budget is already charged after the
  identifier resolves. The review names this in its evidence but its remediation
  addresses only the comp budget.

`docs/track-submission.md:435-438` currently offers the reassurance that "an
attacker cannot burn a real pilot's allowance without an identifier that
resolves". That is true and no longer reassuring: resolving identifiers are
published by the same route's own roster endpoint. That passage needs correcting
whatever else is decided.

## 3. The distinction that resolves it

`rate-limit.ts`'s own header states the design intent: these are "the kind
that bound damage rather than the kind that bound traffic". That
distinction is exactly right, and it dictates where each budget is charged:

- A **damage budget** is keyed on the thing being protected — a competition, a
  pilot's registration. It must be charged **when the damage happens**, i.e.
  when a track is actually stored.
- An **effort budget** is keyed on the caller. It bounds wasted work and must be
  charged **when work is wasted**.

Both anonymous damage budgets are currently charged on *attempt*, which silently
converts them into the traffic budget they explicitly are not — and a traffic
budget keyed on the victim rather than the caller is the bug.

## 4. Options

### Option A — reorder only

Move the `ANON_SUBMIT_PER_COMP` charge from `:178` to after the task lookup and
`submissions_closed` check (`:269`).

- **Closes:** the garbage-id drain; and the incidental storage growth the review
  noted in passing (today every distinct decodable `comp_id` an attacker tries
  leaves a permanent `rateLimit` row).
- **Does not close:** the drain via public identifiers, or the six-request pilot
  lockout — see §2.
- **Cost:** ~5 lines, no new tests beyond one "not charged for a nonexistent
  comp" assertion.
- **Verdict:** necessary, not sufficient. Worth shipping as part of a larger
  change; shipping it alone would close the ticket without closing the hole.

### Option B — charge the damage budgets on outcome  *(recommended, core)*

Split `chargeBudget` into a read-only `peekBudget` and the existing atomic
charge. Peek early as the cheap rejection; charge only after
`storeUploadedTrack` succeeds.

```
peek comp budget      → 429 if already at cap    (cheap SELECT, no write)
…existence, eligibility, identifier match…
peek pilot budget     → 429 if already at cap
…read body, validate, store…
charge comp + pilot budgets                       (only now, damage done)
```

- **Closes:** both drains completely. Neither counter can be moved without
  actually storing a track — which is precisely the damage each is sized
  against.
- **Preserves the file's stated cost rule** ("cheapest rejections first"). A
  competition or pilot already at cap is still turned away before the body is
  read, and on a `SELECT` that is *cheaper* than today's upsert — the current
  code performs a D1 **write** before its first D1 **read**.
- **Race to state honestly:** N concurrent requests can pass the same peek and
  all store. Over-admission is bounded by request concurrency and is harmless
  against 6/day and 300/day counters, which still converge. Worth a comment in
  the code, not worth a lock.
- **Shifts the cheap attack** from "drain a counter" to "make the worker read
  and reject bodies". That residue is real, and is why Option C is not
  optional.
- **Cost:** `peekBudget()` (~15 lines), two call sites moved, one new call site,
  doc table + tests updated.

### Option C — generalise the miss budget into an effort budget  *(recommended, companion)*

Widen `ANON_SUBMIT_MISSES` from "charged on `no_pilot_match`" to "charged on any
request that ends without a stored track" — `bad_identifier`, `comp_not_found`,
`task_not_found`, `anonymous_not_permitted`, `comp_closed`, `submissions_closed`,
`ambiguous_pilot_match`, `invalid_file`, `task_pilot_limit`. Rename to
`ANON_SUBMIT_FUTILE`; key stays `cf-connecting-ip`.

This is the answer to the product question the review raised, and it dissolves
the trade-off rather than accepting it:

- **A successful submission never costs anything per-IP.** A whole gaggle behind
  one landing-field wifi or CGNAT address can submit all afternoon. Only wasted
  work is charged, so "flag, don't reject" survives intact for pilots.
- It is a strict superset of today's budget, so the email-enumeration-oracle
  property the miss budget was built for is preserved unchanged.
- **Budget number is a decision:** 20 was tuned for the oracle case alone. As a
  general futile-attempt budget it should be looser — a pilot who fumbles an
  identifier twice and then uploads a file their logger wrote badly could
  plausibly reach 5–8. **Suggest 40/24 h**, and this number should be the
  owner's call.
- **Limit to state:** an attacker with many source addresses evades any per-IP
  budget. That is why C is a companion to B and not a replacement — with B in
  place, a thousand IPs still cannot drain a competition, because draining now
  requires storing real tracks against real registrations.

### Option D — a per-IP budget on *every* submission  *(the review's literal suggestion — not recommended)*

Charging all submissions per-IP collides with the landing-field reality the
route was built for: one competition, one shared connection, sixty pilots
uploading within the hour. Any budget tight enough to bound abuse risks 429-ing
real pilots on the single day they need the feature — the exact failure mode the
route exists to avoid. Option C buys the same protection with none of that
exposure.

If it is wanted anyway, key it per `(IP, comp)` and set it as a flood cap rather
than a shaping cap (~100/24 h).

### Option E — `rateLimit` row housekeeping  *(separate, low priority)*

Option A removes the "one permanent row per bogus id" growth, but legitimate
rows still never expire. A small scheduled `DELETE FROM "rateLimit" WHERE
"lastRequest" < ?` would close it — **scoped to `key LIKE 'anon-igc:%'`**, since
Better Auth owns this table too (migration 0017) and its own rows must not be
swept. Name it, don't bundle it.

## 5. Recommendation

**A + B + C as one change.** Individually each leaves a live path: A leaves both
drains, B leaves body-reject spam, C alone leaves the counters drainable by a
distributed caller. Together they mean no counter moves without a stored track,
and no caller can waste unbounded work getting there.

Alongside it, correct `docs/track-submission.md:435-438`, whose "order of work
is a cost decision" paragraph currently documents the wrong order as
intentional, and whose reassurance about pilot allowances no longer holds.

Two decisions are the owner's, not the implementer's:

1. The `ANON_SUBMIT_FUTILE` number (suggested 40/24 h, up from 20).
2. Whether Option D is wanted on top of C, despite the CGNAT exposure.

**Decided (2026-08-06):** A + B + C shipped as one change in
[#556](https://github.com/pokle/glidecomp/pull/556). `ANON_SUBMIT_FUTILE` went
in at the suggested 40/24 h — the one number here with no production evidence
behind it, so the next review round should check it is not turning real pilots
away. Option D was not taken. Option E is gap #21.

## 6. Test coverage the change should carry

Extending `web/workers/competition-api/test/igc-anon.test.ts`, which already
covers the three budgets:

- no `anon-igc:comp:*` row is written for a competition or task that does not
  exist;
- no comp/pilot row is written for a request that is rejected — closed comp,
  invalid file, task pilot limit;
- **the lockout regression:** six empty-bodied POSTs naming a real pilot's
  public identifier must leave that pilot's seventh, valid submission working;
- the futile budget is charged on `invalid_file` and `comp_closed`, not only on
  `no_pilot_match`;
- the existing "successful submissions never charge the probe budget" assertion
  still holds under the widened scope;
- the existing "6 then 429" pilot test still passes — under B all six store
  successfully, so all six charge.

## 7. Blast radius

No migration. No engine change, so no `SCORING_ENGINE_VERSION` bump and no
`SCORING_ROOTS` parity re-validation. `audit()` and `bumpAndRevalidateScores()`
call sites are untouched. The `429` response shape, its `scope` field and its
`Retry-After` header are unchanged, so `repairStepFor()` and the submit dialog
need no change.

`registration.ts:64` also calls `chargeBudget` (`RESOLVE_PER_USER`). It is
correctly keyed on the signed-in user rather than on a caller-chosen value, so
it has neither half of this problem and is out of scope.
