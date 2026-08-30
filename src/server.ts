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

/**
 * Largest tool result (in characters) handed to the MCP client. Claude Code
 * drops results over ~25k tokens, which dense JSON reaches at roughly 75k
 * characters; an oversized result is replaced by an error telling the model
 * how to narrow the call. `JIRA_MCP_MAX_RESPONSE_CHARS=0` disables the check.
 */
const MAX_RESPONSE_CHARS = Number(process.env.JIRA_MCP_MAX_RESPONSE_CHARS ?? 60_000);

function tooLargeError(toolName: string, size: number): string {
  return JSON.stringify({
    error:
      `Response too large: ${size} characters, limit is ${MAX_RESPONSE_CHARS}. ` +
      "Narrow the call: pass a smaller limit, page with offset, or use the tool's " +
      "filters (name_contains, project_key, ...). For a single large entity, use the " +
      "matching get_* tool instead of a list/dump tool.",
    tool: toolName,
  });
}

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
          let text = await tool.handler(ctx, args ?? {});
          if (MAX_RESPONSE_CHARS > 0 && text.length > MAX_RESPONSE_CHARS) {
            console.error(`Tool ${tool.name} response too large: ${text.length} chars`);
            text = tooLargeError(tool.name, text.length);
          }
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
