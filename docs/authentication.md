# Authentication

> **Status:** Implemented. See [auth.md](./auth.md) for the current architecture and setup.
>
> The spec below is an early design doc — some details (e.g. email-based login) were not implemented. Google OAuth via Better Auth is the actual implementation.

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
