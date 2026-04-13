/**
 * Minimal type declarations for agents/mcp and @modelcontextprotocol/sdk.
 *
 * The full `agents` and `@modelcontextprotocol/sdk` packages have enormous
 * bundled type definitions that cause TypeScript to OOM during typechecking.
 * We declare only the types we actually use.
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
