/** User lookup tools. */

import { z } from "zod";
import { isHttpStatusError } from "../errors.js";
import { dumps } from "../json.js";
import type { ToolDef } from "./types.js";

function userRecord(u: any): Record<string, unknown> {
  return {
    key: u.key,
    name: u.name,
    displayName: u.displayName,
    emailAddress: u.emailAddress,
    active: u.active,
  };
}

export const userTools: ToolDef[] = [
  {
    name: "get_user",
    description:
      "Get user details by key (e.g. JIRAUSER10000) or username. " +
      "Works for both active and deactivated users. " +
      "Returns display name, email, active status.",
    inputShape: { key: z.string().describe("User key (JIRAUSER…) or username") },
    async handler({ client }, args) {
      try {
        const user = await client.getUser(args.key);
        return dumps(userRecord(user));
      } catch (e) {
        if (isHttpStatusError(e)) {
          if (e.status === 404) return dumps({ error: `User not found: ${args.key}` });
          return dumps({ error: `HTTP ${e.status}: ${e.body.slice(0, 200)}` });
        }
        throw e;
      }
    },
  },

  {
    name: "find_users",
    description:
      "Search for users by username, display name, or email address. " +
      "By default returns only active users; set include_inactive=true to include deactivated accounts. " +
      "Returns matching users with key, name, email, and active status.",
    inputShape: {
      query: z.string().describe("Search string (username, display name, or email)"),
      max_results: z.coerce.number().int().optional().describe("Max results to return (default 10)"),
      include_inactive: z.boolean().optional().describe("Include deactivated users (default false)"),
    },
    async handler({ client }, args) {
      try {
        const users = await client.findUsers(
          args.query,
          args.max_results ?? 10,
          args.include_inactive ?? false,
        );
        return dumps(users.map(userRecord));
      } catch (e) {
        if (isHttpStatusError(e)) {
          return dumps({ error: `HTTP ${e.status}: ${e.body.slice(0, 200)}` });
        }
        throw e;
      }
    },
  },

  {
    name: "get_user_groups",
    description:
      "Get groups a user belongs to, by user key (JIRAUSER…) or username. " +
      "Works for both active and deactivated users. " +
      "Returns a list of group names. Useful for tracing how a user gained project-role access.",
    inputShape: { key: z.string().describe("User key (e.g. JIRAUSER10000) or username") },
    async handler({ client }, args) {
      try {
        const groups = await client.getUserGroups(args.key);
        return dumps(groups.map((g: any) => ({ name: g.name })));
      } catch (e) {
        if (isHttpStatusError(e)) {
          if (e.status === 404) return dumps({ error: `User not found: ${args.key}` });
          return dumps({ error: `HTTP ${e.status}: ${e.body.slice(0, 200)}` });
        }
        throw e;
      }
    },
  },

  {
    name: "get_group_members",
    description:
      "List members of a Jira group. Auto-paginates. " +
      "Useful for auditing project-role membership when roles are populated by groups.",
    inputShape: {
      group_name: z.string().describe("Exact group name (e.g. jira-administrators)"),
      include_inactive: z.boolean().optional().describe("Include inactive users (default false)"),
      max_results: z.coerce.number().int().optional().describe("Cap on returned members (default 1000)"),
    },
    async handler({ client }, args) {
      const maxResults = args.max_results ?? 1000;
      try {
        const members = await client.getGroupMembers(
          args.group_name,
          args.include_inactive ?? false,
          maxResults,
        );
        return dumps(members.slice(0, maxResults).map(userRecord));
      } catch (e) {
        if (isHttpStatusError(e)) {
          if (e.status === 404) return dumps({ error: `Group not found: ${args.group_name}` });
          return dumps({ error: `HTTP ${e.status}: ${e.body.slice(0, 200)}` });
        }
        throw e;
      }
    },
  },
];
