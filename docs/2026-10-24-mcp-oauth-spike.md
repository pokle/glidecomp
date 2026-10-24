# MCP over OAuth: phase 0 spike findings — 2026-10-24

*Findings from phase 0 of [the plan](2026-10-24-mcp-oauth-plan.md). The code
on this branch is a spike: unreviewed and untested beyond what is below. It is
not for merging.*

## Result

The whole flow works against the local stack. A scripted client did each step
the way a real MCP client would:

1. `POST /mcp` with no token → `401` with an RFC 9728 challenge naming
   `/.well-known/oauth-protected-resource/mcp`.
2. Protected-resource metadata → issuer `http://localhost:3000/api/auth`.
   Authorisation-server metadata at
   `/.well-known/oauth-authorization-server/api/auth`.
3. Dynamic client registration → `201`.
4. Authorize with PKCE (S256) and `resource=http://localhost:3000/mcp`:
   - redirected to `/signin`;
   - dev sign-in resumes the request;
   - `/oauth/consent` shows the client name and one line per scope;
   - **Allow** redirects to the client's callback with `code`, `state` and
     `iss`.
5. Code exchange → `access_token`, `refresh_token` and `id_token`. The access
   token is an EdDSA `at+jwt`, valid for 900 s, signed with the same key set
   as the session-cache cookie:
   - `aud: [".../mcp", ".../oauth2/userinfo"]`
   - `scope: "openid profile offline_access comp:read task:write"`
   - `azp` and `client_id` set
6. `initialize` over the **2025-11-25** protocol: served by the SDK's default
   stateless legacy mode. Then `tools/list` and `tools/call`:
   - `whoami` answers as the organiser;
   - `search` finds Corryong Cup 2026;
   - `get_competition` reads a hidden `test` comp as its admin.
7. Through competition-api, the token sees **4** comps (2 hidden, all marked
   as administered). Anonymous requests see **2**.
8. The refresh grant works and returns a new 900 s token.
9. The access token is refused as a `session_data` cookie. A garbage bearer
   token gets a `401`.

**Claude Code CLI, tested by the owner on 24 October:** it worked end to end
against `http://localhost:3000/mcp`.

- **Google sign-in resumes the request.** After "Continue with Google", the
  consent page appeared and the connection completed.
- **"Sign in (dev)" did nothing**, for a reason the spike didn't cause.
  `/api/auth/dev-login` signs up with password `dev`, then signs in with it.
  An account that already exists without a password (made by Google or an
  email code) gets `401 INVALID_EMAIL_OR_PASSWORD`, which `signInAsDev()`
  only logs to the console. Reproduced here; `master` has the same bug.
- Email-code sign-in was not tried.

Still untested: the hosted clients (Claude.ai, ChatGPT). See "Reaching it
from ChatGPT" below.

## What the spike changed

| Where | What |
|---|---|
| `web/workers/auth-api` | `mcp()` from `@better-auth/mcp` 1.7.12; SEC-55 allowlist entries for the OAuth endpoints; root `/.well-known/*` discovery routed to Better Auth; `/api/auth/me` answers for an access token, checking that its consent still exists |
| `web/db/migrations/0040_oauth_provider.sql` | The provider's 7 tables, generated from the plugin's own schema; every reference to `user` and to a client cascades |
| `web/workers/shared/src/access-token.ts` | Verifies an access token (issuer, audience, expiry, `typ`) with the session cookie's key cache |
| `web/workers/mcp-api` | New worker: bearer gate (`requireBearerAuth`), MCP SDK v2 `createMcpHandler`, and 4 read tools that call competition-api over the binding with the caller's token |
| dev-router, `dev-workers.sh`, Vite proxy | `/mcp` and the discovery paths reach the workers in dev |
| `web/frontend` | `/oauth/consent` (the plan's proposed copy, not yet agreed); `/signin` resumes an authorisation request; dev sign-in keeps its destination |
| Better Auth | 1.7.10 → 1.7.12 in auth-api, the website and the app (`@better-auth/mcp` needs `^1.7.12`) |

`bun run typecheck:all` is clean. auth-api's suite passes (229 tests).
dev-router's suite passes, now pinning the new routes.

## Findings that change the plan

1. **Native clients need `clientRegistrationDefaultApplicationType: "infer"`.**
   Without it, registering a loopback callback (`http://127.0.0.1:…`, which
   Claude Code and Cursor use) fails: *"web clients require https redirect
   URIs on non-loopback hosts"*. With `"infer"`, a client that sends only
   loopback URIs is treated as native.
2. **The issuer carries the base path** (`/api/auth`), so RFC 8414 metadata
   lives at `/.well-known/oauth-authorization-server/api/auth`. The bare root
   path returns 404. Some clients only try the root, so phase 1 should serve
   both. Both metadata endpoints are `SERVER_ONLY` in the plugin, which serves
   them from its `onRequest` hook. They are reached only because auth-api now
   routes those root paths to the handler.
3. **The provider advertises more than we want.** Its metadata lists the
   `client_credentials` grant (a token with no user behind it) and the
   introspection endpoint. Introspection is already unserved through SEC-55.
   `client_credentials` should be turned off in configuration, not merely
   left unused.
4. **Disconnect is only half-enforced if `mcp-api` checks the token
   locally.** After the consent row is deleted, `/me` stops answering for the
   token, so competition-api treats it as anonymous at once. But `mcp-api`
   still accepts it, because it checks only the signature. Tools then run
   silently as anonymous instead of returning a `401` that sends the client
   back to sign in. Fix: the gate asks `/me` (one hop, which also brings the
   plan's rate limit), or checks consent itself.
5. **Not yet known:** whether deleting a consent (the provider's
   `/oauth2/delete-consent`, not a raw row delete as here) also revokes the
   refresh token. Phase 1's "Disconnect" test must check it.
6. **The consent page needs a session even to name the client.**
   `GET /oauth2/public-client` returns 401 when signed out, and it returns no
   redirect URIs. The page already has a session by then (the provider sent
   the browser there after sign-in), but the name loads after the first
   render. Phase 1 should hold the page until the name is known, so it never
   briefly says "An assistant". The "returns to …" host comes from the signed
   query's `redirect_uri`, which the provider has already validated.
7. **Sign-in hand-off is simple.** The provider sends a signed request to
   `loginPage`. Once signed in, sending the browser back to `/oauth2/authorize`
   with the same query (minus the signature) resumes it.
   `lib/oauth-resume.ts` does that, and the provider re-checks everything. No
   Better Auth client plugin is needed.
8. **The schema is bigger than the docs say.** It has 7 tables, including
   `oauthResource` and `oauthClientResource`. The library's references to
   `user` have no `ON DELETE`. D1 enforces foreign keys, so account deletion
   would fail on any user who ever connected an assistant. The migration
   cascades them; phase 1 needs a test for it.
9. **The MCP SDK v2 runs in workerd as is.** That covers `createMcpHandler`,
   `requireBearerAuth` and the `cf-worker` validator, with no `nodejs_compat`
   problems. Responses to the 2025 protocol come back as SSE frames.

## Reaching it from ChatGPT

ChatGPT, Claude.ai and other hosted clients run in the cloud. They need a
public HTTPS URL, and every URL in the flow is derived from `BETTER_AUTH_URL`.
Branch previews don't help, because they redeploy only the website against the
production workers. Two attempts in this container were blocked by the
session's permission rules, both reasonably:

- opening a Cloudflare Quick Tunnel from the container;
- treating a `*.trycloudflare.com` `BETTER_AUTH_URL` as dev, which would put
  dev sign-in on a public URL while the tunnel runs.

What works without either:

- **Claude Code on your Mac, today.** Claude Code accepts `http://localhost`
  MCP servers. Run this branch (`bun run dev`), then
  `claude mcp add --transport http glidecomp-dev http://localhost:3000/mcp`,
  then `/mcp` → authenticate. The browser opens the local `/signin`; use
  **Sign in (dev)**, then **Allow**. That tests a real client's registration,
  protocol version and refresh with no further change.

What ChatGPT or Claude.ai need, pick one:

- **A tunnel plus a real sign-in on your Mac.** Run `cloudflared` (the
  dev-tunnel skill) and set `BETTER_AUTH_URL` in auth-api's `.dev.vars` to
  the tunnel URL. Dev sign-in then switches off (correctly), so you need a
  working sign-in on that host: Google with real credentials and the tunnel's
  callback registered, or email codes with a send path. A named tunnel with
  a fixed hostname avoids re-registering every run.
- **Explicitly allow the tunnel-as-dev change** for a short test, accepting
  that anyone who learns the random URL can sign in to your local dev data.
- **Deploy phase 1 to production**, with findings 1–6 fixed, and test against
  `https://glidecomp.com/mcp`. That is a merge, so it waits on the phase 1
  review.
