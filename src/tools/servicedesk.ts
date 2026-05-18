/** JSM Service Desk introspection tools. */

import { z } from "zod";
import { dumps } from "../json.js";
import type { ToolDef } from "./types.js";

export const serviceDeskTools: ToolDef[] = [
  {
    name: "list_service_desks",
    description: "List all JSM service desks with project associations.",
    inputShape: {},
    async handler({ client }) {
      const desks = await client.listJsmServiceDesks();
      return dumps(
        desks.map((d: any) => ({
          id: d.id,
          projectId: d.projectId,
          projectKey: d.projectKey,
          projectName: d.projectName,
        })),
      );
    },
  },

  {
    name: "get_service_desk_queues",
    description:
      "Get queues for a JSM service desk — how requests are triaged and routed. " +
      "Shows queue names, backing JQL, and issue counts.",
    inputShape: {
      service_desk_id: z
        .coerce.number()
        .int()
        .describe("Service desk ID (from list_service_desks)"),
    },
    async handler({ client }, args) {
      const queues = await client.getServiceDeskQueues(args.service_desk_id);
      return dumps(
        queues.map((q: any) => ({
          id: q.id,
          name: q.name,
          jql: q.jql,
          issueCount: q.issueCount,
        })),
      );
    },
  },
];
