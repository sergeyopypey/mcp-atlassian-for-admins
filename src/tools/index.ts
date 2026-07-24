/** Aggregated registry of all 76 MCP tools. */

import type { ToolDef } from "./types.js";
import { dumpTools } from "./dump.js";
import { projectTools } from "./projects.js";
import { workflowTools } from "./workflows.js";
import { screenTools } from "./screens.js";
import { fieldTools } from "./fields.js";
import { schemeTools } from "./schemes.js";
import { automationTools } from "./automation.js";
import { boardTools } from "./boards.js";
import { serviceDeskTools } from "./servicedesk.js";
import { filterTools } from "./filters.js";
import { analysisTools } from "./analysis.js";
import { issueTools } from "./issues.js";
import { userTools } from "./users.js";
import { adminTools } from "./admin.js";
import { logTools } from "./logs.js";
import { assetsTools } from "./assets.js";
import { pluginTools } from "./plugins.js";
import { scriptRegistryTools } from "./scriptregistry.js";

export const ALL_TOOLS: ToolDef[] = [
  ...dumpTools,
  ...projectTools,
  ...workflowTools,
  ...screenTools,
  ...fieldTools,
  ...schemeTools,
  ...automationTools,
  ...boardTools,
  ...serviceDeskTools,
  ...filterTools,
  ...analysisTools,
  ...issueTools,
  ...userTools,
  ...adminTools,
  ...logTools,
  ...assetsTools,
  ...pluginTools,
  ...scriptRegistryTools,
];

export type { ToolDef, ToolContext } from "./types.js";
