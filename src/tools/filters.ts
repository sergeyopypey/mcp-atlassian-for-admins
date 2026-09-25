/** Filter and dashboard introspection tools. */

import { dumps } from "../json.js";
import type { ToolDef } from "./types.js";
import { filterByName, nameFilterShape, pageShape, paginate } from "./util.js";

const DASHBOARD_PAGE = 200;

export const filterTools: ToolDef[] = [
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
    description:
      "List dashboards visible to the authenticated user: id, name, and view URL. " +
      "The dashboard REST API does not expose owner or popularity. " +
      "Paginated (offset/limit) and filterable by name_contains.",
    inputShape: { ...nameFilterShape, ...pageShape(DASHBOARD_PAGE) },
    async handler({ client }, args) {
      const dashboards = filterByName(await client.listDashboards(), args.name_contains);
      return dumps(
        paginate(
          dashboards.map((d: any) => ({ id: d.id, name: d.name, view: d.view })),
          args,
          DASHBOARD_PAGE,
        ),
      );
    },
  },
];
