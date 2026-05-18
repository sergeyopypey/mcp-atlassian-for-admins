/**
 * MCP server — registers all 60 tools and wires them to the Jira DC client.
 *
 * This server operates in read-only mode. It does not modify Jira configuration.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { JiraClient } from "./client.js";
import { AutomationCache } from "./automationCache.js";
import { ALL_TOOLS } from "./tools/index.js";
import type { ToolContext } from "./tools/types.js";

export interface CreatedServer {
  server: McpServer;
  client: JiraClient;
  cache: AutomationCache;
}

/**
 * Create and configure the MCP server with all tools.
 *
 * Returns the server, client, and automation cache so the caller can manage
 * their lifecycle (start the cache, close the client).
 */
export function createServer(): CreatedServer {
  const client = new JiraClient();
  const cache = new AutomationCache(client);
  const ctx: ToolContext = { client, cache };

  const server = new McpServer({ name: "jira-dc-mcp", version: "0.1.0" });

  for (const tool of ALL_TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputShape },
      async (args: Record<string, any>) => {
        try {
          const text = await tool.handler(ctx, args ?? {});
          return { content: [{ type: "text" as const, text }] };
        } catch (e: any) {
          console.error(`Tool ${tool.name} failed: ${e?.stack ?? e}`);
          const errorMsg = JSON.stringify(
            { error: String(e?.message ?? e), tool: tool.name },
            null,
            2,
          );
          return { content: [{ type: "text" as const, text: errorMsg }] };
        }
      },
    );
  }

  return { server, client, cache };
}
