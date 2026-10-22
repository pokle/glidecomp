# Releasing the app

Stage 10 of [the mobile app plan](../docs/2026-10-05-mobile-app-plan.md):
a beta at a real competition, then the stores. This is the checklist; the
accounts and identifiers it names are in
[docs/mobile-accounts.md](../docs/mobile-accounts.md).

## What ships how

| Change | Ships as | Reaches phones |
|---|---|---|
| JavaScript only — a screen, a sentence, a fix in `src/` or `@glidecomp/client` | **EAS Update** to the build's channel | On the next launch, for builds of the same runtime version |
| Anything native — a new `expo-*` module, `app.config.ts`, a config plugin, an SDK upgrade | **A store build** (EAS Build, then EAS Submit) | After review: TestFlight in hours, the App Store in a day or two; Play's internal track in minutes |

The runtime version is the app's **fingerprint** (`runtimeVersion: { policy:
'fingerprint' }` in `app.config.ts`): Expo hashes the native side, so an
update can never reach a build whose native code it does not match. A JS
change that needs a new native module will not reach the phones that lack
it — it waits for the store build, which is the point.

**During a competition, only EAS Update.** A store build is a day's risk on
a hill with no time for one. If a fix needs native code, it waits until the
competition is over.

## Build profiles (`eas.json`)

| Profile | Variant | Channel | For |
|---|---|---|---|
| `development` | `com.glidecomp.app.dev` | `development` | The Mac's simulators and the owner's phone, with the dev client |
| `preview` | `com.glidecomp.app.dev` | `preview` | Internal testers' phones, side by side with the store app; writes to production |
| `production` | `com.glidecomp.app` | `production` | TestFlight, Play internal testing, then the stores |

Build settings the app reads (none secret, none committed): set them as EAS
environment variables for each profile, or in the root `.env` for a local
build.

| Setting | Needed for |
|---|---|
| `EAS_PROJECT_ID` | Notifications and EAS Update (from `eas init`) |
| `PUSH_NOTIFICATIONS=1` | iOS notifications in a **development** build — only when the signing team has the Push Notifications capability (a free Personal Team does not). Store builds have it on; leave it unset for `bun run ios` on a Personal Team |
| `REACT_NATIVE_MAPBOX_PUBLIC_TOKEN` | The maps |
| `GOOGLE_WEB_CLIENT_ID`, `GOOGLE_IOS_CLIENT_ID` | Google sign-in |
| `SENTRY_DSN` | Crash reports |
| `SENTRY_ORG`, `SENTRY_PROJECT` | Readable crash stacks (source-map upload) |

And on the website's side, for universal links: the Pages variables
`APPLE_TEAM_ID` and `ANDROID_CERT_SHA256` (`functions/.well-known/`).

## A release, step by step

1. **On `master`, green.** `bun run test:all` and `bun run typecheck:all`;
   the Maestro flows on both simulators (`bun run --cwd mobile e2e`).
2. **Bump the version** in `app.config.ts` (`version`, which is what the
   stores show). EAS increments the build numbers itself
   (`autoIncrement` in `eas.json`).
3. **Build**: `eas build --profile production --platform all`.
4. **Submit**: `eas submit --profile production --platform ios` (to
   TestFlight) and `--platform android` (to Play's internal track).
5. **Test the build itself**, not the simulator: install from TestFlight and
   Play, and walk the owner checks of every stage that changed.
6. **Promote**: TestFlight → App Store review; Play internal → production.
7. **Tag** the commit `mobile-vX.Y.Z`.

## A JavaScript fix during a competition

1. The fix on a branch, reviewed and green like any other.
2. `eas update --channel production --message "<what it fixes>"`.
3. Ask one tester to relaunch the app twice (the update downloads on the
   first launch, applies on the second) and check the fix.
4. If it made things worse: `eas update:rollback` to the previous update.

## Crash reports

**Sentry's free tier**, through `@sentry/react-native` — the version Expo
SDK 58 lists. It is off unless the build has `SENTRY_DSN`, and it sends no
personal data:

- no user identity (no account id, email or name is attached);
- no request or response bodies, and no URLs' query strings or fragments
  (the sign-in link's code rides in a fragment);
- no email address anywhere in a message or a stack's text;
- breadcrumbs keep the screen, and a request's method, bare URL and status;
  console output is dropped;
- no screenshots, view hierarchy, tracing or session replay.

`src/lib/crash-scrub.ts` holds those rules (`src/crash-reports.ts` only
starts Sentry with them), and `__tests__/crash-scrub.test.ts` checks a report
with an email address in it comes out without one. Me → This build says
whether a build sends reports, and which update it is running.

Source maps: with `SENTRY_ORG` and `SENTRY_PROJECT` set too, the config
plugin uploads them during the build, using the EAS secret
`SENTRY_AUTH_TOKEN` — the one secret in this list, so never in `.env`.

## The store listings

The copy is in `mobile/store/` for review before it is pasted into App
Store Connect and the Play Console: the description, the privacy answers
(App Store "App Privacy" and Play "Data safety"), and the review notes with
a demo account. Screenshots come from the simulators with `bun run screenshots`
(`.maestro/store/screenshots.yaml`).

## The beta

One competition, at least one organiser and a handful of pilots, on the
`production` profile through TestFlight and Play internal testing. Their
feedback goes to GitHub issues, labelled `mobile-beta`, and is triaged before
the store release.
