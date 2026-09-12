/** Bulk dump tools — aggregate entire Jira instance config into structured JSON. */

import { z } from "zod";
import { dumps } from "../json.js";
import type { ToolDef } from "./types.js";
import { safe, has, filterByName, nameFilterShape, pageShape, paginate } from "./util.js";

const AUTOMATION_DUMP_PAGE = 10;

export const dumpTools: ToolDef[] = [
  {
    name: "dump_global_config",
    description:
      "Dump global Jira instance configuration: issue types, statuses, resolutions, " +
      "priorities, issue link types, server info, and system/custom field counts. " +
      "Fields themselves are not listed here — use list_fields. " +
      "Use this first to understand the Jira instance's building blocks.",
    inputShape: {},
    async handler({ client }) {
      const [serverInfo, fields, issueTypes, statuses, resolutions, priorities, linkTypes] =
        await Promise.all([
          safe(client.serverInfo(), {} as any, "serverInfo"),
          safe(client.listFields(), [] as any[], "fields"),
          safe(client.listIssueTypes(), [] as any[], "issueTypes"),
          safe(client.listStatuses(), [] as any[], "statuses"),
          safe(client.listResolutions(), [] as any[], "resolutions"),
          safe(client.listPriorities(), [] as any[], "priorities"),
          safe(client.listIssueLinkTypes(), [] as any[], "linkTypes"),
        ]);

      const result = {
        serverInfo: {
          version: serverInfo.version,
          deploymentType: serverInfo.deploymentType,
          baseUrl: serverInfo.baseUrl,
        },
        issueTypes: issueTypes.map((it: any) => ({
          id: it.id,
          name: it.name,
          subtask: it.subtask ?? false,
          description: it.description ?? "",
        })),
        statuses: statuses.map((s: any) => ({
          id: s.id,
          name: s.name,
          category: s.statusCategory?.name ?? null,
        })),
        resolutions: resolutions.map((r: any) => ({ id: r.id, name: r.name })),
        priorities: priorities.map((p: any) => ({ id: p.id, name: p.name })),
        issueLinkTypes: linkTypes.map((lt: any) => ({
          id: lt.id,
          name: lt.name,
          inward: lt.inward,
          outward: lt.outward,
        })),
        fieldCount: {
          system: fields.filter((f: any) => !(f.custom ?? false)).length,
          custom: fields.filter((f: any) => f.custom ?? false).length,
        },
      };
      return dumps(result);
    },
  },

  {
    name: "dump_automation_rules",
    description:
      "Dump Automation for Jira (A4J) rules from the in-memory cache with their full " +
      "triggers, conditions, actions, and state. Rules can be large, so this is paginated " +
      "(offset/limit, default 10) and filterable by project_key and name_contains; use " +
      "list_automation_rules for a compact overview of all rules. " +
      "Cache is refreshed every 10 minutes.",
    inputShape: {
      project_key: z
        .string()
        .optional()
        .describe("Only rules scoped to or referencing this project key"),
      ...nameFilterShape,
      ...pageShape(AUTOMATION_DUMP_PAGE),
    },
    async handler({ cache }, args) {
      const rules = args.project_key
        ? await cache.getRulesForProject(args.project_key)
        : await cache.getAllRules();
      const page = paginate(filterByName(rules, args.name_contains), args, AUTOMATION_DUMP_PAGE);
      const items = page.items.map((r: any) => ({
        id: r.id,
        name: r.name,
        state: has(r, "state") ? r.state : r.enabled,
        trigger: r.trigger,
        conditions: r.conditions,
        actions: r.actions?.length ? r.actions : r.components,
        created: r.created,
        updated: r.updated,
      }));
      return dumps({ ...page, items });
    },
  },
];
