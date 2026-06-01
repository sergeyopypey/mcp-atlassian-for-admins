/** Agile board introspection tools. */

import { z } from "zod";
import { dumps } from "../json.js";
import type { ToolDef } from "./types.js";

export const boardTools: ToolDef[] = [
  {
    name: "list_boards",
    description:
      "List all agile boards (Scrum/Kanban). Optionally filter by project key. " +
      "Shows board name, type, and associated project.",
    inputShape: {
      project_key: z
        .string()
        .optional()
        .describe("Optional project key to filter boards. Omit for all boards."),
    },
    async handler({ client }, args) {
      const boards = await client.listBoards(args.project_key);
      return dumps(
        boards.map((b: any) => ({
          id: b.id,
          name: b.name,
          type: b.type,
          projectKey: (b.location ?? {}).projectKey,
          projectName: (b.location ?? {}).projectName,
        })),
      );
    },
  },

  {
    name: "get_board_configuration",
    description:
      "Get board configuration: columns (with status mappings and WIP limits), " +
      "estimation settings, ranking, and backing filter/JQL. " +
      "Shows how teams actually see and manage work vs. the underlying workflow.",
    inputShape: { board_id: z.coerce.number().int().describe("Agile board ID") },
    async handler({ client }, args) {
      const config = await client.getBoardConfiguration(args.board_id);

      const columns = ((config.columnConfig ?? {}).columns ?? []).map((col: any) => ({
        name: col.name,
        statuses: (col.statuses ?? []).map((s: any) => s.id),
        min: col.min,
        max: col.max,
      }));

      const estimation = config.estimation ?? {};
      const ranking = config.ranking ?? {};
      const filterRef = config.filter ?? {};

      const result: Record<string, unknown> = {
        id: config.id,
        name: config.name,
        type: config.type,
        filter: {
          id: filterRef.id,
          name: filterRef.name,
          query: filterRef.query,
        },
        columnConfig: {
          constraintType: (config.columnConfig ?? {}).constraintType,
          columns,
        },
        estimation: {
          type: estimation.type,
          field: estimation.field ? (estimation.field.displayName ?? null) : null,
        },
        ranking: {
          rankCustomFieldId: ranking.rankCustomFieldId,
        },
      };

      if (config.subQuery && Object.keys(config.subQuery).length > 0) {
        result.subQuery = config.subQuery;
      }
      return dumps(result);
    },
  },
];
