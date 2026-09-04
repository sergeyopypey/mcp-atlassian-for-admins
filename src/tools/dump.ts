/** Bulk dump tools — aggregate entire Jira instance config into structured JSON. */

import { z } from "zod";
import { boundedAll } from "../client.js";
import { isHttpStatusError } from "../errors.js";
import { dumps } from "../json.js";
import { parseWorkflowXml } from "../lib/workflowXml.js";
import type { ToolDef } from "./types.js";
import { safe, has, filterByName, nameFilterShape, pageShape, paginate } from "./util.js";

const WORKFLOW_DUMP_PAGE = 20;
const WORKFLOW_DUMP_DETAIL_PAGE = 1;
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
    name: "dump_workflows",
    description:
      "Dump workflows with their statuses (workflow steps, with meta properties such " +
      "as jira.permission.*) and transitions (id, name, from, to). With detail=true " +
      "each transition also carries its meta, conditions, validators, and " +
      "pre/post-functions with their arguments in execution order. " +
      "Parsed from each workflow's XML descriptor via a ScriptRunner endpoint " +
      "(Jira Administrators permission — without it the call fails with an explanation); " +
      "a workflow whose XML export or parsing fails carries an `error` instead. " +
      "Paginated (offset/limit; default 20, or 1 with detail=true) and filterable by " +
      "name_contains. For one workflow, get_workflow_detail is cheaper.",
    inputShape: {
      ...nameFilterShape,
      detail: z
        .boolean()
        .default(false)
        .describe("Include transition conditions, validators, and pre/post-functions"),
      ...pageShape(`${WORKFLOW_DUMP_PAGE}, or ${WORKFLOW_DUMP_DETAIL_PAGE} with detail=true`),
    },
    async handler({ client }, args) {
      const workflows = await safe(client.listWorkflows(), [] as any[], "workflows");
      const named = workflows.map((wf: any) => ({ ...wf, name: wf.name ?? wf.id?.name }));
      const page = paginate(
        filterByName(named, args.name_contains),
        args,
        args.detail ? WORKFLOW_DUMP_DETAIL_PAGE : WORKFLOW_DUMP_PAGE,
      );

      // /rest/api/2/workflow only carries summary fields (name, description,
      // steps count, default) — statuses and transitions come from the XML.
      const items = await boundedAll(
        page.items.map((wf: any) => async () => {
          const name: string = wf.name;
          const entry: Record<string, unknown> = {
            name,
            description: wf.description ?? "",
            isDefault: has(wf, "isDefault") ? wf.isDefault : (wf.default ?? false),
          };

          let xmlStr: string | null = null;
          let exportError = "workflow XML export unavailable";
          try {
            xmlStr = await client.exportWorkflowXml(name);
          } catch (e: any) {
            // Missing permission affects every workflow — fail the whole call.
            if (isHttpStatusError(e) && (e.status === 401 || e.status === 403)) throw e;
            exportError = String(e?.message ?? e);
          }
          let parsed: ReturnType<typeof parseWorkflowXml> | null = null;
          if (xmlStr) {
            try {
              parsed = parseWorkflowXml(xmlStr);
            } catch (e) {
              console.error(`dump: workflow XML parse failed for '${name}' — ${e}`);
            }
          }
          if (!parsed) {
            entry.error = exportError;
            entry.stepCount = wf.steps ?? null;
            return entry;
          }

          const transitions = [
            ...(parsed.initialActions ?? []),
            ...parsed.steps.flatMap((s) => s.actions ?? []),
            ...(parsed.globalActions ?? []),
          ];
          entry.statuses = parsed.steps.map((s) => ({
            stepId: s.id,
            name: s.name,
            statusId: s.statusId,
            ...(s.meta && { meta: s.meta }),
          }));
          entry.transitions = args.detail
            ? transitions
            : transitions.map((t) => ({ id: t.id, name: t.name, from: t.from, to: t.to }));
          entry.statusCount = parsed.steps.length;
          entry.transitionCount = transitions.length;
          return entry;
        }),
      );
      return dumps({ ...page, items });
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
