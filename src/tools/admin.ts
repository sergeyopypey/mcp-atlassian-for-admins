/**
 * Instance-administration introspection tools.
 *
 * These expose data invisible to Jira DC's standard REST API (event listeners,
 * scheduled services, application links, effective permissions) via ScriptRunner
 * custom endpoints. If an endpoint is missing or erroring, the underlying client
 * call raises — the failure surfaces as a tool error rather than a silent result.
 */

import { z } from "zod";
import { dumps } from "../json.js";
import type { ToolDef } from "./types.js";

export const adminTools: ToolDef[] = [
  {
    name: "list_listeners",
    description:
      "List all registered event listeners (built-in, plugin, ScriptRunner). " +
      "Listeners cause side effects invisible to the REST API.",
    inputShape: {},
    async handler({ client }) {
      const listeners = await client.listListeners();
      return dumps({ count: listeners.length, listeners });
    },
  },

  {
    name: "list_scheduled_services",
    description:
      "List all Jira scheduled services (mail handlers, backup services, etc.) " +
      "with their cron schedules. Sensitive properties are redacted.",
    inputShape: {},
    async handler({ client }) {
      const services = await client.listScheduledServices();
      return dumps({ count: services.length, services });
    },
  },

  {
    name: "list_application_links",
    description:
      "List application links to Confluence, Bitbucket, Bamboo, etc., with type, " +
      "URLs, and authentication status.",
    inputShape: {},
    async handler({ client }) {
      const links = await client.listApplicationLinks();
      return dumps({ count: links.length, applicationLinks: links });
    },
  },

  {
    name: "get_effective_permissions",
    description:
      "Resolve effective permissions on a project by walking groups, roles, and " +
      "grants. Pass username to get every permission a user holds, and/or " +
      "permission to get every user that holds it. At least one is required.",
    inputShape: {
      project_key: z.string().describe("Project key to check"),
      username: z.string().optional().describe("User to resolve permissions for"),
      permission: z.string().optional().describe("Permission key (e.g. BROWSE_PROJECTS)"),
    },
    async handler({ client }, args) {
      if (!args.username && !args.permission) {
        return dumps({ error: "Provide at least one of 'username' or 'permission'" });
      }
      const data = await client.getEffectivePermissions(
        args.project_key,
        args.username,
        args.permission,
      );
      return dumps(data);
    },
  },
];
