# Connecting your own assistant to GlideComp

GlideComp has an [MCP](https://modelcontextprotocol.io) endpoint at
**`https://glidecomp.com/mcp`**. Connect the assistant you already use —
Claude, ChatGPT, Claude Code — and it can find competitions, read tasks and
their routes, and look up waypoints, as you. GlideComp runs no model of its
own: the assistant and its costs are yours.

You sign in once, in a browser, and choose what the assistant may do. Nobody
copies an API key into a config file, and you can disconnect it at any time.

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
| `comp:read` | See competitions and tasks, including hidden ones you organise | The tools below |
| `task:write` | Create tasks and change their routes in competitions you organise | Nothing yet: the task and route tools arrive in the next release |

### Tools

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

Some things are deliberately out of reach for now: deleting anything,
competition settings, the roster, tracks, penalties and scores. Each will need
its own permission, which you'll be asked for.

## Disconnect

**Settings → Connected assistants** lists every assistant you have allowed,
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
  routes an access token may reach, and the permission each needs. A route an
  assistant may reach is added there on purpose.
- `e2e/mcp.spec.ts` — the whole flow: discovery, registration, consent,
  tools, Disconnect.
