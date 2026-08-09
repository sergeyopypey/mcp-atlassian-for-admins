/** Workflow introspection tools. */

import { z } from "zod";
import { dumps } from "../json.js";
import { parseWorkflowXml } from "../lib/workflowXml.js";
import type { ToolDef } from "./types.js";
import { has } from "./util.js";

// Patterns that indicate a workflow is a backup or copy (case-insensitive).
const INACTIVE_PATTERNS =
  /(?:^copy (?:\d+ )?of |[\s(]\bcopy\b[\s)]|[\s(]\bcopy\s*\d*\b[\s)]|\bbackup\b|\bBACKUP\b|\bold\b[\s)_-]|\bdeprecated\b|\barchived?\b|\bdraft\b|\btest\b|\btemp\b|\bDO NOT USE\b|\bdo not use\b|\bv\d+\s*[-–]\s*old\b)/i;

function buildWorkflowEntry(wf: any): Record<string, unknown> {
  const name =
    wf.name ||
    (typeof wf.id === "object" && wf.id !== null ? wf.id.name : wf.id);
  return {
    name,
    description: wf.description ?? "",
    isDefault: has(wf, "isDefault")
      ? wf.isDefault
      : has(wf, "default")
        ? wf.default
        : false,
    // /rest/api/2/workflow reports only the step (status) count; transition
    // counts need the full descriptor — see dump_workflows / get_workflow_detail.
    statusCount: typeof wf.steps === "number" ? wf.steps : null,
  };
}

function extractStatusRef(t: any, key1: string, key2: string): any {
  const val = t[key1];
  if (val && typeof val === "object") return val.name || val.id;
  if (val) return val;
  const alt = t[key2];
  if (alt && typeof alt === "object") return alt.name || alt.id;
  return alt;
}

export const workflowTools: ToolDef[] = [
  {
    name: "list_active_workflows",
    description:
      "List active workflows (excludes backups, copies, deprecated). " +
      "Shows name, status count, and whether each workflow is in use by a scheme. " +
      "Use this by default; use list_all_workflows only when you need the full unfiltered list.",
    inputShape: {},
    async handler({ client }) {
      const workflows = await client.listWorkflows();

      const inUseNames = new Set<string>();
      try {
        const schemes = await client.listWorkflowSchemes();
        for (const scheme of schemes) {
          const defaultWf = scheme.defaultWorkflow;
          if (defaultWf) inUseNames.add(defaultWf);
          for (const wfName of Object.values(scheme.issueTypeMappings ?? {})) {
            inUseNames.add(wfName as string);
          }
        }
      } catch {
        // If scheme fetch fails, skip in-use detection.
      }

      const result: Record<string, unknown>[] = [];
      for (const wf of workflows) {
        const entry = buildWorkflowEntry(wf);
        const name = (entry.name as string) || "";
        if (INACTIVE_PATTERNS.test(name)) continue;
        if (inUseNames.size > 0) entry.inUse = inUseNames.has(name);
        result.push(entry);
      }
      return dumps(result);
    },
  },

  {
    name: "list_all_workflows",
    description:
      "List ALL workflows including backups, copies, and deprecated ones. " +
      "Prefer list_active_workflows for most use cases.",
    inputShape: {},
    async handler({ client }) {
      const workflows = await client.listWorkflows();
      return dumps(workflows.map(buildWorkflowEntry));
    },
  },

  {
    name: "get_workflow_detail",
    description:
      "Get full workflow detail by name: all statuses, transitions with conditions, " +
      "validators, post-functions, and properties. Use for deep process analysis.",
    inputShape: { workflow_name: z.string().describe("Exact workflow name") },
    async handler({ client }, args) {
      const workflowName = args.workflow_name;

      // Try the ScriptRunner XML export first (richest detail).
      const xmlStr = await client.exportWorkflowXml(workflowName);
      if (xmlStr) {
        try {
          const parsed: Record<string, unknown> = parseWorkflowXml(xmlStr);
          parsed.name = workflowName;
          parsed.source = "scriptrunner-xml";
          return dumps(parsed);
        } catch (e) {
          console.error(`Failed to parse workflow XML for '${workflowName}': ${e}`);
        }
      }

      // Fallback to the REST API.
      const wf = await client.getWorkflowByName(workflowName);
      if (!wf) return dumps({ error: `Workflow '${workflowName}' not found` });

      const statuses: any[] = wf.statuses ?? [];
      let transitions: any[] = wf.transitions ?? [];

      if (transitions.length === 0 && wf.id) {
        const wfId =
          typeof wf.id === "string" || typeof wf.id === "number"
            ? wf.id
            : (wf.id?.name ?? "");
        try {
          transitions = await client.getWorkflowTransitions(wfId);
        } catch {
          // ignore
        }
      }

      return dumps({
        name: workflowName,
        description: wf.description ?? "",
        isDefault: wf.isDefault ?? false,
        source: "rest-api",
        statuses: statuses.map((s: any) => ({
          id: s.id,
          name: s.name,
          category:
            s.statusCategory && typeof s.statusCategory === "object"
              ? (s.statusCategory.name ?? null)
              : null,
        })),
        transitions: transitions.map((t: any) => ({
          id: t.id,
          name: t.name,
          from: extractStatusRef(t, "from", "sourceStatus"),
          to: extractStatusRef(t, "to", "targetStatus"),
          conditions: t.conditions,
          validators: t.validators,
          postFunctions: t.postFunctions,
          properties: t.properties,
        })),
      });
    },
  },

  {
    name: "get_workflow_statuses_and_transitions",
    description:
      "Get full workflow statuses, transitions with screens and fields via the Workflow Designer API. " +
      "For each transition shows: source/target status, transition screen (with tabs and field details), " +
      "and rule counts (conditions, validators, post-functions). " +
      "Also detects JSM approval patterns (Waiting for approval → Approved/Declined). " +
      "Use this for detailed process analysis including what data is captured at each step.",
    inputShape: { workflow_name: z.string().describe("Exact workflow name") },
    async handler({ client }, args) {
      const workflowName = args.workflow_name;
      const designer = await client.getWorkflowDesigner(workflowName);
      if (!designer) {
        return dumps({
          error: `Workflow '${workflowName}' not found or workflowDesigner plugin unavailable`,
        });
      }

      const layout = designer.layout ?? {};
      const rawStatuses: any[] = layout.statuses ?? [];
      const rawTransitions: any[] = layout.transitions ?? [];

      // internal id → status info.
      const idMap = new Map<any, { name: string; statusId: any; initial: boolean }>();
      for (const s of rawStatuses) {
        idMap.set(s.id, {
          name: s.name ?? "?",
          statusId: s.statusId,
          initial: s.initial ?? false,
        });
      }

      // Resolve status categories.
      const statusIds = rawStatuses.filter((s) => s.statusId).map((s) => String(s.statusId));
      const statusCategoryMap = new Map<string, string | null>();
      if (statusIds.length > 0) {
        try {
          const allStatuses = await client.listStatuses();
          for (const st of allStatuses) {
            const cat =
              st.statusCategory && typeof st.statusCategory === "object"
                ? (st.statusCategory.name ?? null)
                : null;
            statusCategoryMap.set(String(st.id), cat);
          }
        } catch {
          // ignore
        }
      }

      const statusesOut: any[] = [];
      for (const s of rawStatuses) {
        if (s.initial && !s.statusId) continue; // skip the virtual "Create" node
        const statusId = s.statusId;
        statusesOut.push({
          name: s.name,
          statusId,
          category: statusId ? (statusCategoryMap.get(String(statusId)) ?? null) : null,
          initial: s.initial ?? false,
        });
      }

      // Collect screen IDs and names referenced by transitions.
      const screenIds = new Set<number>();
      for (const t of rawTransitions) {
        if (t.screenId) screenIds.add(Number(t.screenId));
      }
      const screenNameMap = new Map<number, string>();
      for (const t of rawTransitions) {
        if (t.screenId && t.screenName) screenNameMap.set(Number(t.screenId), t.screenName);
      }

      // Batch-fetch screen details.
      const screenDetails = new Map<number, any>();
      for (const scrId of screenIds) {
        try {
          const full = await client.getScreenFull(scrId);
          const tabs = (full.tabs ?? []).map((tab: any) => ({
            name: tab.name,
            fields: (tab.fields ?? []).map((f: any) => ({ id: f.id, name: f.name })),
          }));
          screenDetails.set(scrId, {
            name: screenNameMap.get(scrId) ?? `Screen ${scrId}`,
            tabs,
          });
        } catch (e) {
          console.error(`Failed to fetch screen ${scrId}: ${e}`);
        }
      }

      // Detect JSM approval pattern.
      const approvalStatuses = new Set<any>();
      const approvalTransitions = new Map<any, string>();
      for (const s of rawStatuses) {
        const nameLower = (s.name ?? "").toLowerCase();
        if (nameLower.includes("approv") || nameLower.includes("waiting for approval")) {
          approvalStatuses.add(s.id);
        }
      }
      for (const t of rawTransitions) {
        if (approvalStatuses.has(t.sourceId)) {
          const nameLower = (t.name ?? "").toLowerCase();
          if (
            nameLower.includes("approv") ||
            nameLower.includes("declin") ||
            nameLower.includes("reject")
          ) {
            approvalTransitions.set(t.id, t.name);
          }
        }
      }

      const transitionsOut: any[] = [];
      for (const t of rawTransitions) {
        const srcInfo = idMap.get(t.sourceId) ?? {};
        const tgtInfo = idMap.get(t.targetId) ?? {};

        let conditionsCount = 0;
        let validatorsCount = 0;
        let postfunctionsCount = 0;
        for (const opt of t.transitionOptions ?? []) {
          const key = opt.key ?? "";
          if (key.includes("conditions")) conditionsCount = opt.count ?? 0;
          else if (key.includes("validators")) validatorsCount = opt.count ?? 0;
          else if (key.includes("postfunctions")) postfunctionsCount = opt.count ?? 0;
        }

        const transitionEntry: Record<string, unknown> = {
          name: t.name,
          actionId: t.actionId,
          from: has(srcInfo, "name") ? (srcInfo as any).name : t.sourceId,
          to: has(tgtInfo, "name") ? (tgtInfo as any).name : t.targetId,
          global: t.globalTransition ?? false,
          rules: {
            conditions: conditionsCount,
            validators: validatorsCount,
            postFunctions: postfunctionsCount,
          },
        };

        const scrId = t.screenId;
        if (scrId && screenDetails.has(Number(scrId))) {
          transitionEntry.screen = screenDetails.get(Number(scrId));
        } else if (t.screenName) {
          transitionEntry.screen = { name: t.screenName, id: scrId };
        }

        if (approvalTransitions.has(t.id)) transitionEntry.jsmApproval = true;
        transitionsOut.push(transitionEntry);
      }

      let jsmApproval: any = null;
      if (approvalStatuses.size > 0) {
        const approvalStatusNames: string[] = [];
        for (const sid of approvalStatuses) {
          if (idMap.has(sid)) approvalStatusNames.push(idMap.get(sid)!.name);
        }
        jsmApproval = {
          detected: true,
          approvalStatuses: approvalStatusNames,
          approvalTransitions: [...approvalTransitions.values()],
        };
      }

      const result: Record<string, unknown> = {
        name: workflowName,
        description: designer.description ?? "",
        statusCount: statusesOut.length,
        transitionCount: transitionsOut.length,
        statuses: statusesOut,
        transitions: transitionsOut,
      };
      if (jsmApproval) result.jsmApproval = jsmApproval;
      return dumps(result);
    },
  },

  {
    name: "list_workflow_schemes",
    description: "List all workflow schemes with default workflow and issue type mappings.",
    inputShape: {},
    async handler({ client }) {
      const schemes = await client.listWorkflowSchemes();
      return dumps(
        schemes.map((s: any) => ({
          id: s.id,
          name: s.name,
          description: s.description ?? "",
          defaultWorkflow: s.defaultWorkflow,
          issueTypeMappings: s.issueTypeMappings ?? {},
        })),
      );
    },
  },

  {
    name: "get_workflow_scheme",
    description:
      "Get a specific workflow scheme by ID with full issue-type-to-workflow mappings.",
    inputShape: { scheme_id: z.coerce.number().int().describe("Workflow scheme ID") },
    async handler({ client }, args) {
      const scheme = await client.getWorkflowScheme(args.scheme_id);
      const mappings = scheme.issueTypeMappings ?? {};
      const allIssueTypes = scheme.issueTypes ?? {};
      if (Object.keys(mappings).length > 0 && Object.keys(allIssueTypes).length > 0) {
        const filtered: Record<string, unknown> = {};
        for (const [tid, info] of Object.entries(allIssueTypes)) {
          if (tid in mappings) filtered[tid] = info;
        }
        scheme.issueTypes = filtered;
      }
      return dumps(scheme);
    },
  },

  {
    name: "get_workflow_transition_details",
    description:
      "Full transition rule configuration for a workflow — post-function parameters, " +
      "condition arguments, validator arguments (the actual config, not just class " +
      "names). Backed by a ScriptRunner endpoint.",
    inputShape: {
      workflow_name: z.string().describe("Exact workflow name"),
      transition_id: z.coerce.number().int().optional().describe("Optional: filter to one transition"),
    },
    async handler({ client }, args) {
      const data = await client.getWorkflowTransitionDetails(
        args.workflow_name,
        args.transition_id ?? null,
      );
      return dumps(data);
    },
  },
];
