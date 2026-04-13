# GlideComp MCP Server

GlideComp provides an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server so you can manage competitions from AI agents like Claude Desktop, Claude Code, and Cursor.

## URLs

| Environment | URL |
|---|---|
| **Production** | `https://glidecomp.com/mcp` |
| **Local dev** | `http://localhost:8790/mcp` |

Health check: `GET /mcp/health` returns `{"ok":true}`

## Getting an API key

1. Log in to [glidecomp.com](https://glidecomp.com)
2. Go to Settings and create an API key
3. The key (prefixed `glc_`) is shown **once** at creation — copy and save it securely

## Client configuration

### Claude Desktop

Add to your `claude_desktop_config.json`:

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

### Claude Code

Add to your project or user `.claude/settings.json`:

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

### Cursor

Add to `.cursor/mcp.json`:

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

### Local development

For local dev, point at `http://localhost:8790/mcp` and use an API key created against your local database. You need all three workers running:

```bash
# Terminal 1
cd web/workers/auth-api && bun run dev        # port 8788

# Terminal 2
cd web/workers/competition-api && bun run dev # port 8789

# Terminal 3
cd web/workers/mcp-api && bun run dev         # port 8790
```

## Available tools

Once connected, your agent has access to these tools:

### Competitions
- `list_competitions` — List all competitions you have access to
- `get_competition` — Get full competition details (tasks, pilots, admins)
- `create_competition` — Create a new competition
- `update_competition` — Update competition settings
- `delete_competition` — Delete a competition

### Tasks
- `get_task` — Get task details and xctsk definition
- `create_task` — Create a task in a competition
- `update_task` — Update task settings
- `delete_task` — Delete a task

### Pilots
- `get_pilot_profile` — Get your pilot profile
- `update_pilot_profile` — Update your profile (triggers auto-linking)
- `list_pilots` — List registered pilots in a competition
- `register_pilot` — Register a pilot (admin)
- `bulk_register_pilots` — Bulk upsert pilot roster (admin)
- `update_comp_pilot` — Update a pilot's registration (admin)
- `remove_pilot` — Remove a pilot from a competition (admin)

### Tracks (IGC files)
- `list_tracks` — List uploaded tracks for a task
- `upload_igc` — Upload your own IGC track
- `upload_igc_on_behalf` — Upload a track for another pilot
- `download_igc` — Download a pilot's IGC track
- `update_penalty` — Set or update a track penalty (admin)
- `delete_track` — Delete a track (admin)

### Pilot status
- `list_pilot_statuses` — List pilot statuses for a task
- `set_pilot_status` — Set a pilot's status (e.g. "safely landed")
- `update_pilot_status_note` — Edit a status note
- `clear_pilot_status` — Remove a pilot's status

### Scoring
- `get_task_scores` — Get GAP scores for a task
- `get_competition_scores` — Get overall competition standings

### Audit
- `get_audit_log` — View the competition audit trail

## Verifying it works

Ask your agent to run `list_competitions`. If authenticated, you'll see both public competitions and any you admin.
