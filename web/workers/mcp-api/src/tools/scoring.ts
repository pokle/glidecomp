import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env, AuthUser } from "../env";
import { compApi, jsonResult, errorResult } from "../util";

export function registerScoringTools(
  server: McpServer,
  env: Env,
  user: AuthUser | null
) {
  server.registerTool(
    "get_task_scores",
    {
      description:
        "Get GAP scores for a task. Returns per-class results with task validity, available points, and per-pilot breakdown (distance, time, leading, arrival points, penalties, total score, rank). Requires the task to have an xctsk definition.",
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
          `/api/comp/${comp_id}/task/${task_id}/score`
        );
        return jsonResult(data);
      } catch (e) {
        return errorResult((e as Error).message);
      }
    }
  );

  server.registerTool(
    "get_competition_scores",
    {
      description:
        "Get overall competition standings. Aggregates scores across all scored tasks, ranked by total score per pilot class.",
      inputSchema: {
        comp_id: z.string().describe("Competition ID"),
      },
    },
    async ({ comp_id }) => {
      try {
        const data = await compApi(
          env,
          user,
          "GET",
          `/api/comp/${comp_id}/scores`
        );
        return jsonResult(data);
      } catch (e) {
        return errorResult((e as Error).message);
      }
    }
  );
}
