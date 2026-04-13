import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env, AuthUser } from "../env";
import { compApi, jsonResult, errorResult } from "../util";

export function registerAuditTools(
  server: McpServer,
  env: Env,
  user: AuthUser | null
) {
  server.registerTool(
    "get_audit_log",
    {
      description:
        "Get the audit log for a competition. Shows all admin actions (create, update, delete) with actor, timestamp, and description. Supports cursor-based pagination.",
      inputSchema: {
        comp_id: z.string().describe("Competition ID"),
        limit: z
          .number()
          .optional()
          .describe("Max entries to return (1-200, default 50)"),
        before: z
          .number()
          .optional()
          .describe(
            "Return entries before this audit_id (for pagination — use next_before from previous response)"
          ),
        subject_type: z
          .enum(["comp", "task", "pilot", "track"])
          .optional()
          .describe("Filter by subject type"),
      },
    },
    async ({ comp_id, ...query }) => {
      try {
        const params = new URLSearchParams();
        if (query.limit !== undefined)
          params.set("limit", String(query.limit));
        if (query.before !== undefined)
          params.set("before", String(query.before));
        if (query.subject_type) params.set("subject_type", query.subject_type);
        const qs = params.toString();
        const path = `/api/comp/${comp_id}/audit${qs ? `?${qs}` : ""}`;
        const data = await compApi(env, user, "GET", path);
        return jsonResult(data);
      } catch (e) {
        return errorResult((e as Error).message);
      }
    }
  );
}
