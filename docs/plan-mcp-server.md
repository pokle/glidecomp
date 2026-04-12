# Plan: GlideComp MCP HTTP Server

## Goal

Expose all GlideComp competition-management actions as MCP (Model Context Protocol) tools so that AI agents (Claude Desktop, Cursor, Claude Code, etc.) can drive competition workflows programmatically — the same operations a human performs through the website.

---

## 1. Cloudflare MCP Support — Confirmed

Cloudflare has **first-class MCP support** via the Agents SDK. Two approaches are available:

| Approach | When to use |
|---|---|
| `createMcpHandler()` | Stateless tools — simple fetch handler, no Durable Objects |
| `McpAgent` (Durable Object) | Per-session state, elicitation, more complex flows |

**Recommendation: use `createMcpHandler()`**. GlideComp's API is already stateless request/response — no per-session state is needed. This is the simplest path: a single Worker that translates MCP tool calls into the existing competition-api endpoints (via service binding) and returns results.

**Transport**: Streamable HTTP (the current MCP standard, single `/mcp` endpoint). SSE can be added for legacy clients later.

**Template**: `npm create cloudflare@latest -- glidecomp-mcp --template=cloudflare/ai/demos/remote-mcp-authless`

---

## 2. Architecture

```
MCP Client (Claude Desktop, Cursor, etc.)
    │
    │  Streamable HTTP POST → https://glidecomp.com/mcp
    │  (Bearer token in Authorization header)
    │
    ▼
┌─────────────────────────────┐
│  mcp-api Worker              │  ← NEW Cloudflare Worker
│  (createMcpHandler + Hono)   │
│                              │
│  1. Validate API key         │
│  2. Map MCP tool → internal  │
│     competition-api call     │
│  3. Return structured result │
└──────────┬──────────────────┘
           │ Service Binding
           ▼
┌─────────────────────────────┐
│  competition-api Worker      │  ← EXISTING (no changes needed)
│  (Hono routes, D1, R2)      │
└──────────┬──────────────────┘
           │ Service Binding
           ▼
┌─────────────────────────────┐
│  auth-api Worker             │  ← EXISTING (API key lookup added)
└─────────────────────────────┘
```

The MCP worker is a **thin translation layer** — it doesn't duplicate business logic. It:
1. Authenticates the caller via API key
2. Forwards requests to `competition-api` via service binding (internal, zero-latency)
3. Maps JSON responses back to MCP tool results

---

## 3. Authentication — API Key Scheme

### Why API keys (not OAuth)

MCP clients like Claude Desktop and Cursor don't run a browser — OAuth's redirect flow is awkward. A simple bearer-token API key is the standard pattern for machine-to-machine MCP access:

- User generates a key in the GlideComp web UI (Settings page)
- Key is sent as `Authorization: Bearer glc_...` on every MCP request
- Server looks up the key → resolves to a user → applies the same permission model as the website

### Key Design

| Aspect | Detail |
|---|---|
| **Format** | `glc_` prefix + 32 random hex chars (e.g. `glc_a1b2c3d4...`) |
| **Storage** | SHA-256 hash stored in D1 `api_key` table; raw key shown only once at creation |
| **Lookup** | Hash incoming key → SELECT from `api_key` → get `user_id` |
| **Permissions** | Same as the user's web session — comp admin checks, ownership, etc. all apply |
| **Revocation** | User can delete keys from Settings; row deleted from D1 |
| **Rate limit** | 60 requests/minute per key (enforced via Cloudflare Rate Limiting rules) |
| **Scope** | Full account access (v1); optional per-comp scoping in a future iteration |

### New D1 Table

```sql
CREATE TABLE api_key (
  api_key_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  key_hash    TEXT NOT NULL UNIQUE,       -- SHA-256 of the raw key
  label       TEXT NOT NULL DEFAULT '',   -- user-provided description
  created_at  TEXT NOT NULL,
  last_used   TEXT,                        -- updated on each MCP request
  UNIQUE(key_hash)
);
```

### New auth-api Endpoints

```
POST /api/auth/api-keys          → Create key (returns raw key once)
GET  /api/auth/api-keys          → List keys (hash, label, created, last_used)
DELETE /api/auth/api-keys/:id    → Revoke key
POST /api/auth/api-keys/verify   → Internal: hash key → return AuthUser (called by MCP worker via service binding)
```

---

## 4. MCP Tools — Complete Catalog

Every tool maps 1:1 to an existing API endpoint. The MCP worker translates tool arguments into the appropriate HTTP call.

### 4.1 Competition Management

| MCP Tool | Method | API Endpoint | Auth |
|---|---|---|---|
| `list_competitions` | GET | `/api/comp` | optional |
| `get_competition` | GET | `/api/comp/:comp_id` | optional |
| `create_competition` | POST | `/api/comp` | required |
| `update_competition` | PATCH | `/api/comp/:comp_id` | comp admin |
| `delete_competition` | DELETE | `/api/comp/:comp_id` | comp admin |

### 4.2 Task Management

| MCP Tool | Method | API Endpoint | Auth |
|---|---|---|---|
| `get_task` | GET | `/api/comp/:comp_id/task/:task_id` | optional |
| `create_task` | POST | `/api/comp/:comp_id/task` | comp admin |
| `update_task` | PATCH | `/api/comp/:comp_id/task/:task_id` | comp admin |
| `delete_task` | DELETE | `/api/comp/:comp_id/task/:task_id` | comp admin |

### 4.3 Pilot Management

| MCP Tool | Method | API Endpoint | Auth |
|---|---|---|---|
| `get_pilot_profile` | GET | `/api/comp/pilot` | required |
| `update_pilot_profile` | PATCH | `/api/comp/pilot` | required |
| `list_pilots` | GET | `/api/comp/:comp_id/pilot` | optional |
| `register_pilot` | POST | `/api/comp/:comp_id/pilot` | comp admin |
| `bulk_register_pilots` | POST | `/api/comp/:comp_id/pilot/bulk` | comp admin |
| `update_comp_pilot` | PATCH | `/api/comp/:comp_id/pilot/:comp_pilot_id` | comp admin |
| `remove_pilot` | DELETE | `/api/comp/:comp_id/pilot/:comp_pilot_id` | comp admin |

### 4.4 Track (IGC) Management

| MCP Tool | Method | API Endpoint | Auth |
|---|---|---|---|
| `list_tracks` | GET | `/api/comp/:comp_id/task/:task_id/igc` | optional |
| `upload_igc` | POST | `/api/comp/:comp_id/task/:task_id/igc` | required |
| `upload_igc_on_behalf` | POST | `/api/comp/:comp_id/task/:task_id/igc/:comp_pilot_id` | admin or open |
| `download_igc` | GET | `/api/comp/:comp_id/task/:task_id/igc/:comp_pilot_id/download` | optional |
| `update_penalty` | PATCH | `/api/comp/:comp_id/task/:task_id/igc/:comp_pilot_id` | comp admin |
| `delete_track` | DELETE | `/api/comp/:comp_id/task/:task_id/igc/:comp_pilot_id` | comp admin |

### 4.5 Pilot Status

| MCP Tool | Method | API Endpoint | Auth |
|---|---|---|---|
| `list_pilot_statuses` | GET | `/api/comp/:comp_id/task/:task_id/pilot-status` | optional |
| `set_pilot_status` | PUT | `/api/comp/:comp_id/task/:task_id/pilot-status/:comp_pilot_id` | admin/self/buddy |
| `update_pilot_status_note` | PATCH | `/api/comp/:comp_id/task/:task_id/pilot-status/:comp_pilot_id` | admin/self/buddy |
| `clear_pilot_status` | DELETE | `/api/comp/:comp_id/task/:task_id/pilot-status/:comp_pilot_id` | admin/self/buddy |

### 4.6 Scoring

| MCP Tool | Method | API Endpoint | Auth |
|---|---|---|---|
| `get_task_scores` | GET | `/api/comp/:comp_id/task/:task_id/score` | optional |
| `get_competition_scores` | GET | `/api/comp/:comp_id/scores` | optional |

### 4.7 Audit Log

| MCP Tool | Method | API Endpoint | Auth |
|---|---|---|---|
| `get_audit_log` | GET | `/api/comp/:comp_id/audit` | optional |

---

## 5. File Structure

```
web/workers/mcp-api/
├── wrangler.toml             # Worker config with service bindings
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # createMcpHandler entry point
│   ├── auth.ts               # API key verification via auth-api service binding
│   ├── tools/
│   │   ├── competitions.ts   # list/get/create/update/delete competition tools
│   │   ├── tasks.ts          # task CRUD tools
│   │   ├── pilots.ts         # pilot management tools
│   │   ├── tracks.ts         # IGC upload/download/penalty tools
│   │   ├── pilot-status.ts   # status set/clear tools
│   │   ├── scoring.ts        # score retrieval tools
│   │   └── audit.ts          # audit log tool
│   └── util.ts               # shared helpers (forward request, error mapping)
```

### wrangler.toml

```toml
name = "mcp-api"
main = "src/index.ts"
compatibility_date = "2025-03-10"
compatibility_flags = ["nodejs_compat"]

[[services]]
binding = "COMPETITION_API"
service = "competition-api"

[[services]]
binding = "AUTH_API"
service = "auth-api"

[[routes]]
pattern = "glidecomp.com/mcp"
zone_name = "glidecomp.com"

[[routes]]
pattern = "glidecomp.com/mcp/*"
zone_name = "glidecomp.com"
```

---

## 6. Example Tool Registration

```typescript
// src/tools/competitions.ts
import { z } from "zod";

export function registerCompetitionTools(server: McpServer) {
  server.tool(
    "list_competitions",
    "List all competitions you have access to",
    {},
    async () => {
      const res = await env.COMPETITION_API.fetch(
        new Request("https://comp/api/comp", {
          headers: { cookie: authCookie },
        })
      );
      const data = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "create_competition",
    "Create a new competition",
    {
      name: z.string().describe("Competition name"),
      category: z.enum(["hg", "pg"]).describe("hg = hang gliding, pg = paragliding"),
      pilot_classes: z.array(z.string()).optional().describe("Pilot classes (default: ['open'])"),
      test: z.boolean().optional().describe("Test competition (hidden from public)"),
      close_date: z.string().optional().describe("ISO date when submissions close"),
    },
    async (args) => {
      const res = await env.COMPETITION_API.fetch(
        new Request("https://comp/api/comp", {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie: authCookie },
          body: JSON.stringify(args),
        })
      );
      const data = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );
}
```

---

## 7. Implementation Phases

### Phase 1: Foundation (this PR)
- [ ] Create `web/workers/mcp-api/` with `createMcpHandler()` skeleton
- [ ] Add `api_key` table migration to auth-api
- [ ] Implement key create/list/delete/verify endpoints in auth-api
- [ ] Implement API key auth middleware in mcp-api
- [ ] Register read-only tools: `list_competitions`, `get_competition`, `get_task`, `list_tracks`, `get_task_scores`, `get_competition_scores`, `get_audit_log`
- [ ] Add wrangler route config
- [ ] Test with MCP Inspector

### Phase 2: Write Operations
- [ ] Register mutation tools: create/update/delete competition, task, pilot
- [ ] IGC upload tools (handle binary via base64 encoding in MCP)
- [ ] Penalty management tools
- [ ] Pilot status tools

### Phase 3: UI + Polish
- [ ] Add "API Keys" section to Settings page in frontend
- [ ] Add rate limiting via Cloudflare rules
- [ ] Add MCP server documentation page
- [ ] Register on MCP server directories

---

## 8. Key Design Decisions

### Binary file handling (IGC upload)
MCP tools pass JSON. For IGC upload, the agent sends the file content as a **base64-encoded string**. The MCP worker decodes it, gzip-compresses it, and forwards to the competition-api as the existing endpoint expects.

### ID encoding
The existing API uses sqid-encoded IDs (e.g. `"abc123"` instead of raw integer `42`). MCP tools accept and return the same encoded string IDs — no translation needed.

### Error handling
API errors (400, 403, 404, etc.) are mapped to MCP `isError: true` responses with the error message as text content. This lets the agent understand and recover from errors.

### Tool descriptions
Each tool gets a detailed `description` string explaining what it does, required permissions, and key constraints (e.g. "Requires comp admin. Maximum 50 tasks per competition."). This gives the agent enough context to use tools correctly without documentation lookup.

---

## 9. MCP Client Configuration

Users will add GlideComp to their MCP client config like:

```json
{
  "mcpServers": {
    "glidecomp": {
      "url": "https://glidecomp.com/mcp",
      "headers": {
        "Authorization": "Bearer glc_your_api_key_here"
      }
    }
  }
}
```

No local server process needed — it's a remote MCP server accessed over HTTPS.
