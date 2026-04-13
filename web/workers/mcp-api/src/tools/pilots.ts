import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env, AuthUser } from "../env";
import { compApi, jsonResult, errorResult } from "../util";

const pilotFieldsSchema = {
  name: z.string().describe("Pilot's display name"),
  email: z.string().optional().describe("Email address"),
  civl_id: z.string().nullable().optional().describe("CIVL ID"),
  safa_id: z.string().nullable().optional().describe("SAFA ID"),
  ushpa_id: z.string().nullable().optional().describe("USHPA ID"),
  bhpa_id: z.string().nullable().optional().describe("BHPA ID"),
  dhv_id: z.string().nullable().optional().describe("DHV ID"),
  ffvl_id: z.string().nullable().optional().describe("FFVL ID"),
  fai_id: z.string().nullable().optional().describe("FAI ID"),
  glider: z.string().nullable().optional().describe("Glider model"),
  pilot_class: z.string().describe("Pilot class (must be valid for the competition)"),
  team_name: z.string().nullable().optional().describe("Team name"),
  driver_contact: z.string().nullable().optional().describe("Driver/retrieve contact info"),
  first_start_order: z.number().nullable().optional().describe("First start order number"),
};

export function registerPilotTools(
  server: McpServer,
  env: Env,
  user: AuthUser | null
) {
  server.registerTool(
    "get_pilot_profile",
    {
      description:
        "Get the current authenticated user's pilot profile (name, IDs, phone, glider).",
      inputSchema: {},
    },
    async () => {
      try {
        const data = await compApi(env, user, "GET", "/api/comp/pilot");
        return jsonResult(data);
      } catch (e) {
        return errorResult((e as Error).message);
      }
    }
  );

  server.registerTool(
    "update_pilot_profile",
    {
      description:
        "Update the current user's pilot profile. Triggers auto-linking to any pre-registered competition entries matching your identity fields.",
      inputSchema: {
        name: z.string().describe("Display name"),
        civl_id: z.string().nullable().optional().describe("CIVL ID"),
        safa_id: z.string().nullable().optional().describe("SAFA ID"),
        ushpa_id: z.string().nullable().optional().describe("USHPA ID"),
        bhpa_id: z.string().nullable().optional().describe("BHPA ID"),
        dhv_id: z.string().nullable().optional().describe("DHV ID"),
        ffvl_id: z.string().nullable().optional().describe("FFVL ID"),
        fai_id: z.string().nullable().optional().describe("FAI ID"),
        phone: z.string().nullable().optional().describe("Phone number"),
        glider: z.string().nullable().optional().describe("Glider model"),
      },
    },
    async (args) => {
      try {
        const data = await compApi(env, user, "PATCH", "/api/comp/pilot", args);
        return jsonResult(data);
      } catch (e) {
        return errorResult((e as Error).message);
      }
    }
  );

  server.registerTool(
    "list_pilots",
    {
      description:
        "List all registered pilots in a competition with their details, class, team, and linked status.",
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
          `/api/comp/${comp_id}/pilot`
        );
        return jsonResult(data);
      } catch (e) {
        return errorResult((e as Error).message);
      }
    }
  );

  server.registerTool(
    "register_pilot",
    {
      description:
        "Register a single pilot in a competition. Requires comp admin. Max 250 pilots per comp. The system will attempt to link the pilot to an existing GlideComp account by matching identity fields.",
      inputSchema: {
        comp_id: z.string().describe("Competition ID"),
        ...pilotFieldsSchema,
      },
    },
    async ({ comp_id, ...body }) => {
      try {
        const data = await compApi(
          env,
          user,
          "POST",
          `/api/comp/${comp_id}/pilot`,
          body
        );
        return jsonResult(data);
      } catch (e) {
        return errorResult((e as Error).message);
      }
    }
  );

  server.registerTool(
    "bulk_register_pilots",
    {
      description:
        "Bulk upsert pilots in a competition. Requires comp admin. Rows with comp_pilot_id are updates; rows without are inserts; existing pilots not in the payload are deleted. All-or-nothing — if any row fails validation, nothing is written.",
      inputSchema: {
        comp_id: z.string().describe("Competition ID"),
        pilots: z
          .array(
            z.object({
              comp_pilot_id: z
                .string()
                .optional()
                .describe("Include to update an existing pilot"),
              ...pilotFieldsSchema,
            })
          )
          .describe("Array of pilot records"),
      },
    },
    async ({ comp_id, pilots }) => {
      try {
        const data = await compApi(
          env,
          user,
          "POST",
          `/api/comp/${comp_id}/pilot/bulk`,
          { pilots }
        );
        return jsonResult(data);
      } catch (e) {
        return errorResult((e as Error).message);
      }
    }
  );

  server.registerTool(
    "update_comp_pilot",
    {
      description:
        "Update a single pilot's registration details in a competition. Requires comp admin.",
      inputSchema: {
        comp_id: z.string().describe("Competition ID"),
        comp_pilot_id: z.string().describe("Competition pilot ID"),
        name: z.string().optional().describe("Pilot name"),
        email: z.string().nullable().optional().describe("Email"),
        civl_id: z.string().nullable().optional().describe("CIVL ID"),
        safa_id: z.string().nullable().optional().describe("SAFA ID"),
        ushpa_id: z.string().nullable().optional().describe("USHPA ID"),
        bhpa_id: z.string().nullable().optional().describe("BHPA ID"),
        dhv_id: z.string().nullable().optional().describe("DHV ID"),
        ffvl_id: z.string().nullable().optional().describe("FFVL ID"),
        fai_id: z.string().nullable().optional().describe("FAI ID"),
        glider: z.string().nullable().optional().describe("Glider model"),
        pilot_class: z.string().optional().describe("Pilot class"),
        team_name: z.string().nullable().optional().describe("Team name"),
        driver_contact: z.string().nullable().optional().describe("Driver contact"),
        first_start_order: z.number().nullable().optional().describe("First start order"),
      },
    },
    async ({ comp_id, comp_pilot_id, ...body }) => {
      try {
        const data = await compApi(
          env,
          user,
          "PATCH",
          `/api/comp/${comp_id}/pilot/${comp_pilot_id}`,
          body
        );
        return jsonResult(data);
      } catch (e) {
        return errorResult((e as Error).message);
      }
    }
  );

  server.registerTool(
    "remove_pilot",
    {
      description:
        "Remove a pilot from a competition. Requires comp admin. Also removes their tracks.",
      inputSchema: {
        comp_id: z.string().describe("Competition ID"),
        comp_pilot_id: z.string().describe("Competition pilot ID"),
      },
    },
    async ({ comp_id, comp_pilot_id }) => {
      try {
        const data = await compApi(
          env,
          user,
          "DELETE",
          `/api/comp/${comp_id}/pilot/${comp_pilot_id}`
        );
        return jsonResult(data);
      } catch (e) {
        return errorResult((e as Error).message);
      }
    }
  );
}
