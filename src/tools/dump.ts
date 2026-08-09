/** Bulk dump tools — aggregate entire Jira instance config into structured JSON. */

import { boundedAll } from "../client.js";
import { dumps } from "../json.js";
import { parseWorkflowXml } from "../lib/workflowXml.js";
import type { ToolDef } from "./types.js";
import { safe, has } from "./util.js";

function compactField(f: any): Record<string, unknown> {
  return {
    id: f.id,
    name: f.name,
    custom: f.custom ?? false,
    type: f.schema ? (f.schema.type ?? null) : null,
    customType: f.schema ? (f.schema.custom ?? null) : null,
  };
}

export const dumpTools: ToolDef[] = [
  {
    name: "dump_global_config",
    description:
      "Dump global Jira instance configuration: all fields (system + custom), " +
      "issue types, statuses, resolutions, priorities, issue link types, server info. " +
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
        fields: {
          system: fields.filter((f: any) => !(f.custom ?? false)).map(compactField),
          custom: fields.filter((f: any) => f.custom ?? false).map(compactField),
        },
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
      "Dump all workflows with their statuses (workflow steps) and transitions, " +
      "including conditions, validators, and pre/post-functions with their arguments. " +
      "Parsed from each workflow's XML descriptor via a ScriptRunner endpoint; a workflow " +
      "whose export fails carries an `error` instead. Essential for understanding process flows.",
    inputShape: {},
    async handler({ client }) {
      const workflows = await safe(client.listWorkflows(), [] as any[], "workflows");

      // /rest/api/2/workflow only carries summary fields (name, description,
      // steps count, default) — statuses and transitions come from the XML.
      const result = await boundedAll(
        workflows.map((wf: any) => async () => {
          const name: string = wf.name ?? wf.id?.name;
          const entry: Record<string, unknown> = {
            name,
            description: wf.description ?? "",
            isDefault: has(wf, "isDefault") ? wf.isDefault : (wf.default ?? false),
          };

          const xmlStr = await client.exportWorkflowXml(name);
          let parsed: ReturnType<typeof parseWorkflowXml> | null = null;
          if (xmlStr) {
            try {
              parsed = parseWorkflowXml(xmlStr);
            } catch (e) {
              console.error(`dump: workflow XML parse failed for '${name}' — ${e}`);
            }
          }
          if (!parsed) {
            entry.error = "workflow XML export unavailable";
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
          }));
          entry.transitions = transitions;
          entry.statusCount = parsed.steps.length;
          entry.transitionCount = transitions.length;
          return entry;
        }),
      );
      return dumps(result);
    },
  },

  {
    name: "dump_automation_rules",
    description:
      "Dump all Automation for Jira (A4J) rules from the in-memory cache. " +
      "Includes triggers, conditions, actions, state, and execution counts. " +
      "Cache is refreshed every 10 minutes.",
    inputShape: {},
    async handler({ cache }) {
      const allRules = await cache.getAllRules();
      const result = allRules.map((r: any) => ({
        id: r.id,
        name: r.name,
        state: has(r, "state") ? r.state : r.enabled,
        trigger: r.trigger,
        conditions: r.conditions,
        actions: r.actions?.length ? r.actions : r.components,
        created: r.created,
        updated: r.updated,
      }));
      return dumps(result);
    },
  },
];
