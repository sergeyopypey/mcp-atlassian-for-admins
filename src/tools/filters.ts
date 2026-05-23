/** Filter and dashboard introspection tools. */

import { z } from "zod";
import { dumps } from "../json.js";
import type { ToolDef } from "./types.js";

export const filterTools: ToolDef[] = [
  {
    name: "get_filter",
    description:
      "Get a single JQL filter by id, including its JQL, owner and share " +
      "permissions. Use to resolve a board's backing filter (get_board_configuration " +
      "returns the filter id) into its actual query.",
    inputShape: { filter_id: z.coerce.number().int().describe("Filter id (e.g. 15650)") },
    async handler({ client }, args) {
      const f = await client.getFilter(args.filter_id);
      return dumps({
        id: f.id,
        name: f.name,
        jql: f.jql,
        description: f.description ?? "",
        owner: f.owner ? (f.owner.displayName ?? null) : null,
        favourite: f.favourite,
        favouritedCount: f.favouritedCount,
        sharePermissions: (f.sharePermissions ?? []).map((sp: any) => ({
          type: sp.type,
          project: sp.project ? (sp.project.key ?? null) : null,
          role: sp.role ? (sp.role.name ?? null) : null,
          group: sp.group ? (sp.group.name ?? null) : null,
        })),
      });
    },
  },

  {
    name: "list_filters",
    description:
      "List favourite/shared JQL filters visible to the authenticated user. " +
      "Shows filter name, JQL query, owner, and share permissions.",
    inputShape: {},
    async handler({ client }) {
      const filters = await client.listFilters();
      return dumps(
        filters.map((f: any) => ({
          id: f.id,
          name: f.name,
          jql: f.jql,
          owner: (f.owner ?? {}).displayName,
          favourite: f.favourite,
          favouritedCount: f.favouritedCount,
          sharePermissions: (f.sharePermissions ?? []).map((sp: any) => ({
            type: sp.type,
            project: sp.project ? (sp.project.key ?? null) : null,
            role: sp.role ? (sp.role.name ?? null) : null,
            group: sp.group ? (sp.group.name ?? null) : null,
          })),
        })),
      );
    },
  },

  {
    name: "list_dashboards",
    description: "List all dashboards with owner and popularity.",
    inputShape: {},
    async handler({ client }) {
      const dashboards = await client.listDashboards();
      return dumps(
        dashboards.map((d: any) => ({
          id: d.id,
          name: d.name,
          owner: d.owner ? (d.owner.displayName ?? null) : null,
          popularity: d.popularity,
          view: d.view,
        })),
      );
    },
  },
];
