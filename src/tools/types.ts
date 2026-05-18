import type { z } from "zod";
import type { JiraClient } from "../client.js";
import type { AutomationCache } from "../automationCache.js";

/** Shared dependencies passed to every tool handler. */
export interface ToolContext {
  client: JiraClient;
  cache: AutomationCache;
}

/**
 * A single MCP tool: its name, description, Zod input shape, and handler.
 * The handler returns the JSON string that becomes the tool's text content.
 */
export interface ToolDef {
  name: string;
  description: string;
  inputShape: z.ZodRawShape;
  handler: (ctx: ToolContext, args: Record<string, any>) => Promise<string>;
}
