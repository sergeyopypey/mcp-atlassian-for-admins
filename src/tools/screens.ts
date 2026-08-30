/** Screen introspection tools. */

import { z } from "zod";
import { dumps } from "../json.js";
import type { ToolDef } from "./types.js";
import { filterByName, nameFilterShape, pageShape, paginate } from "./util.js";

const SCREEN_SCHEME_PAGE = 100;
const ITSS_PAGE = 30;

export const screenTools: ToolDef[] = [
  {
    name: "list_screens",
    description: "List all screens with IDs and names.",
    inputShape: {},
    async handler({ client }) {
      const screens = await client.listScreens();
      return dumps(
        screens.map((s: any) => ({
          id: s.id,
          name: s.name,
          description: s.description ?? "",
        })),
      );
    },
  },

  {
    name: "get_screen_tabs_and_fields",
    description:
      "Get a screen's tabs with all fields in order. Shows exactly what users see.",
    inputShape: { screen_id: z.coerce.number().int().describe("Screen ID") },
    async handler({ client }, args) {
      const screenId = args.screen_id;
      const full = await client.getScreenFull(screenId);

      const screens = await client.listScreens();
      const match = screens.find((s: any) => s.id === screenId);
      const screenName = match ? match.name : `Screen ${screenId}`;

      return dumps({
        screenId,
        screenName,
        tabs: (full.tabs ?? []).map((tab: any) => ({
          id: tab.id,
          name: tab.name,
          fields: (tab.fields ?? []).map((f: any) => ({ id: f.id, name: f.name })),
        })),
      });
    },
  },

  {
    name: "list_screen_schemes",
    description:
      "List all screen schemes with their screens and inferred operation mappings " +
      "(create/edit/view). Reconstructed from screens expand on DC 10. " +
      "Paginated (offset/limit) and filterable by name_contains.",
    inputShape: { ...nameFilterShape, ...pageShape(SCREEN_SCHEME_PAGE) },
    async handler({ client }, args) {
      const schemes = filterByName(await client.listScreenSchemes(), args.name_contains);
      return dumps(paginate(schemes, args, SCREEN_SCHEME_PAGE));
    },
  },

  {
    name: "get_screen_scheme",
    description:
      "Get a screen scheme with its screens, operation mappings (create/edit/view), " +
      "and tab names. Reconstructed from screens expand on DC 10.",
    inputShape: { scheme_id: z.coerce.number().int().describe("Screen scheme ID") },
    async handler({ client }, args) {
      const schemes = await client.listScreenSchemes();
      const scheme = schemes.find((s: any) => s.id === args.scheme_id);
      if (scheme === undefined) {
        return dumps({ error: `Screen scheme ${args.scheme_id} not found` });
      }
      return dumps(scheme);
    },
  },

  {
    name: "list_issue_type_screen_schemes",
    description:
      "List all issue type screen schemes with their issue-type-to-screen-scheme " +
      "mappings and associated projects. Backed by a ScriptRunner endpoint. " +
      "Paginated (offset/limit); filter by name_contains or by project_key " +
      "(schemes associated with that project).",
    inputShape: {
      ...nameFilterShape,
      project_key: z
        .string()
        .optional()
        .describe("Only return schemes associated with this project key"),
      ...pageShape(ITSS_PAGE),
    },
    async handler({ client }, args) {
      let schemes = filterByName(await client.listIssueTypeScreenSchemes(), args.name_contains);
      if (args.project_key) {
        const key = String(args.project_key).toUpperCase();
        schemes = schemes.filter((s: any) =>
          (s.projects ?? []).some((p: any) => String(p?.key ?? "").toUpperCase() === key),
        );
      }
      return dumps(paginate(schemes, args, ITSS_PAGE));
    },
  },

  {
    name: "get_issue_type_screen_scheme",
    description: "Get a single issue type screen scheme with its mappings and projects.",
    inputShape: {
      scheme_id: z.coerce.number().int().describe("Issue type screen scheme ID"),
    },
    async handler({ client }, args) {
      const schemes = await client.listIssueTypeScreenSchemes();
      const scheme = schemes.find((s: any) => s.id === args.scheme_id);
      if (scheme === undefined) {
        return dumps({ error: `Issue type screen scheme ${args.scheme_id} not found` });
      }
      return dumps(scheme);
    },
  },
];
