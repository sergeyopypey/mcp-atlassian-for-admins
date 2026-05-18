/** Automation for Jira (A4J) tools — read-only, backed by the in-memory cache. */

import { z } from "zod";
import { dumps } from "../json.js";
import type { ToolDef } from "./types.js";
import { has } from "./util.js";

const AUDIT_CATEGORIES = [
  "SUCCESS",
  "SOME_ERRORS",
  "ERROR",
  "RULE_ERROR",
  "ACTIONS_DISABLED",
  "NO_ACTIONS_PERFORMED",
] as const;

function extractTriggerType(rule: any): string | null {
  const trigger = rule.trigger;
  if (trigger && typeof trigger === "object" && !Array.isArray(trigger)) {
    return trigger.type || trigger.component || null;
  }
  if (Array.isArray(trigger) && trigger.length > 0) {
    return trigger[0].type || trigger[0].component || null;
  }
  return null;
}

function auditItems(data: any): any[] {
  if (data && typeof data === "object" && !Array.isArray(data)) return data.items ?? [];
  return data;
}

export const automationTools: ToolDef[] = [
  {
    name: "list_automation_rules",
    description:
      "List A4J automation rules from the in-memory cache. " +
      "Optionally filter by project_key. " +
      "Shows name, state, trigger type, execution count. " +
      "Cache is refreshed every 10 minutes.",
    inputShape: {
      project_key: z
        .string()
        .optional()
        .describe("Optional project key to filter rules. Omit for all rules."),
    },
    async handler({ cache }, args) {
      const rules = args.project_key
        ? await cache.getRulesForProject(args.project_key)
        : await cache.getAllRules();
      return dumps(
        rules.map((r: any) => ({
          id: r.id,
          name: r.name,
          state: has(r, "state") ? r.state : r.enabled ? "ENABLED" : "DISABLED",
          triggerType: extractTriggerType(r),
          created: r.created,
          updated: r.updated,
          executionCount: r.executionCount,
        })),
      );
    },
  },

  {
    name: "get_automation_rule_detail",
    description:
      "Get full automation rule detail from cache: trigger, conditions, actions, smart values.",
    inputShape: { rule_id: z.coerce.number().int().describe("Automation rule ID") },
    async handler({ cache }, args) {
      const rule = await cache.getRuleById(args.rule_id);
      if (rule === null) {
        return dumps({ error: `Rule ${args.rule_id} not found in cache` });
      }
      return dumps(rule);
    },
  },

  {
    name: "get_automation_audit_log",
    description:
      "Get the global A4J automation audit log — recent executions across all rules. " +
      "Shows rule name, execution state (SUCCESS/ERROR), trigger issue, and timing. " +
      "Use to debug why an automation did or did not fire.",
    inputShape: {
      limit: z.coerce.number().int().optional().describe("Number of results to return (default 50)"),
      offset: z.coerce.number().int().optional().describe("Offset for pagination (default 0)"),
      categories: z
        .array(z.enum(AUDIT_CATEGORIES))
        .optional()
        .describe("Filter by execution categories. Omit for all."),
      date_from: z.string().optional().describe("Start date filter (YYYY-MM-DD)"),
      date_to: z.string().optional().describe("End date filter (YYYY-MM-DD)"),
    },
    async handler({ client, cache }, args) {
      const data = await client.getAutomationAuditLog({
        limit: args.limit ?? 50,
        offset: args.offset ?? 0,
        categories: args.categories,
        dateFrom: args.date_from,
        dateTo: args.date_to,
      });
      const items = auditItems(data);
      const rules = await cache.getAllRules();
      const ruleNames = new Map<unknown, unknown>();
      for (const r of rules) ruleNames.set(r.id, r.name);

      const entries = items.map((entry: any) => {
        const obj = entry.objectItem ?? {};
        const ruleId = obj.id;
        return {
          id: entry.id,
          ruleId,
          ruleName: ruleNames.has(ruleId) ? ruleNames.get(ruleId) : obj.name,
          category: entry.category,
          eventSource: entry.eventSource,
          created: entry.created,
          startExecution: entry.startExecution,
          endExecution: entry.endExecution,
          duration: entry.duration,
          authorKey: entry.authorKey,
          messages: entry.globalMessages?.length ? entry.globalMessages : null,
        };
      });
      return dumps(entries);
    },
  },

  {
    name: "get_automation_rule_audit_log",
    description:
      "Get execution history for a specific A4J automation rule. " +
      "Shows each execution with state (SUCCESS/ERROR), trigger issue, " +
      "duration, and error messages. Essential for debugging rule failures.",
    inputShape: {
      rule_id: z.coerce.number().int().describe("Automation rule ID"),
      limit: z.coerce.number().int().optional().describe("Number of results to return (default 50)"),
      offset: z.coerce.number().int().optional().describe("Offset for pagination (default 0)"),
      categories: z
        .array(z.enum(AUDIT_CATEGORIES))
        .optional()
        .describe("Filter by execution categories. Omit for all."),
      date_from: z.string().optional().describe("Start date filter (YYYY-MM-DD)"),
      date_to: z.string().optional().describe("End date filter (YYYY-MM-DD)"),
    },
    async handler({ client, cache }, args) {
      const data = await client.getAutomationAuditLog({
        limit: args.limit ?? 50,
        offset: args.offset ?? 0,
        categories: args.categories,
        dateFrom: args.date_from,
        dateTo: args.date_to,
        ruleId: args.rule_id,
      });
      const items = auditItems(data);
      const rule = await cache.getRuleById(args.rule_id);
      const ruleName = rule ? rule.name : null;

      const entries = items.map((entry: any) => ({
        id: entry.id,
        ruleId: args.rule_id,
        ruleName,
        category: entry.category,
        eventSource: entry.eventSource,
        created: entry.created,
        startExecution: entry.startExecution,
        endExecution: entry.endExecution,
        duration: entry.duration,
        authorKey: entry.authorKey,
        messages: entry.globalMessages?.length ? entry.globalMessages : null,
      }));
      return dumps(entries);
    },
  },

  {
    name: "get_automation_audit_item",
    description:
      "Get detailed info for a single A4J audit log entry. " +
      "Returns component-level execution results, error messages, " +
      "and the trigger issue. Use after finding an entry in the audit log " +
      "to see exactly what went wrong or what actions were performed.",
    inputShape: {
      item_id: z
        .coerce.number()
        .int()
        .describe(
          "Audit log entry ID (from get_automation_audit_log or get_automation_rule_audit_log)",
        ),
    },
    async handler({ client }, args) {
      return dumps(await client.getAutomationAuditItem(args.item_id));
    },
  },

  {
    name: "refresh_automation_cache",
    description:
      "Force an immediate refresh of the automation rules cache. " +
      "Use this if the cache appears empty or stale.",
    inputShape: {},
    async handler({ cache }) {
      const count = await cache.refresh();
      // Python emits this one compact (json.dumps without indent).
      return JSON.stringify({ status: "refreshed", rules_loaded: count });
    },
  },
];
