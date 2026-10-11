# Native iOS and Android app — implementation plan

Date: 2026-10-05
Status: stage 0 decisions made (2026-10-06); accounts and tools in progress.
Implementation happens on the owner's Mac.

Builds the app described in
[2026-09-22-ios-app-information-architecture.md](./2026-09-22-ios-app-information-architecture.md),
and prototyped as a clickable wireframe (the "GlideComp iOS prototype"
artifact). The framework decision — Expo, on React Native — is settled; this
document says how to get from nothing to the stores in stages the owner can
check one at a time.

---

## 1. The shape of the work

Ten stages. Each one ends with something the owner can **hold in their hand**:
a build on their own iPhone and Android phone, plus a short checklist. No stage
starts until the previous one has been checked and its feedback folded in.

| Stage | Delivers | The owner checks |
|---|---|---|
| 0 | Decisions, accounts, tools on the Mac | The open questions are answered |
| 1 | An empty app that builds, installs, and runs the engine | It installs on both phones; the engine line reads right |
| 2 | Browse comps, comp and task — read-only, signed out | Real comps read correctly; offline shows what you last saw |
| 3 | Scores, task scores and the report card | Report-card numbers match the website exactly |
| 4 | Sign-in, the Me tab, role-aware screens | Sign in on both phones; no sign-out on a dropped signal |
| 5 | Submit a track, from anywhere, offline-safe | Submit from an instrument app's share sheet, with no signal |
| 6 | My flights, waypoints, activity, send to instrument | Load a task into a real instrument |
| 7 | Everything an organiser does | Run a mock comp day from the phone alone |
| 8 | Task and comp analysis | Sections read like the website's |
| 9 | Native extras: links, notifications, iPad, accessibility | VoiceOver and TalkBack pass; links open the app |
| 10 | Beta at a real comp, then the stores | Pilots and an organiser use it for a comp |

Stages 2–8 each deliver part of the IA. Stage 1 de-risks the toolchain before
any screen is built; stages 9–10 finish and ship.

### What every stage delivers

- **A pull request** on its own branch (`mobile/stage-N-<slug>`), with the
  stage's checklist in the body, screenshots from both simulators, and the
  Cloudflare branch preview URL whenever web or worker code changed.
- **A build on the owner's phones** — an internal-distribution build or an
  EAS Update to the stage's channel, installed from a QR code. This is the
  app's equivalent of the web's branch preview.
- **Maestro flows** for the stage's journeys, run on both simulators, with the
  recordings attached to the PR.
- **New UI copy written out for approval** before it is final, per the
  "propose UI wording" rule. The wireframe's copy is a draft, not a decision.

### How feedback flows

The owner tries the build, then answers on the PR or in the session. Feedback
is folded into the same stage — a stage is done when the owner says so, not
when its checklist is green.

---

## 2. Architecture

### Repository layout

```
glidecomp/
├── mobile/                 ← NEW: the Expo app (@glidecomp/mobile)
│   ├── src/app/              Expo Router routes — the IA's screens
│   ├── src/                  components, hooks, platform modules
│   ├── .maestro/             end-to-end flows
│   ├── app.config.ts         bundle ids, plugins, universal links
│   ├── eas.json              build profiles and update channels
│   └── CLAUDE.md             mobile-specific rules (stage 1)
├── web/
│   ├── engine/             ← unchanged; imported by the app as it is
│   ├── client/             ← NEW: @glidecomp/client, shared by web and app
│   ├── frontend/             re-exports from @glidecomp/client
│   └── workers/              small additions only (§5)
```

`mobile/` joins the root `workspaces` list, so bun installs everything in one
lockfile and the app resolves `@glidecomp/engine` and `@glidecomp/client` as
workspace packages.

### What is shared, and what is not

| Shared with the website | Rewritten for the app |
|---|---|
| `@glidecomp/engine` — scoring, explanations, parsing, analysis, unchanged | Every screen |
| `@glidecomp/client` (new, stage 2) — the typed API client, retry rules, types, `slug`, `units`, `time`, number formats | Navigation (Expo Router, not React Router) |
| The report card's pure derivation from its four payloads (moved into `@glidecomp/client`, stage 3) | Charts (`react-native-svg`, sharing `scale.ts`) |
| The API — every route the website uses | The map (`@rnmapbox/maps`, same interaction spec) |

`@glidecomp/client` is extracted from `web/frontend/src` by **moving** the pure
modules and leaving re-exports behind, so the website's imports do not change
and its tests prove nothing moved. Nothing DOM-dependent goes into it.

### The stack

Version numbers are for the planned start; stage 1 pins what is current then.

| Concern | Choice | Why |
|---|---|---|
| Framework | **Expo SDK 58** (React Native 0.88, React 19.3) | SDK 58 makes native tabs and toolbars stable and targets iOS 27. Its stable release is due mid-October 2026; if it slips, start on 57 and upgrade in stage 2. |
| Navigation | **Expo Router**: native stack + `NativeTabs` | Real `UINavigationController` and system tab bar on iOS, Material 3 on Android; file routes mirror the web's URL shapes |
| Lists, forms, switches, pickers | **`@expo/ui`** (SwiftUI and Jetpack Compose) | The IA's grouped lists are literally the platforms' own; stable since SDK 56 |
| Sheets | Router `formSheet` presentation | Native sheets, swipe to dismiss, system Back on Android |
| Server state | **TanStack Query** + a persisted cache in `expo-sqlite` | Offline reading ("showing what you saw N minutes ago") and the retry rules in one place |
| Session | **`@better-auth/expo`** + `expo-secure-store` | The official integration for the auth stack we already run |
| Map | **`@rnmapbox/maps`** (Mapbox Maps SDK v11) | Same provider as the website, and the same interaction spec |
| Charts | **`react-native-svg`** | Emphasis charts drawn from the engine's own sampled curves |
| Files | `expo-document-picker`, `expo-file-system`, `expo-sharing` | Picking an IGC, background upload, sending `.xctsk` |
| Tests | **Jest** (`jest-expo`) + React Native Testing Library; **Maestro** for journeys | Unit and component tests run anywhere; Maestro drives both simulators |
| Builds and releases | **EAS Build** (or `eas build --local`), **EAS Submit**, **EAS Update** | Local builds on the Mac for speed; Expo's service for store submission and same-day JS fixes |
| Agent tooling | **XcodeBuildMCP**, Callstack's **agent-device**, Maestro, `@expo/agent-cli` | Claude builds, taps through and screenshots the app itself on both simulators |

### Which API a build talks to

There is no staging environment — branch previews share production's
workers — so the rule is about **mutations**:

| Build | API | Mutations |
|---|---|---|
| Development, simulator | Local workers on `:8790` (`bun run dev:workers`, seeded with `bun run seed`). The iOS simulator reaches `localhost`; the Android emulator reaches `10.0.2.2`. | Yes — local data only |
| Development, physical phone | Local workers through the dev tunnel (`dev-tunnel` skill) | Yes — local data only |
| Development, read-only | `https://glidecomp.com` | **Blocked in code**, with a banner saying so |
| Preview, beta and store | `https://glidecomp.com` | Yes |

A development build that could write to production is how a test comp ends up
in the public activity log. The guard lives in `@glidecomp/client`'s mobile
transport, not in each screen.

---

## 3. The rules, carried across

`CLAUDE.md` was written for the website, but most of its rules are about
competitions, not about web pages. This is how each applies to the app. Stage
1 writes them into `mobile/CLAUDE.md`.

| Rule | In the app |
|---|---|
| Australian English, and propose UI wording first | Unchanged. Every stage lists its new copy for approval. |
| Decisions must be explainable; report card (a)–(d) | The report card uses the engine's explainers unchanged, the published `ClassScore.gap_params`, emphasis charts only, and the track-cleaning chart drawn from the downloaded tracklog. |
| Registration is never guessed | The submit sheet calls `POST /api/comp/:comp_id/registration/resolve` and asks; it handles `409 identity_ambiguous` by asking again. Names only order the picker. |
| Every submission emails the pilot | The submit sheet says so up front, as the web form does; the email is sent by the server. |
| Audit log and score staleness | **Server-side, so the app inherits them.** The app only calls existing routes; a new route it needs (§5) follows the same "part of done" rule. |
| A failure to ask is not an answer (#481) | The hill is where requests fail. The mobile transport retries transient failures, never records one as "signed out" or "not found", and treats a 4xx as a real answer. Covered by a Jest test per rule and a Maestro flow with the network cut. |
| Search maintains itself | Nothing to do — the app only reads `GET /api/comp/search`. |
| A dead link is a searchable one | Universal links use the web's `${slug}-${id}` shapes; an unresolvable one opens the app's not-found screen, which uses `GET /api/comp/lookup` the same way. |
| Mobile first; one way to do a thing; a sheet dismisses with Back | Native by construction: system Back and swipe-down dismiss sheets. The "one way" rule applies screen by screen in review. |
| Altitudes in the reader's unit; radii always metric; zero is never missing | The same `units` module, now in `@glidecomp/client`. Waypoint editing stays metric. |
| Never read Terrain-RGB through a canvas | The altitude check reuses `analysis/elevation.ts`'s decoder (stage 7). |
| Never implement inline geo maths | The engine's `geo.ts` only. |
| Map interaction spec | `@rnmapbox/maps` implements `docs/mapbox-interactions-spec.md`; touch-only differences get written into the spec, not improvised. |
| Accessibility standard (WCAG 2.2 AA) | Applied to native: VoiceOver and TalkBack labels, Dynamic Type and font scaling, 44 pt targets, contrast. Audited in every stage, in full in stage 9. |
| A scoring change writes a note | The app never changes scoring. If an engine change is needed for Hermes, it gets a note like any other. |

---

## 4. The stages

### Stage 0 — Decisions and the Mac

**Goal:** nothing left to decide that would change a stage's work, and a Mac
that can build both apps.

**Decided** (2026-10-06 — the IA's §18 questions, plus the ones this plan
adds):

1. **The comp view's "You" group — kept.** #514 stopped one *task* being
   privileged in the task list. The You group carries the pilot's own state
   (your track, your rank), not a task, so it does not conflict — on the
   condition that it never becomes a featured task card.
2. **Submit is a tab.** Share-sheet import (stage 5) and the offline queue make
   submitting an app-wide action, not one that starts from a comp.
3. **The roster stays organiser-only**, as on the website. Opening it to
   registered pilots would be a server authorisation change for both clients,
   not an app decision.
4. **Comp-level organiser's notes are plain text**, with URLs made clickable.
   A pinned, expiring notice ("briefing moved to 09:30") is a separate feature,
   tracked as a GitHub issue and outside this plan.
5. **iPad: the comp owns the sidebar**, and tasks push within the detail
   column, keeping the stack intact.
6. **App name `GlideComp`; iOS bundle id and Android package
   `com.glidecomp.app`; URL scheme `glidecomp`.** Confirm the name is free in
   both stores before the first upload — these are hard to change after it.
7. **Sign in with Apple is added to the auth worker** (better-auth supports
   it), in stage 4. App Store guideline 4.8 expects it from an app that offers
   Google sign-in. Apple's "Hide My Email" gives a relay address that will
   never match a pilot's registration email, so those pilots always meet the
   "which one is you?" picker — correct under "registration is never guessed",
   and the picker must be designed with it in mind.
8. **Minimum OS: iOS 17 and Android 10**, or the Expo SDK's own floor if that
   is higher.
9. **Expo plan: the free tier** (local builds make it workable); move to the
   US$19-a-month plan only if queue times hurt.
10. **Developer accounts are personal.** The Apple Developer Program enrolment
    is the owner's individual account, so the stores name the owner as the
    seller. No D-U-N-S number is needed; moving the app to an organisation
    later is possible but slow, so revisit before the store release if that
    matters.
11. **Expo SDK 58 or 57** is settled when stage 1 starts, by whether 58's
    stable release (due mid-October 2026) has shipped.
12. **Mapbox mobile pricing** is checked against the account's free tier
    before stage 3 (§6).

**Set up** (owner, with Claude's help in the session):

- Apple Developer Program (US$99 a year) and Google Play Console (US$25 once).
- Expo account; `eas login` on the Mac.
- Xcode 27 with an iOS 27 simulator; an Android SDK with an emulator image.
  Android Studio is optional — the Mac uses Homebrew's
  `android-commandlinetools`, with `ANDROID_HOME` pointing at it.
- **JDK 17 for Gradle** (`brew install openjdk@17`, set as `JAVA_HOME`). React
  Native's Android build does not support newer JDKs, and the Mac's default
  `java` is newer.
- `watchman`, `cocoapods` and `eas-cli` from Homebrew.
- Mapbox: a separate token for the app, restricted to the bundle ids.
- Claude Code on the Mac with XcodeBuildMCP, agent-device and Maestro.
- At least 40 GB free disk: Xcode's derived data, the CocoaPods cache, Gradle
  and emulator images grow fast.

**Delivers:** this document updated with the answers; a one-page record of
accounts and identifiers, [mobile-accounts.md](./mobile-accounts.md) (no secrets in the repo).

**Owner checks:** the decisions read as intended; `xcodebuild -version`, an
Android emulator and `eas whoami` all answer.

---

### Stage 1 — An app that builds, installs and runs the engine

**Goal:** prove the whole toolchain before building a single real screen. Every
risk that could sink the plan surfaces here, cheaply.

**Build:**

- `mobile/` created from `create-expo-app`, joined to the bun workspaces.
- Expo Router with the four tabs (Comps, Submit, My flights, Me), each an empty
  native stack; Submit opens an empty sheet.
- App name, icon placeholder, bundle ids and URL scheme from stage 0.
- **An engine smoke test on the device**: parse a bundled IGC sample and a
  `.xctsk`, score it, and print the distance and a time in the comp's zone.
  This proves Hermes runs the engine, including the two places it touches
  platform APIs:
  - `xctsk-parser.ts` uses `DecompressionStream` when no inflater is passed;
    the app passes one (`fflate`), so the engine does not change.
  - Time zones via `Intl.DateTimeFormat` — checked on both platforms.
- Jest and React Native Testing Library wired, with one test of each kind.
- The first Maestro flow: launch, visit each tab.
- `bun run test:mobile` and `bun run typecheck:mobile`, added to `test:all`
  and to the CI workflow's test job.
- `mobile/CLAUDE.md` with the §3 rules and the build/run commands.

**Known risks to retire:**

- **Two copies of React.** The website pins React 19.2.8; the app must resolve
  the same single copy or hooks break mysteriously. Settle it here with bun's
  resolution and Metro's monorepo config. *Settled in stage 1:* bun's isolated
  installs give each workspace its own React — 19.3.0 for the app (which React
  Native requires exactly), 19.2.8 for the website — and everything the app
  loads resolves 19.3.0. See `mobile/CLAUDE.md`.
- **TypeScript 7.** The repo is on TypeScript 7; Expo transpiles with Babel, so
  only type-checking is affected. Confirm `tsc` handles the app's types.
- **The scoring fingerprint.** The engine imports a generated file; the app's
  build must run `bun run engine:fingerprint` first, like every other entry
  point.

**Owner checks:**

- The app installs on your iPhone and Android phone from a QR code.
- The four tabs work with the system tab bar; Back and swipe behave natively.
- The engine line shows the right distance and local time for the sample.

---

### Stage 2 — Browse: comps, comp, task (read-only, signed out)

**Goal:** a pilot with no account can find their comp and today's task, and can
still read it with no signal.

**Build:**

- **`@glidecomp/client`** extracted from the website: the typed Hono client
  with an injectable base URL and transport, `fetchWithRetry`, `retry.ts`, the
  shared types, `slug`, `units`, `time` and number formatting. The website
  re-exports; `bun run test:all` and the e2e suite stay green.
- **Comps** — Flying now, Upcoming, Past (Yours arrives with sign-in in stage
  4); the bottom search over `GET /api/comp/search`, with results grouped by
  kind and opening the deepest match.
- **Comp** — the card (name, class of wing, format, classes, dates, organisers);
  Tasks grouped by day; Results with Scores and Analysis rows (stubs until
  stages 3 and 8); Competition with Waypoints and Activity rows (stubs until
  stage 6).
- **Task** — the card with stopped and closed states in words; Route →
  Turnpoints (altitudes in the reader's unit, radii metric); The day → Weather
  with the organiser's notes and the forecast, labelled as a forecast.
- **Offline reading**: TanStack Query with a persisted cache; a "No signal —
  showing what you saw N minutes ago" banner with Retry; nothing is replaced by
  an empty state when a request fails.
- **Units preference** stored locally (moves to the account in stage 4).

**Owner checks:**

- Open three real comps on glidecomp.com and on the phone: same tasks, same
  turnpoints, same altitudes in your chosen unit.
- Search for a pilot, a task and a turnpoint code.
- Open a comp, switch on airplane mode, force-quit, reopen: the comp is still
  there, with the banner.

---

### Stage 3 — Results: scores and the report card

**Goal:** Q5 and Q6 from the IA — "Where am I overall?" and "Why did I get that
score?" — answered on the phone, with numbers identical to the website.

**Build:**

- **Scores** — class picker; Overall, Top 3 by task, Teams, By task; the
  freshness line (computed at, recomputing); export via the share sheet.
- **Task scores** — by class; withheld pilots seated last at 0 with reasons.
- **A pilot's series** — task by task; FTV explained in a row.
- **Report card** — the summary list of sections with their points; each opens
  to its substituted arithmetic (rule (a)), with GAP parameters from the
  published `ClassScore.gap_params` (rule (b)).
  - The **derivation is moved, not copied**: the pure function in
    `PilotScoreDetail.tsx` that builds the narrative from the four payloads goes
    into `@glidecomp/client`, and both the website and the app call it.
  - **Emphasis charts** with `react-native-svg`, sampled from
    `score-explanation-charts.ts`; the shared geometry moves from
    `src/react/charts/scale.ts` into `@glidecomp/client` (rule (c)).
  - **Track map**: `@rnmapbox/maps` with the route and the pilot's track,
    following the map interaction spec.
  - **Track data cleaning** chart from the downloaded tracklog, never clipping
    the raw excursion (rule (d)).
  - Every section links to the GAP guide in an in-app browser.

**Owner checks:**

- Pick three report cards — one in goal, one landed out, one with a penalty —
  and compare every number with the website. (A Jest test already asserts the
  derivation is the same function; this checks the presentation.)
- The emphasis charts mark you, and only you.
- The map pans and zooms the way the website's does.

---

### Stage 4 — Sign-in, the Me tab, role-aware screens

**Goal:** the same account as the website, kept safely on the phone, and every
screen showing each person only what they may use.

**Server changes** (auth-api, with its tests and `docs/auth.md`):

- Add the `expo()` plugin from `@better-auth/expo`.
- Add the app's scheme to `trustedOrigins` (`glidecomp://`, plus the
  development scheme in local dev only).
- Sign in with Apple (stage 0, decision 7).

**Build:**

- **Sign-in** — email code (OTP), Google and Apple, from the Me
  tab and whenever an action needs it; never as an interruption on launch.
- **Session** in the secure store; the `session_data` cookie cache works
  unchanged because it is just another cookie.
- **Identity follows #481**: a dropped request at launch shows the last known
  user and retries; only a real answer signs anyone out.
- **Me** — name and contact, pilot IDs, units (now synced to the account),
  appearance, sign out, delete account (Apple requires in-app deletion; the
  website's flow already exists).
- **Role-aware screens** — `is_admin` from the comp payload drives organiser
  rows; registration drives the comp view's "You" group
  and the task view's "Your track"; Comps gains "Yours".
- **Hidden comps** stay not-found for anyone who is not an organiser, naming
  nothing.

**Owner checks:**

- Sign in with an email code on both phones; restart the phones; still signed
  in.
- Airplane mode, then relaunch: still signed in, with the offline banner.
- Your comps appear under Yours; an organiser account sees the organiser rows,
  and a pilot account does not.
- Delete a throwaway account from the app.

---

### Stage 5 — Submit a track

**Goal:** Q3 — "I've landed, how do I hand in my track?" — in seconds, from
anywhere, with or without signal.

**Build:**

- **The submit sheet**, from the Submit tab and from the task view: which task
  (prefilled where known), who the track is for (resolved via
  `registration/resolve`; never guessed), the IGC file.
  - Anonymous submission, as on the website (`igc-anon`), where the comp allows
    it.
  - Organisers may submit on a pilot's behalf.
  - The promise that the registered pilot is emailed, shown up front.
- **Share-sheet import** — "Open in GlideComp" for `.igc` files: an iOS
  document type with an import flow and an Android intent filter, so a file
  shared from an instrument's app lands in the sheet with step 3 already done.
- **An upload queue** — submissions are written to disk first, then sent with a
  background upload that survives the app being backgrounded; a queued track
  says "waiting for signal", never "submitted". The queue is visible under Me.

**Owner checks:**

- Submit a real track to a seeded local comp from the Files app, and again from
  an instrument's companion app via Share.
- Submit with airplane mode on; the track waits in the queue; it sends when the
  signal returns; the email arrives.
- As a pilot on a roster with unclaimed entries, the app asks which one is you.

---

### Stage 6 — My flights, waypoints, activity, sending tasks

**Goal:** the pilot's day before and after the flight — Q2, "how do I get the
task into my instrument?", and the personal library.

**Build:**

- **My flights** — competition flights linking to their report cards; the
  personal library over the user-files API; storage used.
- **Waypoints** — the list with the 48 pt pin strip that flies the map; the
  whole row flies the map when read-only; filter; zero altitude as a known
  altitude, an absent one as absent.
- **Activity** — the public audit log with its filters.
- **Send to instrument** — `.xctsk` via AirDrop, Files and the share sheet; a
  QR code full-screen for briefings; waypoint files in each device format from
  the engine's exporters (OziExplorer altitudes in feet, as the format
  requires).

**Owner checks:**

- Load today's task into a real instrument from the phone, by file and by QR.
- Export waypoints for two instrument types and import them.
- The activity log matches the website's, filter by filter.

---

### Stage 7 — The organiser

**Goal:** an organiser can run a competition day from the hill with only a
phone — the IA's Q7, Q8 and Q10.

**Build (all over existing routes, unless noted):**

- **Create a comp** (sheet; drops you into it as organiser) and **add a task**
  (drops you into the task).
- **Route editor** — map, turnpoint list, start and goal settings; altitudes in
  the reader's unit, radii metric.
- **Task settings** — name, date, classes, stop time, open for submissions,
  delete.
- **Weather notes** editing.
- **Pilots & tracks** — needs-attention first; status (present, absent, did not
  fly); penalty; upload on behalf; manual flight (S7F §9.2.2); delete and
  restore; override a track-quality verdict.
- **Roster** — the list of sheets; add, edit, remove; CSV import via the
  document picker; CIVL rankings fill; unclaimed entries marked.
- **Comp settings** — General, Access, Pilot classes, Scoring and GAP
  parameters, Organisers, delete; every row shows its value.
- **Check altitudes** — the review sheet, both altitudes on every row, nothing
  changes until Apply; decoding reuses the engine-side decoder.
- **Recompute scores.**
- **New backend: comp-level organiser's notes** — migration, `PATCH` route,
  `audit()`, deliberately no score bump; shown on the comp card on the website
  as well as in the app.

**Owner checks:**

- On a seeded local comp: create a task, set its route, mark a pilot absent,
  apply a penalty, upload on someone's behalf, recompute — all from the phone.
- Every one of those appears in Activity as a readable sentence.
- Two people (organiser and pilot) on two phones see the changes arrive.

---

### Stage 8 — Analysis

**Goal:** the task and comp analyses on the phone, in their fixed order.

**Build:**

- **Task analysis** — the contents list (one row per section, with its one line
  of this-task fact), each section on its own screen, and pilot similarity.
- **Comp analysis** — the aggregation, linking each task analysis under its own
  task, not under the comp.
- **Pending state** — a cold analysis returns `pending`; the screen says
  "working this out" and polls, as the website does.
- **Charts** — the day profile on one shared time axis; tables as the exact
  reading under each chart; an unknown series kind is ignored, never a crash.
- **3D replay** stays on the website for now, opened in an in-app browser; a
  native replay is a later decision, not part of this plan.

**Owner checks:** each section against the website's for two tasks; the
pending state on a task whose analysis is cold.

---

### Stage 9 — Native extras and finish

**Goal:** the things only an app can do, and the quality bar.

**Build:**

- **Universal links** — `apple-app-site-association` and `assetlinks.json` in
  `web/frontend/public/.well-known/`, with the right content types in
  `_headers` (checked against the CSP and the SSR Function's routes); every
  public URL shape opens the matching screen, and a dead one opens the
  not-found repair.
- **Notifications** (opt-in, per comp): your track was received and scored, a
  task was published, scores recomputed, a penalty applied to you. New backend:
  a push-token table and sends through Expo's push service, triggered from the
  same places that already send email. Never a replacement for the email.
- **iPad** — the split view decided in stage 0.
- **Optional, if worth it after the beta**: a home-screen widget for today's
  task; a Live Activity for a task in progress.
- **Accessibility audit** — VoiceOver and TalkBack through every journey,
  Dynamic Type at the largest sizes, contrast in light and dark, reduced
  motion.
- **Performance** — cold start, list scrolling on a large comp, report-card
  render time, measured on a mid-range Android phone.

**Owner checks:** tap a glidecomp.com link in Messages and in WhatsApp — the
app opens at that screen; turn on VoiceOver and submit a track; the app is
usable at the largest text size.

---

### Stage 10 — Beta at a real comp, then the stores

**Goal:** real pilots and a real organiser, on a real hill.

**Build:**

- **TestFlight** and **Google Play internal testing** for a named group.
- **Crash reporting** — choose a free tier (Sentry's, or Expo's own insights),
  with personal data scrubbed.
- **Store listings** — screenshots from the simulators, the description, the
  privacy labels (App Store) and data-safety form (Google Play), the review
  notes with a demo account.
- **Release process** — EAS Update for JS fixes during a comp; store builds for
  anything native; a written checklist in `mobile/RELEASING.md`.

**Owner checks:** a beta at one competition — at least one organiser and a
handful of pilots — with their feedback triaged before the store release.

---

## 5. Backend changes this plan needs

Kept deliberately small; each follows the existing "part of done" rules.

| Stage | Change | Audit | Score bump |
|---|---|---|---|
| 4 | auth-api: `@better-auth/expo` plugin, app scheme in `trustedOrigins` | — | — |
| 4 | auth-api: Sign in with Apple | — | — |
| 7 | competition-api: comp-level organiser's notes (migration, `PATCH`) | Yes | No — not a scoring input |
| 9 | Static: `.well-known` files for universal links | — | — |
| 9 | competition-api: push-token storage and notification sends | — | — |

---

## 6. Costs

| Item | Cost |
|---|---|
| Apple Developer Program | US$99 a year |
| Google Play Console | US$25 once |
| Expo | Free tier to start; US$19 a month if build queues hurt |
| Expo push notifications | Free |
| Mapbox | Within the existing account's free mobile tier at this scale — checked in stage 0 |
| Crash reporting | A free tier |

---

## 7. Risks

| Risk | Mitigation | Retired in |
|---|---|---|
| The engine misbehaves on Hermes (time zones, decompression) | On-device smoke test before any screen; injected inflater | Stage 1 |
| Duplicate React in the monorepo | Pin one copy; Metro monorepo config | Stage 1 |
| Expo SDK 58 slips | Start on 57; upgrade is non-breaking by Expo's own policy | Stage 1 |
| `@rnmapbox/maps` lags an Expo SDK | Pin the SDK the map supports; the map is isolated behind one component | Stage 3 |
| App Store rejection over sign-in (guideline 4.8) | Decide Apple sign-in in stage 0 | Stage 4 |
| App Store rejection over account deletion | In-app deletion from the start | Stage 4 |
| Background uploads behave differently on each OS | A queue that survives restarts; tested with the network cut on both | Stage 5 |
| A development build writes to production | Writes blocked in code unless the build targets local workers | Stage 2 |
| Two report-card implementations drift | There is only one: the derivation moves into `@glidecomp/client` | Stage 3 |
| Scope grows past the IA | Each stage's checklist is the scope; extras go to GitHub issues | Every stage |

---

## 8. What happens next

1. The owner moves this session to the Mac.
2. Stage 0: answer the decisions in §4, set up the accounts and tools.
3. Stage 1 starts on a fresh branch from `master`, `mobile/stage-1-skeleton`.
