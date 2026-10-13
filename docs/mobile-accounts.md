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

Added in stage 4, on iOS only, as a native sign-in: the app sends the token
Apple gives it and the auth worker checks it against Apple's public keys, with
the bundle ids as its audience. It needs, from the Apple Developer account
(paid): the **Sign in with Apple capability on the App ID** — for
`com.glidecomp.app`, and for `com.glidecomp.app.dev` if development builds
signed by the paid team should offer it (build them with `APPLE_SIGN_IN=1`).

No secret is involved. A Services ID and a private key are only for Apple's
WEB flow, which neither the website nor the app uses; if that ever changes,
the key goes into the auth worker's secrets, never into this repo.

## Google sign-in in the app

The app signs in with Google natively, which needs two more OAuth clients in
the Google Cloud Console project that holds the website's web client:

| Client | Needs | Goes in |
|---|---|---|
| iOS | Bundle id (`com.glidecomp.app`, and `.dev` for development builds) | `GOOGLE_IOS_CLIENT_ID` in the root `.env` (or EAS); and `GOOGLE_NATIVE_CLIENT_IDS` on the auth worker |
| Android | Package name and the signing key's SHA-1 (the debug keystore's for development; Play's app signing key for the store) | `GOOGLE_NATIVE_CLIENT_IDS` on the auth worker |

The app also needs the website's web client id as `GOOGLE_WEB_CLIENT_ID`.
Client ids are not secrets — every app that signs in with Google carries its
own — but they stay out of the repo with the other build settings.
