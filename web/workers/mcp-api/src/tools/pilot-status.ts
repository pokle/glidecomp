import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env, AuthUser } from "../env";
import { compApi, jsonResult, errorResult } from "../util";

export function registerPilotStatusTools(
  server: McpServer,
  env: Env,
  user: AuthUser | null
) {
  server.registerTool(
    "list_pilot_statuses",
    {
      description:
        "List all pilot statuses for a task (e.g. 'safely landed', 'DNF'). Each pilot can have at most one status per task.",
      inputSchema: {
        comp_id: z.string().describe("Competition ID"),
        task_id: z.string().describe("Task ID"),
      },
    },
    async ({ comp_id, task_id }) => {
      try {
        const data = await compApi(
          env,
          user,
          "GET",
          `/api/comp/${comp_id}/task/${task_id}/pilot-status`
        );
        return jsonResult(data);
      } catch (e) {
        return errorResult((e as Error).message);
      }
    }
  );

  server.registerTool(
    "set_pilot_status",
    {
      description:
        "Set or replace a pilot's status for a task. Allowed by comp admins, the pilot themselves, or any registered pilot if open_igc_upload is enabled. The status_key must be one of the competition's configured statuses.",
      inputSchema: {
        comp_id: z.string().describe("Competition ID"),
        task_id: z.string().describe("Task ID"),
        comp_pilot_id: z.string().describe("Competition pilot ID"),
        status_key: z
          .string()
          .describe(
            "Status key (e.g. 'safely_landed', 'dnf'). Must match a configured status."
          ),
        note: z.string().optional().describe("Optional note"),
      },
    },
    async ({ comp_id, task_id, comp_pilot_id, ...body }) => {
      try {
        const data = await compApi(
          env,
          user,
          "PUT",
          `/api/comp/${comp_id}/task/${task_id}/pilot-status/${comp_pilot_id}`,
          body
        );
        return jsonResult(data);
      } catch (e) {
        return errorResult((e as Error).message);
      }
    }
  );

  server.registerTool(
    "update_pilot_status_note",
    {
      description:
        "Update only the note on an existing pilot status, leaving the status key unchanged.",
      inputSchema: {
        comp_id: z.string().describe("Competition ID"),
        task_id: z.string().describe("Task ID"),
        comp_pilot_id: z.string().describe("Competition pilot ID"),
        note: z.string().nullable().describe("New note text, or null to clear"),
      },
    },
    async ({ comp_id, task_id, comp_pilot_id, ...body }) => {
      try {
        const data = await compApi(
          env,
          user,
          "PATCH",
          `/api/comp/${comp_id}/task/${task_id}/pilot-status/${comp_pilot_id}`,
          body
        );
        return jsonResult(data);
      } catch (e) {
        return errorResult((e as Error).message);
      }
    }
  );

  server.registerTool(
    "clear_pilot_status",
    {
      description:
        "Remove a pilot's status for a task. Same authorization rules as set_pilot_status.",
      inputSchema: {
        comp_id: z.string().describe("Competition ID"),
        task_id: z.string().describe("Task ID"),
        comp_pilot_id: z.string().describe("Competition pilot ID"),
      },
    },
    async ({ comp_id, task_id, comp_pilot_id }) => {
      try {
        const data = await compApi(
          env,
          user,
          "DELETE",
          `/api/comp/${comp_id}/task/${task_id}/pilot-status/${comp_pilot_id}`
        );
        return jsonResult(data);
      } catch (e) {
        return errorResult((e as Error).message);
      }
    }
  );
}
