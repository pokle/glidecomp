import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env, AuthUser } from "../env";
import { compApi, jsonResult, errorResult } from "../util";

export function registerCompetitionTools(
  server: McpServer,
  env: Env,
  user: AuthUser | null
) {
  server.registerTool(
    "list_competitions",
    {
      description:
        "List all competitions you have access to. Returns public (non-test) competitions and any competitions you admin.",
      inputSchema: {},
    },
    async () => {
      try {
        const data = await compApi(env, user, "GET", "/api/comp");
        return jsonResult(data);
      } catch (e) {
        return errorResult((e as Error).message);
      }
    }
  );

  server.registerTool(
    "get_competition",
    {
      description:
        "Get full details of a competition including tasks, pilot count, admin list, and class coverage warnings. Test competitions require admin access.",
      inputSchema: {
        comp_id: z.string().describe("Competition ID (encoded string)"),
      },
    },
    async ({ comp_id }) => {
      try {
        const data = await compApi(
          env,
          user,
          "GET",
          `/api/comp/${comp_id}`
        );
        return jsonResult(data);
      } catch (e) {
        return errorResult((e as Error).message);
      }
    }
  );

  server.registerTool(
    "create_competition",
    {
      description:
        "Create a new competition. You become the first admin. Requires authentication. Max 50 competitions per account.",
      inputSchema: {
        name: z.string().describe("Competition name"),
        category: z
          .enum(["hg", "pg"])
          .describe("Category: 'hg' (hang gliding) or 'pg' (paragliding)"),
        pilot_classes: z
          .array(z.string())
          .optional()
          .describe("Pilot classes (default: ['open'])"),
        default_pilot_class: z
          .string()
          .optional()
          .describe(
            "Default pilot class for new registrations (must be in pilot_classes)"
          ),
        test: z
          .boolean()
          .optional()
          .describe("If true, competition is hidden from public listings"),
        close_date: z
          .string()
          .optional()
          .describe(
            "ISO date when track submissions close (e.g. '2026-12-31')"
          ),
        gap_params: z
          .record(z.unknown())
          .optional()
          .describe("GAP scoring parameters (JSON object)"),
      },
    },
    async (args) => {
      try {
        const data = await compApi(env, user, "POST", "/api/comp", args);
        return jsonResult(data);
      } catch (e) {
        return errorResult((e as Error).message);
      }
    }
  );

  server.registerTool(
    "update_competition",
    {
      description:
        "Update competition settings. Requires comp admin. Fields not provided are left unchanged.",
      inputSchema: {
        comp_id: z.string().describe("Competition ID"),
        name: z.string().optional().describe("New competition name"),
        category: z
          .enum(["hg", "pg"])
          .optional()
          .describe("Category"),
        close_date: z
          .string()
          .nullable()
          .optional()
          .describe("Close date (ISO) or null to remove"),
        test: z.boolean().optional().describe("Test flag"),
        pilot_classes: z
          .array(z.string())
          .optional()
          .describe("Pilot classes"),
        default_pilot_class: z
          .string()
          .optional()
          .describe("Default pilot class"),
        gap_params: z
          .record(z.unknown())
          .nullable()
          .optional()
          .describe("GAP scoring parameters or null"),
        open_igc_upload: z
          .boolean()
          .optional()
          .describe(
            "If true, any registered pilot can upload IGC on behalf of others"
          ),
        admin_emails: z
          .array(z.string())
          .optional()
          .describe("Set admin list by email addresses"),
        pilot_statuses: z
          .array(
            z.object({
              key: z.string(),
              label: z.string(),
              on_track_upload: z.enum(["none", "clear", "set"]),
            })
          )
          .optional()
          .describe("Configure pilot status options"),
      },
    },
    async ({ comp_id, ...body }) => {
      try {
        const data = await compApi(
          env,
          user,
          "PATCH",
          `/api/comp/${comp_id}`,
          body
        );
        return jsonResult(data);
      } catch (e) {
        return errorResult((e as Error).message);
      }
    }
  );

  server.registerTool(
    "delete_competition",
    {
      description:
        "Delete a competition and all its tasks, pilots, tracks, and audit entries. Requires comp admin. This action is irreversible.",
      inputSchema: {
        comp_id: z.string().describe("Competition ID"),
      },
    },
    async ({ comp_id }) => {
      try {
        const data = await compApi(
          env,
          user,
          "DELETE",
          `/api/comp/${comp_id}`
        );
        return jsonResult(data);
      } catch (e) {
        return errorResult((e as Error).message);
      }
    }
  );
}
