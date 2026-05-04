import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "../env";
import { compApi, compApiRaw, jsonResult, errorResult } from "../util";

export function registerTrackTools(
  server: McpServer,
  env: Env,
  apiKey: string | null
) {
  server.registerTool(
    "list_tracks",
    {
      description:
        "List all uploaded IGC tracks for a task, with pilot name, file size, penalties, and upload attribution.",
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
          `/api/comp/${comp_id}/task/${task_id}/igc`
        );
        return jsonResult(data);
      } catch (e) {
        return errorResult((e as Error).message);
      }
    }
  );

  server.registerTool(
    "upload_igc",
    {
      description:
        "Upload an IGC track file for yourself. The IGC content is plain ASCII text. If you already have a track for this task, it will be replaced (penalties preserved). Requires authentication.",
      inputSchema: {
        comp_id: z.string().describe("Competition ID"),
        task_id: z.string().describe("Task ID"),
        igc_content: z
          .string()
          .describe("The full IGC file content as plain text"),
      },
    },
    async ({ comp_id, task_id, igc_content }) => {
      try {
        // Gzip compress the IGC text before sending
        const textBytes = new TextEncoder().encode(igc_content);
        const cs = new CompressionStream("gzip");
        const writer = cs.writable.getWriter();
        writer.write(textBytes);
        writer.close();
        const gzipped = await new Response(cs.readable).arrayBuffer();

        const res = await compApiRaw(
          env,
          apiKey,
          "POST",
          `/api/comp/${comp_id}/task/${task_id}/igc`,
          gzipped,
          { "Content-Type": "application/octet-stream" }
        );

        const data = await res.json();
        if (!res.ok) {
          return errorResult(
            (data as { error?: string }).error ?? `Upload failed: ${res.status}`
          );
        }
        return jsonResult(data);
      } catch (e) {
        return errorResult((e as Error).message);
      }
    }
  );

  server.registerTool(
    "upload_igc_on_behalf",
    {
      description:
        "Upload an IGC track on behalf of another pilot. Requires comp admin, or any registered pilot if open_igc_upload is enabled on the competition.",
      inputSchema: {
        comp_id: z.string().describe("Competition ID"),
        task_id: z.string().describe("Task ID"),
        comp_pilot_id: z
          .string()
          .describe("The competition pilot ID to upload for"),
        igc_content: z
          .string()
          .describe("The full IGC file content as plain text"),
      },
    },
    async ({ comp_id, task_id, comp_pilot_id, igc_content }) => {
      try {
        const textBytes = new TextEncoder().encode(igc_content);
        const cs = new CompressionStream("gzip");
        const writer = cs.writable.getWriter();
        writer.write(textBytes);
        writer.close();
        const gzipped = await new Response(cs.readable).arrayBuffer();

        const res = await compApiRaw(
          env,
          apiKey,
          "POST",
          `/api/comp/${comp_id}/task/${task_id}/igc/${comp_pilot_id}`,
          gzipped,
          { "Content-Type": "application/octet-stream" }
        );

        const data = await res.json();
        if (!res.ok) {
          return errorResult(
            (data as { error?: string }).error ?? `Upload failed: ${res.status}`
          );
        }
        return jsonResult(data);
      } catch (e) {
        return errorResult((e as Error).message);
      }
    }
  );

  server.registerTool(
    "download_igc",
    {
      description:
        "Download an IGC track file for a pilot. Returns the IGC content as plain text.",
      inputSchema: {
        comp_id: z.string().describe("Competition ID"),
        task_id: z.string().describe("Task ID"),
        comp_pilot_id: z
          .string()
          .describe("Competition pilot ID"),
      },
    },
    async ({ comp_id, task_id, comp_pilot_id }) => {
      try {
        const res = await compApiRaw(
          env,
          apiKey,
          "GET",
          `/api/comp/${comp_id}/task/${task_id}/igc/${comp_pilot_id}/download`
        );

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          return errorResult(
            (data as { error?: string }).error ?? `Download failed: ${res.status}`
          );
        }

        // The response may be gzip-encoded; decompress if needed
        const contentEncoding = res.headers.get("Content-Encoding");
        let text: string;
        if (contentEncoding === "gzip") {
          const ds = new DecompressionStream("gzip");
          const decompressed = res.body!.pipeThrough(ds);
          text = await new Response(decompressed).text();
        } else {
          text = await res.text();
        }

        return {
          content: [{ type: "text" as const, text }],
        };
      } catch (e) {
        return errorResult((e as Error).message);
      }
    }
  );

  server.registerTool(
    "update_penalty",
    {
      description:
        "Set or update a penalty on a pilot's track for a task. Requires comp admin.",
      inputSchema: {
        comp_id: z.string().describe("Competition ID"),
        task_id: z.string().describe("Task ID"),
        comp_pilot_id: z.string().describe("Competition pilot ID"),
        penalty_points: z
          .number()
          .describe("Penalty points to apply (0 to clear)"),
        penalty_reason: z
          .string()
          .optional()
          .describe("Reason for the penalty"),
      },
    },
    async ({ comp_id, task_id, comp_pilot_id, ...body }) => {
      try {
        const data = await compApi(
          env,
          apiKey,
          "PATCH",
          `/api/comp/${comp_id}/task/${task_id}/igc/${comp_pilot_id}`,
          body
        );
        return jsonResult(data);
      } catch (e) {
        return errorResult((e as Error).message);
      }
    }
  );

  server.registerTool(
    "delete_track",
    {
      description:
        "Delete a pilot's IGC track from a task. Requires comp admin. Irreversible.",
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
          apiKey,
          "DELETE",
          `/api/comp/${comp_id}/task/${task_id}/igc/${comp_pilot_id}`
        );
        return jsonResult(data);
      } catch (e) {
        return errorResult((e as Error).message);
      }
    }
  );
}
