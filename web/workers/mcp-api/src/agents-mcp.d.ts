/**
 * Minimal type declarations for agents/mcp and @modelcontextprotocol/sdk.
 *
 * WHY THIS FILE EXISTS:
 * The `agents` package (Cloudflare Agents SDK) bundles its entire type
 * surface — McpAgent, Durable Objects, OAuth, AI chat, fibers, etc. —
 * into a single ~3000-line .d.ts file. The `@modelcontextprotocol/sdk`
 * is similarly large. Together they cause TypeScript to consume 4+ GB
 * of memory and OOM during `tsc --noEmit`, both locally and in CI.
 *
 * We only use two things: `createMcpHandler` from `agents/mcp` and
 * `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`. This
 * file declares just those types, and tsconfig.json `paths` redirects
 * the imports here instead of into node_modules.
 *
 * If you add new imports from either package, add the types here too.
 * The bundler (wrangler) still resolves the real modules at build time.
 */
declare module "@modelcontextprotocol/sdk/server/mcp.js" {
  import { ZodType } from "zod";

  type ToolResult = Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export class McpServer {
    constructor(options: { name: string; version: string });
    registerTool<T extends Record<string, ZodType>>(
      name: string,
      definition: { description?: string; inputSchema?: T },
      handler: (args: { [K in keyof T]: T[K]["_output"] }) => ToolResult
    ): void;
  }
}

declare module "agents/mcp" {
  import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

  interface CreateMcpHandlerOptions {
    route?: string;
  }

  export function createMcpHandler(
    server: McpServer,
    options?: CreateMcpHandlerOptions
  ): (
    request: Request,
    env: unknown,
    ctx: ExecutionContext
  ) => Promise<Response>;
}
