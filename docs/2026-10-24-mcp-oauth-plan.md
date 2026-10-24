# MCP for organisers, signed in with OAuth — 2026-10-24

*Plan. Nothing here is built yet.*

An organiser should be able to connect the assistant they already use (Claude,
ChatGPT, Claude Code) to GlideComp, sign in once in a browser, and then ask it
to find a competition, read a task, or set tomorrow's route. GlideComp runs no
model and pays for no inference: the assistant is the organiser's own.

This replaces the server-side MCP experiment that
[#198](https://github.com/pokle/glidecomp/pull/198) removed in June 2026. That
one authenticated with an API key pasted into a client's config file. This
one uses OAuth 2.1 through Better Auth's `@better-auth/mcp` plugin, so nobody
handles a key, and every grant is narrow, visible and revocable. Iteration 12
of [competition-spec.md](competition-spec.md) planned a WebMCP server instead.
WebMCP is still a Chrome origin trial that no browser ships, so this plan does
not wait for it.

## Scope

**In:**

- Search for, list and read competitions and tasks, including routes and the
  competition's waypoints.
- Create a task, edit its name, date and classes, and set or change its route.

**Out, for later phases:** deleting anything; competition settings and GAP
parameters; the roster; tracks, penalties and pilot status; scores and
analysis; MCP Apps (interactive views inside the chat); pilots as a user group.
Each needs its own scope, added on purpose (§5), not a wider existing one.

## 1. The shape

```
assistant (Claude, ChatGPT…)
   │  POST https://glidecomp.com/mcp      Authorization: Bearer <access token>
   ▼
Pages Function functions/mcp.ts ──service binding──▶ mcp-api worker (new)
                                                       │ verifies the token
                                                       │ runs the tool
                                                       ▼
                                    competition-api (existing routes, unchanged rules)
                                                       │ resolveUser → /api/auth/me
                                                       ▼
                                    auth-api: Better Auth + mcp() = the authorisation server
```

Three decisions carry the design.

**auth-api becomes the authorisation server.** `mcp()` is Better Auth's OAuth
2.1 provider configured for MCP. It sits beside the `jwt()` plugin auth-api
already runs for the session-cache cookie, which supplies the signing key and
the JWKS it needs. It serves `/oauth2/authorize`, `/oauth2/token` and the
discovery metadata, and binds every access token to the MCP resource
`https://glidecomp.com/mcp`.

**A new `mcp-api` worker is the protected resource, and it only speaks the
public API.** Every tool is a call to an existing competition-api route over a
service binding, through `@glidecomp/client`'s typed `createApi()`, as the
native app does. Every rule that already holds in those routes still holds,
with nothing restated: `audit()`, `bumpAndRevalidateScores()`, the xctsk
validator, hidden `test` comps 404ing for non-admins, and #481's retry rules.
**mcp-api never reads D1.** A tool that needs something no route offers adds a
route to competition-api under that worker's "part of done" rules.

Why not put the MCP endpoint inside auth-api or competition-api? auth-api's
job is identity, and its SEC-55 endpoint allowlist stays reviewable only while
that job stays small. competition-api would gain a second way into every route
that skips its own middleware. A thin adapter that can only do what an HTTP
client can do is the smaller thing to secure.

**competition-api accepts the access token as a third credential, scoped and
fenced.** mcp-api forwards the organiser's own bearer token. It does not assert
an identity, which is what closed SEC-10. `resolveUser()` already forwards
`Authorization` to auth-api's `/api/auth/me`. `/me` learns to answer for an
access token (§3), and a new competition-api middleware fences what a token
may reach (§4). A token stolen from an assistant's storage can therefore do
exactly what the MCP tools do, against the REST API too, and nothing more.

## 2. Packages, versions and workerd

| Package | Version checked | For |
|---|---|---|
| `@better-auth/mcp` | 1.7.12 | `mcp()` plugin; depends on `@better-auth/oauth-provider` |
| `@better-auth/oauth-provider` | 1.7.12 | pulled in by the above; supplies the schema |
| `better-auth` | ^1.7.12 (repo is on ^1.7.10) | peer of both; bump together, in the same PR |
| `@modelcontextprotocol/server` | 2.4.0 | MCP SDK v2: `createMcpHandler`, `McpServer`, `bearerAuthChallengeResponse` |

- **Transport.** Use `createMcpHandler` with the default `legacy: "stateless"`,
  not the `"reject"` the Better Auth README suggests. `"reject"` refuses every
  client still speaking the 2025 protocol revisions. Phase 0 records which
  revision each target client sends; tighten only when they have all moved.
  Stateless serving needs no Durable Object and no session store. That is
  also why this plan does not use Cloudflare's `agents` package: it is built
  around Durable Objects, which this worker has no use for.
- **Schema validation.** Use the SDK's `validators/cf-worker` export. The
  default Ajv validator compiles schemas with `new Function`, which workerd
  refuses.
- **Client registration.** The MCP-recommended route is the Client ID Metadata
  Document (`@better-auth/cimd`). Its fetch transport "MUST resolve the hostname
  exactly once, reject RFC 6890 special-use addresses, pin the approved address
  … and refuse redirects", which a Worker's `fetch` cannot promise. So phase 1
  uses **Dynamic Client Registration** (`allowDynamicClientRegistration` and
  `allowUnauthenticatedClientRegistration`, both off by default), behind the
  budgets in §6. CIMD comes back when there is a transport that can keep that
  promise.

## 3. auth-api: the authorisation server

**Config** (`src/auth.ts`):

```ts
mcp({
  resource: `${env.BETTER_AUTH_URL}/mcp`,      // http://localhost:3000/mcp in dev (loopback is allowed)
  loginPage: "/signin",
  consentPage: "/oauth/consent",
  scopes: ["openid", "profile", "offline_access", "comp:read", "task:write"],
  clientRegistrationDefaultScopes: ["comp:read"],
  clientRegistrationAllowedScopes: ["openid", "profile", "offline_access", "comp:read", "task:write"],
  accessTokenExpiresIn: 15 * 60,               // default is 3600; short, because a JWT can't be recalled (below)
  allowDynamicClientRegistration: true,
  allowUnauthenticatedClientRegistration: true,
}),
```

Option names are from the 1.7.12 type definitions. Confirm PKCE is
**required** (S256) for public clients and leave the refresh-token reuse
window at the MCP default of 30 s.

**Schema.** Generate the provider's tables (`oauthClient`, `oauthAccessToken`,
`oauthRefreshToken`, `oauthConsent`, `oauthClientAssertion`) with Better Auth's
generator, then hand-review them into `web/db/migrations/0039_oauth_provider.sql`.
The generator's output is a draft, never committed blind. Check whether DPoP
replay detection writes a table of its own.

**SEC-55 allowlist** (`src/endpoints.ts`). Add only what the flow uses, each
with a comment: `GET|POST /oauth2/authorize`, `POST /oauth2/token`,
`POST /oauth2/register`, `POST /oauth2/revoke`, `POST /oauth2/consent`,
`POST /oauth2/continue` (resumes the request after sign-in),
`GET /oauth2/get-consents`, `POST /oauth2/delete-consent`, and `GET /jwks`
(already served). Leave `/oauth2/create-client`, `/update-client`,
`/introspect` and the rest of the provider's ~20 endpoints answering 404.

**Discovery.** MCP clients look at the origin root, so add Pages Functions
beside `functions/.well-known/apple-app-site-association.ts`:

- `/.well-known/oauth-protected-resource/mcp` (RFC 9728), naming the resource
  and the authorisation server;
- `/.well-known/oauth-authorization-server` (RFC 8414), forwarded to the
  metadata the plugin produces.

Both proxy to auth-api over the existing `AUTH_API` binding, so the plugin
stays the source of truth for their contents.

**`/api/auth/me` learns the access token.** When `Authorization: Bearer`
carries a JWT, `/me` verifies it against its own JWKS: the signature, the
`typ` header the provider stamps, `iss`, `aud` equal to the MCP resource, and
`exp`. It then checks that the consent behind it still exists (one D1 read).
It answers with the user plus a grant:

```json
{ "user": { … }, "grant": { "kind": "oauth", "client_id": "…", "client_name": "Claude", "scopes": ["comp:read", "task:write"] } }
```

The consent check is what makes "Disconnect" in Settings take effect within
one request, not when the 15-minute token runs out. An API key or a session
answers as it does today, with no `grant`.

**Token confusion.** Session-cache JWTs and access tokens are signed by the
same key set. `verifySessionCookie()` in `web/workers/shared/src/session-cookie.ts`
already requires the session `typ` and `aud`. The tests must prove it in both
directions: an access token presented as a `session_data` cookie is refused,
and a session-cache JWT presented as a bearer token is refused by `/me`.

**Account management stays browser-only.** The SEC-57 guard that answers
`403 BROWSER_SESSION_REQUIRED` to `x-api-key` gains the bearer token too, so a
token can never create API keys, rename the account or delete it.

## 4. competition-api: the fence

`resolveUser()` carries the `grant` into `c.var`. One new middleware applies
when `grant.kind === "oauth"`:

- **A route allowlist.** The token reaches only the routes the tools call
  (§5). Any other route answers `403 {"code":"NOT_AVAILABLE_TO_ASSISTANTS"}`.
  It is an allowlist for the same reason SEC-55's is: a route added next year
  must not become reachable by every connected assistant because nobody
  thought about it.
- **Scopes.** `GET` routes need `comp:read`; task `POST`/`PATCH` need
  `task:write`. Being an admin of the competition is still checked by
  `requireCompAdmin`, as now. A scope never grants more than the account has.

**The audit line names the channel** (recommended; see open question 1).
`audit()` is the one place every mutation already passes through. When the
request carries an OAuth grant, the description gains a suffix: *"Changed the
route of Task 3 (via Claude)"*. The actor stays the organiser, who approved
the grant. The suffix tells a pilot reading the public log how the change was
made. One change in `audit.ts` covers every route; no call site changes.

## 5. Tools

Every tool returns two things: a short text answer for the model, and
`structuredContent` with the data. Every item carries its canonical URL, built
with `@glidecomp/client/slug`, so the assistant links to the page rather than
retyping it. Pilot-supplied strings (pilot and team names) are returned as
data fields, never as text addressed to the model (§7). Each tool sets MCP
`annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`), so clients
know which calls to confirm.

### Phase 2 — read (`comp:read`)

| Tool | Calls | Returns |
|---|---|---|
| `search` | `GET /api/comp/search?q=` | Comps, tasks and pilots that match, as the site's search groups them; a turnpoint-code query finds the tasks through those turnpoints |
| `list_competitions` | `GET /api/comp` | Recent public comps plus the caller's own; `mine: true` filters to the ones they administer |
| `get_competition` | `GET /api/comp/:comp_id` | Name, category, format, classes, dates, timezone, admins, tasks (date, classes, `has_xctsk`) |
| `get_task` | `GET /api/comp/:comp_id/task/:task_id` | Metadata, turnpoints (name, type, radius, coordinates, altitude), `startConfigSummary()`, the route as a quick-task line (`quickTaskText()`), and a `route_rev` hash of the stored xctsk |
| `list_waypoints` | `GET /api/comp/:comp_id/waypoints` | The comp's waypoints, filterable by a `query` so a 145-row set doesn't flood the context |

### Phase 3 — write (`task:write`)

| Tool | Calls | Does |
|---|---|---|
| `create_task` | `POST /api/comp/:comp_id/task` | Name, date (comp-local), classes. No route: the route is its own step |
| `update_task` | `PATCH …/task/:task_id` | Name, date, classes. Refuses a route change, which only `set_task_route` makes |
| `preview_route` | nothing (pure) | **Writes nothing.** Takes a quick-task line ("same as task 2 but goal CORRY, start 13:30" becomes `ELLIOT 400m to, PINEMT 400m sss 13:30, TOWONG 400m, CORRY 400m goal`) or a list of turnpoints. Runs `quickTaskApply()` against the comp's waypoints, then `buildRoute()` / `assembleRouteTask()`. Returns each token's match **with its runners-up**, unmatched tokens, start problems, the optimised distance, and the tidied line (`spelledText`) |
| `set_task_route` | `PATCH …/task/:task_id` with `xctskForPatch()` | Takes the tidied line, which must name every waypoint **exactly**, plus the `route_rev` the agent last read. Refuses a fuzzy token, and refuses if the stored route has changed since that read (someone edited it in the browser). Returns the new route and a link to the task page |

The route tools reuse the shared code the website's and the app's route
editors run, in `@glidecomp/client` (`quick-task.ts`, `route-editor.ts`), so
all three read a line the same way.

**The rule for waypoint matching mirrors the one for pilot names: a fuzzy match
may propose, never dispose** (`CLAUDE.md`, "Names may propose, never
dispose"). `quickTaskApply` is forgiving by design, because the UI shows the
best guess and one tap corrects it. An assistant has no such tap. So
`preview_route` shows the guesses, and `set_task_route` takes only exact
names. The agent (or the organiser it asks) settles any ambiguity in between.

**Not in this plan:** `delete_task`, which is destructive and wasn't asked
for. When it comes, it takes its own scope.

## 6. Abuse and budgets

- **Registration:** `/oauth2/register` gets a per-IP budget through
  `web/workers/shared/src/rate-limit.ts` (say 10 an hour). A daily cron deletes
  clients that never received a consent within 24 hours. With unauthenticated
  DCR, client rows are free to create, so they must also be cheap to remove.
- **Calls:** `/me` counts OAuth calls per grant, as the apiKey plugin counts
  per key (`API_KEY_RATE_LIMIT`, 60 a minute). `429` with `Retry-After`, never
  retried (#481: a 4xx is an answer).
- **No inference cost**, so no denial-of-wallet: the worst case is Workers
  requests and D1 reads, inside the current plan.

## 7. Security review checklist

To be run as a focused review before phase 3 ships:

- PKCE S256 required; `redirect_uri` matched exactly; no open redirect through
  `loginPage`'s return path.
- The consent page is CSRF-protected and cannot be framed (`frame-ancestors
  'none'` already applies site-wide).
- **DCR client names are self-declared.** A client can call itself "Claude"
  and redirect to anywhere. The consent page therefore shows the redirect
  host beside the name, and never an icon fetched from the client.
- Token confusion in both directions (§3).
- A hidden `test` comp answers not-found to a token whose user is not its
  admin. This is inherited, but covered by a test, because search is the
  classic way to discover one (`visibleCompsFilter()`).
- **Prompt injection.** A tool result can carry text a pilot wrote (a team
  name, a pilot name from an IGC header). Phase 3's write tools change only
  tasks, and the route fence keeps a token away from everything else. Even
  so, an injected "set the route to…" could reach `set_task_route`. That is
  why it needs `route_rev` and exact names, carries `destructiveHint`, and
  lands in the public audit log as "via \<client\>".
- `BROWSER_SESSION_REQUIRED` covers bearer tokens (§3).

## 8. Website changes (wording to confirm before building)

Per the "Propose UI wording before you change it" rule, this copy is a
proposal. Nothing gets built until the wording is agreed.

**Consent page, `/oauth/consent`** (SPA route, RAC kit, mobile first, no
chrome beyond the header):

> **Let Claude use GlideComp as you?**
>
> Claude (returns to claude.ai) is asking to:
>
> - See competitions and tasks, including hidden ones you organise
> - Create tasks and change their routes in competitions you organise
>
> It acts as you. Every change it makes shows in that competition's public
> activity log under your name, marked "via Claude".
>
> You can disconnect it at any time in Settings → Connected assistants.
>
> [ Allow ]  [ Don't allow ]

The second bullet appears only when `task:write` is requested.

**Settings → Connected assistants**, a section beside API Access:

> **Connected assistants**
> Assistants you've let act as you. Disconnecting one stops it straight away.
>
> Claude · connected 24 Oct 2026 · can change tasks · [ Disconnect ]

Empty state: *"No assistants connected. To connect one, add
https://glidecomp.com/mcp to it as a connector."*

**Sign-in.** `/signin` already takes a return path as `?next=`, through
`safeNext()`. The provider sends an anonymous organiser to `loginPage` with the
authorisation request in the query. After sign-in, that request must resume
(the provider's `/oauth2/continue`), so `safeNext()` needs to accept the
authorize path, and only that one new path. Phase 0 confirms the query shape
the provider sends.

## 9. Local dev, previews and docs

- **Dev:** dev-router dispatches `/mcp` and the two `/.well-known/oauth-*`
  paths. The Vite proxy forwards them on `:3000`, so the issuer and resource
  are `http://localhost:3000` (loopback HTTP is allowed by the plugin).
  `claude mcp add --transport http glidecomp http://localhost:3000/mcp` is
  the smoke test.
- **Branch previews** do not get MCP in this plan. The issuer is the host, and
  a preview's host differs from production's.
- **Docs:** `docs/mcp.md` (connect Claude, ChatGPT and Claude Code; what each
  scope allows; how to disconnect). Add rows to `docs/api.md` for `/mcp` and the
  `.well-known` endpoints, which `api-doc-coverage.test.ts` will require.
  Update `CLAUDE.md`: the architecture list gains `mcp-api`, plus two rules.
  *mcp-api calls competition-api, never D1.* *A route an assistant may reach is
  added to the fence on purpose.*

## 10. Phases

Each phase ships on its own, with green CI, as its own PR.

**Phase 0 — spike (no merge).** Throwaway branch:

- `mcp()` in auth-api under `wrangler dev`, plus a stub `whoami` tool.
- Connect Claude Code, Claude.ai (custom connector) and ChatGPT. For each,
  record its registration method (DCR or CIMD), the protocol revision it
  sends, whether it sends `resource` (RFC 8707), and whether it refreshes.
- Confirm both packages bundle for workerd (no `new Function`, no Node-only
  imports without `nodejs_compat`).

The findings set the transport and registration choices above. If a target
client supports only CIMD, phase 1 grows a CIMD transport question first.

**Phase 1 — authorisation server.**

- Migration 0039, `mcp()` config, the SEC-55 additions, the discovery
  Functions, `/me`'s access-token branch with the consent check, the SEC-57
  extension, `/oauth/consent`, Settings → Connected assistants, and the
  registration budget and cleanup cron.
- Tests (auth-api): authorize → consent → token with PKCE → `/me` answers with
  the grant; Disconnect → `/me` answers `user: null` on the next call; token
  confusion both ways; unknown scope refused; registration budget.

**Phase 2 — mcp-api with the read tools.**

- The worker, the `functions/mcp.ts` proxy, the service bindings, the deploy
  step, the dev-router route.
- The competition-api fence for the GET routes.
- Tests: each tool against a seeded comp (vitest-pool-workers); the fence
  refusing an unlisted route; a hidden comp invisible to a non-admin's token.
- **e2e** `e2e/mcp.spec.ts`, added to its shard in `e2e/fixtures/shards.ts`:
  - a scripted client (`@modelcontextprotocol/client`) runs the whole OAuth
    flow headlessly against the dev stack, through sign-in and consent in
    Playwright;
  - it lists the tools, searches, and reads a task.

**Phase 3 — task and route writes.** The four write tools, the fence and the
scope check for task POST/PATCH, and the audit "via" suffix.

- Tests: create a task, preview a fuzzy route, refuse an ambiguous
  `set_task_route`, set an exact one, and refuse a stale `route_rev`.
- Check that the audit log shows the change with the suffix, and that the
  task's scores were marked stale. That comes from the existing PATCH, but
  the test proves it.
- Then the security review (§7).

**Phase 4 and beyond (not planned in detail):**

- An MCP App view for `preview_route` (the route drawn on a map before it is
  set).
- Roster tools (`roster:write`), and tracks and penalties (`track:write`).
- CIMD.
- Pilot-facing read tools.

## 11. How we'll know it works

At the first comp after phase 3, the organiser runs the day's task changes
through their assistant, and we record:

- requests made and how many succeeded;
- time against the route editor for the same change;
- `preview_route` ambiguities, and how they were settled;
- any change the organiser had to undo (the target is none);
- grants revoked.

These numbers decide whether phase 4 is worth building.

## Open questions

1. **The "via \<client\>" suffix in the public audit log.** Recommended: yes.
   The log is the transparency record, and how a change was made is part of
   it. It also discloses which assistant an organiser uses. Your call.
2. **Scope granularity.** Is `task:write` (every comp you administer) enough?
   Or should consent also pick competitions? Per-comp grants are safer but
   need a custom consent step that the plugin does not provide.
3. **Access-token lifetime.** 15 minutes plus a consent check on every call is
   belt and braces. With the consent check, an hour would be fine too. Pick
   one when phase 1 measures the extra D1 read.
4. **The API-key path.** Should API keys also reach `/mcp`, for scripts and
   clients without OAuth? Recommended: no, not in this plan. That is the
   design #198 removed, and two credential paths into one endpoint is a
   second thing to secure.
