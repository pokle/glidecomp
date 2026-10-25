# Connecting your own assistant to GlideComp

GlideComp has an [MCP](https://modelcontextprotocol.io) endpoint at
**`https://glidecomp.com/mcp`**. Connect the assistant you already use —
Claude, ChatGPT, Claude Code — and it can find competitions, read tasks and
their routes, look up waypoints, and create tasks and set their routes, as
you. GlideComp runs no model of its own: the assistant and its costs are
yours.

You sign in once, in a browser, and choose what the assistant may do. Nobody
copies an API key into a config file, and you can disconnect it at any time.

The same guide, for organisers, is on the site at
[glidecomp.com/assistant](https://glidecomp.com/assistant) (linked from the
footer's Resources column and from Settings). Assistants that look can find
the endpoint by themselves: `/llms.txt` names it, and the MCP Server Card at
`/mcp/server-card` is listed in both `/.well-known/ai-catalog.json` (the AI
Catalog spec) and `/.well-known/ard.json` (Agentic Resource Discovery), two
related specs whose clients look in different places. Each file is checked
against its spec in `web/workers/mcp-api/test/discovery.test.ts`.

The endpoint speaks MCP **2026-07-28** (stateless: no `initialize`, the
revision rides in each request's `_meta`) and, beside it, the 2025 revisions
down to 2024-11-05, which most hosted assistants still use. Both come from
`@modelcontextprotocol/server`'s `createMcpHandler`. The SDK's
`SUPPORTED_PROTOCOL_VERSIONS` lists only the 2025-era ones, so the server
card's list is `PROTOCOL_VERSIONS` in `web/workers/mcp-api/src/server-card.ts`,
held to the endpoint's own `server/discover` by its test.

How it is built, and why: [the plan](2026-10-24-mcp-oauth-plan.md).

## Connect

Each assistant finds GlideComp's sign-in page on its own. Give it the URL, and
it opens a browser at GlideComp, where you sign in (if you aren't already) and
see a page that names the assistant and lists what it is asking for. Choose
**Allow**, and it is connected.

- **Claude Code:**

  ```bash
  claude mcp add --transport http glidecomp https://glidecomp.com/mcp
  ```

  Then run `/mcp` in Claude Code and choose GlideComp to sign in.
- **Claude** (claude.ai and the apps): add a custom connector with the URL
  `https://glidecomp.com/mcp`.
- **ChatGPT:** add a connector with the same URL, where your plan offers
  custom connectors.

Branch previews have no MCP endpoint: the sign-in is tied to the site's own
address. Locally, `bun run dev` serves one at `http://localhost:3000/mcp`
(see [Local development](#local-development)).

## What it can do

The consent page asks for one or both of these. An assistant only ever acts
as you, so it sees what you would see on the website — including hidden test
competitions you organise — and nothing more.

| Permission | On the consent page | Allows |
|---|---|---|
| `comp:read` | See competitions and tasks, including hidden ones you organise | The reading tools below |
| `task:write` | Create tasks and change their routes in competitions you organise | The task and route tools below — a task's name, date, classes and route, and nothing else about it |

### Reading

| Tool | What it answers |
|---|---|
| `whoami` | Which account the connection acts as, and what it was allowed |
| `search` | Competitions, tasks and pilots matching some words. Turnpoint codes find the tasks that fly through them |
| `list_competitions` | Recent public competitions plus your own; `mine` lists only the ones you organise |
| `get_competition` | One competition: category, format, classes, timezone, organisers, and every task |
| `get_task` | One task and its route: turnpoints, the route editor's one-line quick-task text, the start, the optimised distance |
| `list_waypoints` | The competition's waypoints, filtered by code or name |

Every answer carries the GlideComp page's URL, so the assistant can link you
to it rather than retell it.

### Tasks and routes

Only with `task:write`, and only in competitions you organise.

| Tool | What it does |
|---|---|
| `create_task` | Adds a task: name, date, and classes (every class, unless you say). No route yet |
| `update_task` | Changes a task's name, date or classes. Never the route |
| `preview_route` | Reads a route line and says what it would make. **Saves nothing** |
| `set_task_route` | Saves a route line — only one in which every name is exact, and only if the route hasn't changed since the assistant read it |

A route is written as one line, the same line the route editor's **Quick
entry** reads: `ELLIOT 400m to, ELLIOT 5k sss exit 13:30, TOWONG 400m, CORRY
400m goal`. Waypoint codes in flying order, a radius after a code, the role
words `to`, `sss`, `ess` and `goal`, and the start's direction and gates
(in the competition's time zone) after `sss`. The assistant and the editor read
a line with the same code, so they can't read it two ways.

**A guess is never saved.** Quick entry forgives typing — `ell` finds ELLIOT,
and the editor shows its guess for you to correct with one tap. An assistant
has no tap. So `preview_route` shows how each name was read, marks the ones
that aren't exactly a waypoint code, and lists the other waypoints each could
mean; `set_task_route` refuses a line until every name is exact. If two
waypoints could be the one meant, the assistant has to ask you.

**A route you changed isn't overwritten.** The assistant reads the route
before it changes it, and the save carries that reading (`route_rev`). If the
route changed in between — you edited it on the website, say — nothing is
saved, and the assistant is told what the route is now.

**The audit log says how a change was made.** Changes are recorded under your
name, like any other, with the assistant's name on the end: `Created task
"Task 3" (2026-01-05, classes: open) (via Claude)`. For a public competition,
anyone can read that log.

The name is the one the assistant gave itself when it connected, and it's
shown on the consent page beside the address it sends you back to. An
assistant can call itself anything, so check that address before you allow
it.

### Out of reach

Deleting anything, competition settings, the roster, tracks, penalties,
stopping a task, closing it to submissions, and scores. Each will need its own
permission, which you'll be asked for.

## Disconnect

**Settings → Connected AI Assistants** lists every assistant you have allowed,
and what it can do. **Disconnect** stops it on its very next request; to use
it again, you sign in and allow it again.

A connection you leave alone keeps working: assistants renew their access in
the background. If you disconnect, or your account is deleted, that renewal
stops too.

## Limits

Each connection may make 60 requests a minute to GlideComp. A tool call can
take more than one, so a busy assistant may be told to slow down; it gets a
`429` and an answer saying when to try again.

## Local development

`bun run dev` serves the whole thing on `:3000`: `/mcp`, the sign-in, and the
`/.well-known/oauth-*` discovery documents. Point Claude Code at it to try a
change:

```bash
claude mcp add --transport http glidecomp-dev http://localhost:3000/mcp
```

Sign in with **Sign in (dev)** on the consent page's sign-in step.

Where the code lives:

- `web/workers/mcp-api/` — the endpoint and its tools. It calls
  competition-api over a service binding with the caller's own token, and never
  reads D1, so every visibility rule competition-api keeps holds unrestated.
- `web/workers/auth-api/` — the OAuth provider (`mcp()` in `src/auth.ts`),
  and `/api/auth/me`, which answers for an access token only while the
  organiser's consent stands.
- `web/workers/competition-api/src/middleware/mcp-fence.ts` — the short list of
  routes an access token may reach, the permission each needs, and for a write
  the fields it may send. A route an assistant may reach is added there on
  purpose. `audit.ts` adds the "(via …)" ending.
- `web/workers/mcp-api/src/route-plan.ts` — a route line read the way the route
  editor reads it, plus the exact-name rule.
- `e2e/mcp.spec.ts` — the whole flow: discovery, registration, consent,
  reading, a task and its route, Disconnect.
