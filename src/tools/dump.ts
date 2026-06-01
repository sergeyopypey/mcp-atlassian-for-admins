/** Bulk dump tools — aggregate entire Jira instance config into structured JSON. */

import { dumps } from "../json.js";
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
      "Dump all workflows with their statuses, transitions, conditions, validators, " +
      "and post-functions. Essential for understanding process flows.",
    inputShape: {},
    async handler({ client }) {
      const workflows = await safe(client.listWorkflows(), [] as any[], "workflows");

      const result: any[] = [];
      for (const wf of workflows) {
        const entry: Record<string, unknown> = {
          name: wf.name ?? wf.id?.name,
          description: wf.description ?? "",
          isDefault: wf.isDefault ?? false,
        };

        const statuses: any[] = wf.statuses ?? [];
        let transitions: any[] = wf.transitions ?? [];

        if (transitions.length === 0 && wf.id) {
          const wfId =
            typeof wf.id === "string" || typeof wf.id === "number"
              ? wf.id
              : (wf.id?.name ?? "");
          transitions = await safe(
            client.getWorkflowTransitions(wfId),
            [] as any[],
            `transitions(${wfId})`,
          );
        }

        entry.statuses = statuses.map((s: any) => ({
          id: s.id,
          name: s.name,
          category:
            s.statusCategory && typeof s.statusCategory === "object"
              ? (s.statusCategory.name ?? null)
              : null,
        }));
        entry.transitions = transitions.map((t: any) => ({
          id: t.id,
          name: t.name,
          from: has(t, "from")
            ? t.from
            : t.sourceStatus && typeof t.sourceStatus === "object"
              ? (t.sourceStatus.name ?? null)
              : null,
          to: has(t, "to")
            ? t.to
            : t.targetStatus && typeof t.targetStatus === "object"
              ? (t.targetStatus.name ?? null)
              : null,
          hasConditions: t.conditions != null && Object.keys(t.conditions).length > 0,
          hasValidators: t.validators != null && Object.keys(t.validators).length > 0,
          hasPostFunctions: t.postFunctions != null && Object.keys(t.postFunctions).length > 0,
          conditions: t.conditions,
          validators: t.validators,
          postFunctions: t.postFunctions,
        }));
        entry.statusCount = (entry.statuses as any[]).length;
        entry.transitionCount = (entry.transitions as any[]).length;
        result.push(entry);
      }
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
