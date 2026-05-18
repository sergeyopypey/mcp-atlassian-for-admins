/** Field and field configuration tools. */

import { z } from "zod";
import { boundedAll } from "../client.js";
import { dumps } from "../json.js";
import type { ToolDef } from "./types.js";

/**
 * Format an epoch-milliseconds timestamp the way Python's
 * `datetime.fromtimestamp(ms/1000, tz=utc).isoformat()` does:
 * `YYYY-MM-DDTHH:MM:SS[.ffffff]+00:00` (6-digit microseconds, omitted when 0).
 */
export function pythonIsoUtc(epochMs: number): string {
  const d = new Date(epochMs);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const base =
    `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  const micros = d.getUTCMilliseconds() * 1000;
  const frac = micros === 0 ? "" : `.${p(micros, 6)}`;
  return `${base}${frac}+00:00`;
}

export const fieldTools: ToolDef[] = [
  {
    name: "list_fields",
    description:
      "List all fields (system + custom) with types, search clause names. " +
      "Set custom_only=true to see only custom fields. " +
      "Pass field_ids to look up specific fields by ID.",
    inputShape: {
      custom_only: z.boolean().default(false).describe("Only show custom fields"),
      field_ids: z
        .array(z.string())
        .optional()
        .describe(
          "List of specific field IDs to look up (e.g. ['customfield_12808', 'summary']). " +
            "When provided, returns only these fields.",
        ),
    },
    async handler({ client }, args) {
      let fields = await client.listFields();
      if (args.field_ids && args.field_ids.length > 0) {
        const idSet = new Set<string>(args.field_ids);
        fields = fields.filter((f: any) => idSet.has(f.id));
      } else if (args.custom_only) {
        fields = fields.filter((f: any) => f.custom ?? false);
      }
      return dumps(
        fields.map((f: any) => ({
          id: f.id,
          name: f.name,
          custom: f.custom ?? false,
          type: f.schema ? (f.schema.type ?? null) : null,
          customType: f.schema ? (f.schema.custom ?? null) : null,
          searchable: f.searchable,
          clauseNames: f.clauseNames ?? [],
        })),
      );
    },
  },

  {
    name: "list_custom_fields_usage",
    description:
      "List custom fields with usage stats from Jira DC 10's /customFields endpoint: " +
      "issuesWithValue (issue count), projectsCount/keys, screensCount, lastValueUpdate. " +
      "Filters: search (substring on name), unused_only (issuesWithValue=0), " +
      "project_key (limits to fields scoped to that project), min_issues (>= N issues). " +
      "Sorted by issue count desc. Useful for auditing dead custom fields.",
    inputShape: {
      search: z.string().optional().describe("Case-insensitive substring filter on field name"),
      unused_only: z
        .boolean()
        .default(false)
        .describe("Only fields with zero issues using them"),
      project_key: z
        .string()
        .optional()
        .describe(
          "Project key (e.g. FINJ) — limits to fields scoped to that project or isAllProjects=true",
        ),
      min_issues: z
        .coerce.number()
        .int()
        .optional()
        .describe("Only fields with issuesWithValue >= this"),
    },
    async handler({ client }, args) {
      const raw = await client.listCustomFieldsUsage();
      const values: any[] = raw.values ?? [];

      const projects = await client.listProjects();
      const projMap = new Map<number, string>();
      for (const p of projects) projMap.set(Number(p.id), p.key);

      let targetPid: number | null = null;
      if (args.project_key) {
        targetPid = null;
        for (const [pid, k] of projMap) {
          if (k === args.project_key) {
            targetPid = pid;
            break;
          }
        }
        if (targetPid === null) {
          return dumps({ error: `Unknown project_key: ${args.project_key}` });
        }
      }

      const s = args.search ? String(args.search).toLowerCase() : null;
      const result: any[] = [];
      for (const f of values) {
        if (s && !(f.name ?? "").toLowerCase().includes(s)) continue;
        if (args.unused_only && (f.issuesWithValue ?? 0) !== 0) continue;
        if (args.min_issues !== undefined && args.min_issues !== null && (f.issuesWithValue ?? 0) < args.min_issues) {
          continue;
        }
        if (
          targetPid !== null &&
          !f.isAllProjects &&
          !(f.projectIds ?? []).includes(targetPid)
        ) {
          continue;
        }

        const lvu = f.lastValueUpdate;
        result.push({
          id: f.id,
          name: f.name,
          type: f.type,
          searcherKey: f.searcherKey,
          projectsCount: f.projectsCount,
          projectKeys: (f.projectIds ?? []).map((pid: number) => projMap.get(pid) ?? `#${pid}`),
          isAllProjects: f.isAllProjects ?? false,
          screensCount: f.screensCount,
          issuesWithValue: f.issuesWithValue,
          lastValueUpdate: lvu ? pythonIsoUtc(lvu) : null,
          lastValueUpdateEpoch: lvu,
        });
      }

      result.sort((a, b) => (b.issuesWithValue || 0) - (a.issuesWithValue || 0));

      return dumps({ total: raw.total, returned: result.length, fields: result });
    },
  },

  {
    name: "get_field_configuration",
    description:
      "Get field configuration items — shows which fields are required, hidden, " +
      "their renderer and description. The 'rules' for fields.",
    inputShape: { fc_id: z.coerce.number().int().describe("Field configuration ID") },
    async handler({ client }, args) {
      const fcList = await client.listFieldConfigurations();
      const fc = fcList.find((c: any) => c.id === args.fc_id);
      if (fc === undefined) {
        return dumps({ error: `Field configuration ${args.fc_id} not found` });
      }
      return dumps({
        fieldConfigurationId: fc.id,
        name: fc.name,
        description: fc.description ?? "",
        isDefault: fc.isDefault ?? false,
        fields: (fc.fields ?? []).map((item: any) => ({
          fieldId: item.fieldId,
          fieldName: item.fieldName,
          description: item.description ?? "",
          isRequired: item.isRequired ?? false,
          isHidden: item.isHidden ?? false,
          renderer: item.rendererType,
        })),
      });
    },
  },

  {
    name: "get_field_configuration_scheme",
    description:
      "Get field configuration scheme — maps issue types to field configurations.",
    inputShape: {
      scheme_id: z.coerce.number().int().describe("Field configuration scheme ID"),
    },
    async handler({ client }, args) {
      const schemes = await client.listFieldConfigurationSchemes();
      const scheme = schemes.find((s: any) => s.id === args.scheme_id);
      if (scheme === undefined) {
        return dumps({ error: `Field configuration scheme ${args.scheme_id} not found` });
      }
      return dumps({
        id: scheme.id,
        name: scheme.name,
        description: scheme.description ?? "",
        mappings: (scheme.mappings ?? []).map((m: any) => ({
          issueTypeId: m.issueTypeId,
          issueTypeName: m.issueTypeName,
          fieldConfigurationId: m.fieldConfigId,
          fieldConfigurationName: m.fieldConfigName,
        })),
        projects: scheme.projects ?? [],
      });
    },
  },

  {
    name: "find_field_usage",
    description:
      "Find where a field appears across ALL screens. " +
      "Use to understand impact before modifying a field.",
    inputShape: {
      field_id: z.string().describe("Field ID (e.g. 'customfield_10001' or 'summary')"),
    },
    async handler({ client }, args) {
      const fieldId = args.field_id;
      const screens = await client.listScreens();

      const scanScreen = async (scr: any): Promise<any[]> => {
        const hits: any[] = [];
        let full: any;
        try {
          full = await client.getScreenFull(scr.id);
        } catch {
          return hits;
        }
        for (const tab of full.tabs ?? []) {
          for (const f of tab.fields ?? []) {
            if (f.id === fieldId) {
              hits.push({
                screenId: scr.id,
                screenName: scr.name,
                tabId: tab.id,
                tabName: tab.name,
              });
            }
          }
        }
        return hits;
      };

      const perScreen = await boundedAll(screens.map((scr: any) => () => scanScreen(scr)));
      const screenHits = perScreen.flat();

      const fcList = await client.listFieldConfigurations();
      const fcHits: any[] = [];
      for (const fc of fcList) {
        for (const item of fc.fields ?? []) {
          if (item.fieldId === fieldId) {
            fcHits.push({
              fieldConfigId: fc.id,
              fieldConfigName: fc.name,
              isRequired: item.isRequired ?? false,
              isHidden: item.isHidden ?? false,
            });
          }
        }
      }

      return dumps({
        fieldId,
        screens: screenHits,
        fieldConfigurations: fcHits,
        totalScreens: screenHits.length,
        totalFieldConfigs: fcHits.length,
      });
    },
  },

  {
    name: "get_createmeta_fields",
    description:
      "Get fields available on the CREATE screen for a project + issue type. " +
      "Shows field name, required flag, allowed values (for select/radio/checkbox fields), " +
      "and default values. Use to discover what values an automation rule must set.",
    inputShape: {
      project_key: z.string().describe("Jira project key (e.g. 'CL')"),
      issue_type_id: z.string().describe("Issue type ID (e.g. '13602')"),
    },
    async handler({ client }, args) {
      const raw = await client.getCreatemetaFields(args.project_key, args.issue_type_id);
      const result: any[] = [];
      for (const f of raw) {
        const entry: Record<string, unknown> = {
          fieldId: f.fieldId,
          name: f.name,
          required: f.required ?? false,
          schema: f.schema,
          hasDefaultValue: f.hasDefaultValue ?? false,
        };
        if (f.allowedValues && f.allowedValues.length > 0) {
          entry.allowedValues = f.allowedValues.map((v: any) => ({
            id: v.id,
            value: v.value || v.name,
            disabled: v.disabled ?? false,
          }));
        }
        if (f.defaultValue != null && Object.keys(f.defaultValue).length > 0) {
          entry.defaultValue = f.defaultValue;
        }
        result.push(entry);
      }
      return dumps(result);
    },
  },

  {
    name: "get_field_contexts",
    description:
      "Get custom field contexts — which projects and issue types the field is scoped to. " +
      "Uses an internal API (unsupported, may break on upgrades). " +
      "Shows allProjects/allIssueTypes flags and specific project/issue type lists.",
    inputShape: { field_id: z.string().describe("Field ID (e.g. 'customfield_10001')") },
    async handler({ client }, args) {
      const fields = await client.listCustomFieldContexts(args.field_id);
      if (fields.length === 0) {
        return dumps({ error: `No custom field context data for field ${args.field_id}` });
      }
      const entry = fields[0];
      return dumps({
        fieldId: entry.fieldId,
        fieldName: entry.fieldName,
        fieldType: entry.fieldType,
        contexts: (entry.contexts ?? []).map((ctx: any) => ({
          id: ctx.id,
          name: ctx.name ?? "",
          description: ctx.description ?? "",
          isAllProjects: ctx.isGlobalProjects ?? false,
          isAllIssueTypes: ctx.isAllIssueTypes ?? false,
          projects: ctx.projects ?? [],
          issueTypes: ctx.issueTypes ?? [],
        })),
      });
    },
  },
];
