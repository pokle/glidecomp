import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "../env";
import { compApi, jsonResult, errorResult } from "../util";

export function registerTaskTools(
  server: McpServer,
  env: Env,
  apiKey: string | null
) {
  server.registerTool(
    "get_task",
    {
      description:
        "Get task details including name, date, xctsk definition, pilot classes, and track count.",
      inputSchema: {
        comp_id: z.string().describe("Competition ID"),
        task_id: z.string().describe("Task ID"),
      },
    },
    async ({ comp_id, task_id }) => {
      try {
        const data = await compApi(
          env,
          apiKey,
          "GET",
          `/api/comp/${comp_id}/task/${task_id}`
        );
        return jsonResult(data);
      } catch (e) {
        return errorResult((e as Error).message);
      }
    }
  );

  server.registerTool(
    "create_task",
    {
      description:
        "Create a new task in a competition. Requires comp admin. Max 50 tasks per competition.",
      inputSchema: {
        comp_id: z.string().describe("Competition ID"),
        name: z.string().describe("Task name"),
        task_date: z
          .string()
          .describe("Task date in ISO format (e.g. '2026-03-15')"),
        pilot_classes: z
          .array(z.string())
          .describe(
            "Pilot classes this task applies to (must be valid for the competition)"
          ),
        xctsk: z
          .record(z.unknown())
          .optional()
          .describe(
            "XCTask definition (JSON object). Required for scoring."
          ),
      },
    },
    async ({ comp_id, ...body }) => {
      try {
        const data = await compApi(
          env,
          apiKey,
          "POST",
          `/api/comp/${comp_id}/task`,
          body
        );
        return jsonResult(data);
      } catch (e) {
        return errorResult((e as Error).message);
      }
    }
  );

  server.registerTool(
    "update_task",
    {
      description:
        "Update task settings. Requires comp admin. Fields not provided are left unchanged.",
      inputSchema: {
        comp_id: z.string().describe("Competition ID"),
        task_id: z.string().describe("Task ID"),
        name: z.string().optional().describe("New task name"),
        task_date: z.string().optional().describe("New task date (ISO)"),
        pilot_classes: z
          .array(z.string())
          .optional()
          .describe("Updated pilot classes"),
        xctsk: z
          .record(z.unknown())
          .nullable()
          .optional()
          .describe("XCTask definition or null to clear"),
      },
    },
    async ({ comp_id, task_id, ...body }) => {
      try {
        const data = await compApi(
          env,
          apiKey,
          "PATCH",
          `/api/comp/${comp_id}/task/${task_id}`,
          body
        );
        return jsonResult(data);
      } catch (e) {
        return errorResult((e as Error).message);
      }
    }
  );

  server.registerTool(
    "delete_task",
    {
      description:
        "Delete a task and all its tracks. Requires comp admin. Irreversible.",
      inputSchema: {
        comp_id: z.string().describe("Competition ID"),
        task_id: z.string().describe("Task ID"),
      },
    },
    async ({ comp_id, task_id }) => {
      try {
        const data = await compApi(
          env,
          apiKey,
          "DELETE",
          `/api/comp/${comp_id}/task/${task_id}`
        );
        return jsonResult(data);
      } catch (e) {
        return errorResult((e as Error).message);
      }
    }
  );
}
