# Mobile app — accounts and identifiers

The record that stage 0 of
[2026-10-05-mobile-app-plan.md](./2026-10-05-mobile-app-plan.md) delivers. It
names every account and identifier the app depends on, and where each one is
managed. **No secrets go in this file** — no keys, tokens, passwords or
certificates. They live in the services named here, in EAS secrets, or in the
owner's keychain.

## Identifiers

These are hard to change after the first store upload.

| What | Value |
|---|---|
| App name | GlideComp |
| iOS bundle id | `com.glidecomp.app` |
| Android package | `com.glidecomp.app` |
| URL scheme | `glidecomp` |
| Universal-link domain | `glidecomp.com` |

## Accounts

| Service | Holder | Used for | Status |
|---|---|---|---|
| Apple Developer Program (US$99 a year) | Owner, personal (individual) enrolment | TestFlight, App Store, Sign in with Apple, push certificates | To enrol |
| Google Play Console (US$25 once) | Owner, personal | Internal testing, Play Store | To register |
| Expo (free tier) | Owner | EAS Build, Submit and Update | To create; then `eas login` on the Mac |
| Mapbox | Existing account | A separate app token, restricted to the bundle ids | Token to create |

A personal account names the owner as the seller in both stores.

## Sign in with Apple

Added to the auth worker in stage 4. It needs, from the Apple Developer
account: an App ID with the capability enabled, a Services ID for the web
flow, and a private key. The key is a secret: it goes into the auth worker's
secrets, never into this repo.
