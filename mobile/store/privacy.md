# Privacy answers — draft for review

What the app collects, as App Store Connect ("App Privacy") and the Play
Console ("Data safety") ask it. Answers follow the app as built; check each
against the website's privacy policy (/legal) before submitting.

| Data | Collected | Linked to the person | Used for | Optional |
|---|---|---|---|---|
| Email address | Yes, to sign in | Yes | App functionality (sign-in, track notices) | Signing in is optional; browsing is not gated |
| Name | Yes, the account's display name | Yes | App functionality (scores, activity log) | Required once signed in |
| Pilot IDs, phone, glider, emergency contact | Yes, if the pilot fills them in | Yes | App functionality | Optional |
| Location | No — the app never asks for the phone's location | — | — | — |
| Flight tracks (IGC files) | Yes, when the pilot submits one | Yes | App functionality (scoring) | Optional |
| Push token | Yes, when a competition's notifications are turned on | Yes | App functionality | Optional |
| Crash data | Yes, if the build carries a crash-report key | No — no identity is attached | App functionality (diagnostics) | — |

- **Tracking (App Store sense)**: none. No data is shared with advertisers
  or data brokers, and there is no advertising.
- **Encryption**: all traffic is HTTPS (the standard exemption).
- **Account deletion**: in the app, Me → Delete account (guideline 5.1.1(v)).
- **Public by design**: competition scores, report cards and the activity log
  are public for non-hidden competitions, as on the website.
