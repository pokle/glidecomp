# Authentication

> **Status:** Superseded — frozen historical design doc, kept for the reasoning
> only. For what actually runs, see [auth.md](./auth.md).
>
> The text below is the original sketch and is **not** a description of the
> shipped system. Two notes for anyone reading it against the code:
>
> - **Email login shipped, but differently.** The magic-link idea here became a
>   passwordless **6-digit email OTP** (Better Auth's `emailOTP` plugin,
>   10-minute codes, rate-limited on three layers) alongside Google OAuth — not
>   a login link valid for an hour. See
>   [2026-07-14-email-otp-signin-plan.md](./2026-07-14-email-otp-signin-plan.md).
> - **"The session token lasts forever" is superseded.** Sessions are 60-day
>   rolling, refreshed at most daily: active users stay signed in indefinitely,
>   idle sessions expire after 60 days.

# Roles

- Admin - system administrators - me.
- User - pilots, competition organisers
- Unauthenticated users

# Registration & login

- Admin: Must be impossible to register. A whitelist of email addresses in source code.
- User: Can register and login. Users can be banned.

# Authentication flow

- Admin: 
  - Must be impossible to register. 
  - A whitelist of email addresses in source code.
- User:
  - Login: Users can login by entering their email address. System sends them a login link via email. The login link is valid for 1 hour (and can be used multiple times in that hour). Once the login link is used, the user is logged in with a secure session token. The session token lasts forever.
  - Logout: Users can logout. The session token is invalidated.
  

# Authorization

- Admin: 
  - Can access all resources.
  - Can impersonate other users.
- User: 
  - Can access their own resources and public resources. 
  - Cannot impersonate other users.
- Unauthenticated users: 
  - Can access public resources.
  - Can login as a user (only)
  - Can not impersonate other users.
