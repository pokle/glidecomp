# Login Nudges — Jobs-to-be-Done Plan

## 1. Goal

When a user arrives at GlideComp (already signed in, or just completed
Google OAuth), surface the most likely *job they came here to do* so they
reach it in one click instead of navigating through comp lists.

Today the post-login experience drops every user on the same "My Flights"
page (`web/frontend/src/dashboard.ts`) regardless of role. A comp admin
running a competition, a pilot flying today's task, and a casual user
browsing results all see the same file manager. This plan closes that gap.

## 2. Motivating Jobs-to-be-Done

Ranked by signal strength (most actionable first):

1. **"I'm running a competition right now."** — User is a `comp_admin` of
   a comp whose `task_date` window includes today, or whose close_date is
   in the future and creation_date is recent. They need: scoreboard,
   task management, pilot management.
2. **"I'm flying today's task."** — User is a `comp_pilot` in a comp that
   has a `task` with `task_date == today`, and their `task_track` row is
   missing. They need: upload IGC, or mark "did not fly".
3. **"I flew yesterday and I'm checking my score."** — `task_track` exists
   for a task with `task_date == today-1`. They need: scoresheet, their
   flight analysis.
4. **"I'm scoring / penalising on behalf of another pilot."** — Comp admin
   of a comp with today's task where one or more `comp_pilot` rows have
   no `task_track` after the task window. They need: pilot-by-pilot
   update UI.
5. **"I'm organising an upcoming competition."** — Admin of a comp whose
   earliest task_date is in the future (> today). They need: waypoints,
   pilot registration, XCTSK task builder.
6. **"I'm a returning pilot with no current comp."** — Fall-through: show
   the existing "My Flights" dashboard (today's behaviour).

## 3. How to determine the job — rules, not ML

Run a small rules engine on the client with data fetched from one new
endpoint. Each rule produces a `Nudge` with a priority score. The highest
scored nudge becomes the primary CTA; the next two become secondary.

```ts
type Nudge = {
  id: string;                // "admin-live-comp:123"
  priority: number;          // 0-100
  kind: "admin-live" | "pilot-upload" | "pilot-score"
      | "admin-missing-tracks" | "admin-upcoming" | "default";
  title: string;             // "Mumbai Open is live today"
  body: string;              // "3 pilots haven't uploaded yet"
  href: string;              // "/comp/mumbai-open-2026/"
  dismissible: boolean;
  dismissKey?: string;       // persist dismissal until data changes
};
```

**Rule examples** (pseudocode, evaluated in order, each emits 0..n nudges):

```
now = today (UTC + pilot TZ? see §7)

for each comp where is_admin:
  if any task.task_date == now:               → admin-live (prio 95)
  if any task.task_date == now and
     any registered pilot has no task_track:  → admin-missing-tracks (prio 90)
  if earliest future task.task_date > now:    → admin-upcoming (prio 50)

for each comp where user is comp_pilot:
  if task.task_date == now and no task_track: → pilot-upload (prio 100)
  if task.task_date == now-1 and task_track:  → pilot-score (prio 70)
```

Priority is deliberately hard-coded; the signal is strong enough that we
don't need personalisation. `pilot-upload` outranks `admin-live` because
it's the more time-sensitive action (you can't upload your flight after
the window closes, but you can admin a comp any time).

## 4. Data needs — one new endpoint

Build **`GET /api/user/nudges`** in `web/workers/competition-api/` that
returns a pre-computed list for the authed user. Doing this server-side
keeps the D1 joins in one place and lets us add audit-log derived nudges
later (e.g. "your pilot list was updated").

Response:

```json
{
  "nudges": [
    {
      "id": "pilot-upload:comp_42:task_7",
      "priority": 100,
      "kind": "pilot-upload",
      "title": "Upload today's track",
      "body": "Task 3 — Bright → Mt Buffalo",
      "href": "/comp/bright-open-2026/task/3/",
      "dismissible": true,
      "dismissKey": "pilot-upload:task_7"
    }
  ],
  "generated_at": "2026-04-11T02:00:00Z"
}
```

Server-side implementation sketch:

1. Query `comp_admin` joined with `comp` and `task` — find comps where
   user is admin and (task today | upcoming task | just-closed task).
2. Query `pilot` → `comp_pilot` → `comp` → `task` — find comps where user
   is registered as a pilot with a task today or yesterday.
3. For each admin row, additionally check `comp_pilot` LEFT JOIN
   `task_track` to count missing tracks.
4. Apply the priority rules from §3. Return sorted by `priority` desc.

**Files to touch:**

- `web/workers/competition-api/src/routes/user.ts` *(new)* — route handler.
- `web/workers/competition-api/src/index.ts` — mount the route.
- `web/workers/competition-api/src/routes/user.test.ts` *(new)* — unit
  tests for the rules (this is an "explainable decision" per CLAUDE.md
  coding rules, so each rule must have a test case).

This endpoint is **read-only**, so no `audit()` call needed.

## 5. How to surface nudges

Two surfaces, same data source:

### 5a. Persistent nudge in the nav bar

Add a single "bell" or badge button in the header of
`web/frontend/src/nav.ts:22-27`, just left of "My Flights". Wire it to a
popover (Basecoat `popover`) listing the top 3 nudges as cards. Badge dot
appears if `nudges.length > 0`, hidden if zero.

This is cheap, lives on every authed page, and doesn't steal real estate
from empty-state dashboards.

Implementation:

- Extract `fetchNudges()` into `web/frontend/src/nudges/client.ts`.
- Export `renderNudgeMenu(nudges, mountEl)` in
  `web/frontend/src/nudges/menu.ts`.
- Call from `initNav()` in `nav.ts:64-78` *after* `getCurrentUser()`
  succeeds. No fetch for anonymous users.
- Cache the response in `sessionStorage` keyed by user id for 60s so
  multi-page navigation doesn't re-hit the worker.

### 5b. Post-login hero card on the landing page

On `dashboard.html` / `dashboard.ts`, if `nudges[0].priority >= 90`,
render a full-width hero card above the tabs showing the top nudge with a
big CTA button. This is the "teleport me where I need to go" UX for the
obvious cases (pilot on task day, admin running a live comp).

Lower-priority nudges stay in the nav bar popover only — we don't want
the dashboard cluttered with "here's an upcoming comp" when the user
opened the page to manage files.

A one-time "Take me there now" auto-redirect is **out of scope** — always
show the card and let the user click. Auto-redirects feel hostile when
the rule is wrong.

## 6. Dismissal & persistence

- Each nudge has a `dismissKey`. Dismissing writes
  `localStorage["glidecomp:nudge-dismissed:<key>"] = <ISO date>`.
- `dismissKey` deliberately omits volatile state. Example:
  `pilot-upload:task_7` — if the user uploads later that task_track
  exists and the rule stops emitting the nudge, so dismissal becomes
  moot. If they deliberately dismiss without uploading, it stays
  dismissed for the day.
- Nudge is re-shown if `generated_at.date > dismissed_at.date` (new day,
  new chance).
- Server does **not** track dismissals. Keeping this client-side is
  cheap and avoids a write endpoint.

## 7. Timezone handling — the one hard bit

"Today's task" is ambiguous across timezones. Options:

1. **Use the comp's timezone** (preferred). `comp` doesn't currently
   store a timezone — we'd add `comp.timezone` (IANA string) and default
   to comp location lookup. The `task_date` column is a local date.
2. **Use the user's browser TZ.** Simpler, wrong for pilots who travel
   to comps in other timezones.

Recommendation: ship v1 with option 2 (browser TZ) because it's zero
schema change, and accept the edge case. Add a `comp.timezone` column as
a follow-up if users report confusion. This is a schema change that
affects audit logs, so it needs its own plan.

## 8. Rollout plan

1. **PR 1 — Backend**: `GET /api/user/nudges` + tests. No frontend yet.
   Can be tested directly via fetch.
2. **PR 2 — Nav popover**: wire the bell icon, fetch on login, render
   top 3 nudges. Sticky across all pages.
3. **PR 3 — Dashboard hero card**: surface top nudge on the landing
   page when priority ≥ 90.
4. **PR 4 — Telemetry** *(optional, out of scope for now)*: log which
   nudges are clicked vs. dismissed to tune priorities.

## 9. What this plan deliberately does **not** do

- No ML, no personalisation, no A/B. Rules are enough.
- No push notifications / email. Login-only surfacing.
- No "did not fly" explicit status column — that's a separate
  task-management enhancement. For now the nudge links to the existing
  upload page where the user can choose.
- No server-side dismissal tracking.
- No Basecoat component changes — we use existing popover + card.

## 10. Open questions for review

1. Is "today in browser TZ" acceptable for v1, or does it need to be
   blocked on adding `comp.timezone`?
2. Should the nav bell show a numeric badge or just a dot?
3. For admins running a live comp, should `admin-missing-tracks`
   *replace* `admin-live` or sit alongside it? Currently the plan lets
   both emit and sort by priority (missing-tracks loses, 90 vs 95).
   Worth revisiting once we see real data.
4. Should `getCurrentUser()` be extended to include nudge count so we
   avoid a second round-trip, or keep the endpoints cleanly separated?
   Leaning separate for now — auth and nudges have different cache TTLs.
