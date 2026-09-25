/** Workflow introspection tools. */

import { z } from "zod";
import { boundedAll } from "../client.js";
import { isHttpStatusError } from "../errors.js";
import { dumps, exceedsResponseLimit, MAX_RESPONSE_CHARS } from "../json.js";
import {
  parseWorkflowXml,
  type ActionEntry,
  type ConditionBlock,
  type FunctionEntry,
  type ParsedWorkflow,
} from "../lib/workflowXml.js";
import type { ToolDef } from "./types.js";
import { filterByName, has, nameFilterShape, safeList } from "./util.js";

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
    // counts need the full descriptor — see get_workflow.
    statusCount: typeof wf.steps === "number" ? wf.steps : null,
  };
}

type Transition = Omit<ActionEntry, "from"> & { from: string[] };

/**
 * Every transition once, in document order. Common and global transitions are
 * listed under each step they leave from; merge them by id and collect the
 * source statuses — "(initial)" for the create transition, "(global)" for a
 * transition available from any status.
 */
function uniqueTransitions(parsed: ParsedWorkflow): Transition[] {
  const byId = new Map<number, Transition>();
  const all = [
    ...(parsed.initialActions ?? []),
    ...parsed.steps.flatMap((s) => s.actions ?? []),
    ...(parsed.globalActions ?? []),
  ];
  for (const t of all) {
    const seen = byId.get(t.id);
    if (seen) {
      if (!seen.from.includes(t.from)) seen.from.push(t.from);
    } else {
      byId.set(t.id, { ...t, from: [t.from] });
    }
  }
  return [...byId.values()];
}

/** Leaf conditions of a condition tree, depth first. */
function conditionLeaves(block: ConditionBlock | undefined): FunctionEntry[] {
  if (!block) return [];
  if ("items" in block) return block.items.flatMap((b) => conditionLeaves(b));
  return [block];
}

/** Non-zero rule counts of a transition. */
function ruleCounts(t: Transition): Record<string, number> {
  const counts: Record<string, number> = {
    conditions: conditionLeaves(t.conditions).length,
    validators: t.validators?.length ?? 0,
    preFunctions: t.preFunctions?.length ?? 0,
    postFunctions: t.postFunctions?.length ?? 0,
  };
  return Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0));
}

/** Split a meta map into its `jira.description` and the remaining keys. */
function splitDescription(meta: Record<string, string> | undefined): {
  description?: string;
  meta?: Record<string, string>;
} {
  if (!meta) return {};
  const { "jira.description": description, ...rest } = meta;
  return {
    ...(description ? { description } : {}),
    ...(Object.keys(rest).length > 0 ? { meta: rest } : {}),
  };
}

type FieldMatch = { field: string; snippet: string };

/** Excerpt of `value` around the first case-insensitive `needle`; short values are returned whole. */
function snippet(value: string, needle: string, radius = 80): string {
  if (value.length <= 2 * radius + needle.length) return value;
  const at = Math.max(0, value.toLowerCase().indexOf(needle));
  const start = Math.max(0, at - radius);
  const end = Math.min(value.length, at + needle.length + radius);
  return (start > 0 ? "…" : "") + value.slice(start, end) + (end < value.length ? "…" : "");
}

/** Fields of a rule (type, class, args) that contain `needle`, with excerpts. */
function matchRule(rule: FunctionEntry, needle: string): FieldMatch[] {
  const fields: Array<[string, string]> = [["type", rule.type]];
  if (rule.className) fields.push(["className", rule.className]);
  for (const [k, v] of Object.entries(rule.args ?? {})) fields.push([`args.${k}`, v]);
  return fields
    .filter(([, v]) => v.toLowerCase().includes(needle))
    .map(([field, v]) => ({ field, snippet: snippet(v, needle) }));
}

/** Meta entries whose key or value contains `needle`. */
function matchMeta(meta: Record<string, string> | undefined, needle: string): FieldMatch[] {
  return Object.entries(meta ?? {})
    .filter(([k, v]) => k.toLowerCase().includes(needle) || v.toLowerCase().includes(needle))
    .map(([k, v]) => ({ field: `meta.${k}`, snippet: snippet(v, needle) }));
}

const RULE_KINDS = [
  ["validators", "validator"],
  ["preFunctions", "preFunction"],
  ["postFunctions", "postFunction"],
] as const;

const SEARCH_LIMIT = 50;
const FAILED_SHOWN = 10;

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
    name: "get_workflow",
    description:
      "One workflow, parsed from its XML descriptor via a ScriptRunner endpoint (Jira " +
      "Administrators permission). Without transition_ids returns the structure: " +
      "description and meta; statuses with stepId, statusId, status category and meta " +
      "properties (jira.permission.*, jira.issue.editable, JSM approval.* settings); " +
      "transitions, each listed once with `from` naming every source status ((initial) " +
      "for create, (global) for any status) and `to` ((current status) when the issue " +
      "stays put), transition screen (id, name), meta, and per-kind rule counts. " +
      'With transition_ids (a list of ids, or "all") those transitions carry their full ' +
      "rules instead of counts: condition tree (AND/OR, negate), validators, and " +
      "pre/post-functions in execution order with arguments; ScriptRunner inline scripts " +
      "are decoded to Groovy source (or `scriptPath: …`), non-core rules carry className. " +
      "If the full rules would exceed the response limit, counts are kept and " +
      "`rulesOmitted` says how to narrow the call. Screen fields: get_screen_tabs_and_fields. " +
      "To find rules across all workflows: search_workflow_rules.",
    inputShape: {
      workflow_name: z.string().describe("Exact workflow name"),
      transition_ids: z
        .union([z.literal("all"), z.array(z.coerce.number().int())])
        .optional()
        .describe('Transition ids to return with full rules, or "all"'),
    },
    async handler({ client }, args) {
      const workflowName: string = args.workflow_name;
      const xmlStr = await client.exportWorkflowXml(workflowName);
      if (!xmlStr) {
        return dumps({ error: `Workflow XML export for '${workflowName}' returned nothing` });
      }
      const parsed = parseWorkflowXml(xmlStr);
      const transitions = uniqueTransitions(parsed);

      const hasScreens = transitions.some((t) => t.screenId);
      const [statuses, screens] = await Promise.all([
        safeList(client.listStatuses()),
        hasScreens ? safeList(client.listScreens()) : Promise.resolve([]),
      ]);
      const categoryById = new Map<string, string | null>(
        statuses.map((s: any) => [String(s.id), s.statusCategory?.name ?? null]),
      );
      const screenNameById = new Map<string, string>(
        screens.map((s: any) => [String(s.id), s.name]),
      );

      const wanted =
        args.transition_ids === "all"
          ? new Set(transitions.map((t) => t.id))
          : new Set<number>(args.transition_ids ?? []);
      const known = new Set(transitions.map((t) => t.id));
      const notFound = [...wanted].filter((id) => !known.has(id));

      const render = (full: Set<number>) =>
        transitions.map((t) => {
          const entry: Record<string, unknown> = { id: t.id, name: t.name };
          const { description, meta } = splitDescription(t.meta);
          if (description) entry.description = description;
          entry.from = t.from;
          entry.to = t.to;
          if (t.screenId) {
            entry.screen = { id: t.screenId, name: screenNameById.get(t.screenId) ?? null };
          }
          if (meta) entry.meta = meta;
          if (full.has(t.id)) {
            entry.conditions = t.conditions;
            entry.validators = t.validators;
            entry.preFunctions = t.preFunctions;
            entry.postFunctions = t.postFunctions;
          } else {
            entry.rules = ruleCounts(t);
          }
          return entry;
        });

      const result: Record<string, unknown> = {
        name: workflowName,
        ...splitDescription(parsed.meta),
        statuses: parsed.steps.map((s) => ({
          stepId: s.id,
          statusId: s.statusId,
          name: s.name,
          category: s.statusId ? (categoryById.get(s.statusId) ?? null) : null,
          ...(s.meta ? { meta: s.meta } : {}),
        })),
        transitions: render(wanted),
      };
      if (notFound.length > 0) result.notFound = notFound;
      const text = dumps(result);
      if (wanted.size === 0 || !exceedsResponseLimit(text)) return text;

      result.transitions = render(new Set());
      result.rulesOmitted =
        `Full rules for ${wanted.size} transition(s) would make the response ` +
        `${text.length} characters (limit ${MAX_RESPONSE_CHARS}), so rule counts are ` +
        "shown instead. Request fewer transition_ids, e.g. those with the most rules.";
      return dumps(result);
    },
  },

  {
    name: "search_workflow_rules",
    description:
      "Search the rules of every workflow for a text: conditions, validators, and " +
      "pre/post-functions (rule type, className, argument values including decoded " +
      "ScriptRunner inline scripts), plus transition and status meta properties. " +
      "Case-insensitive substring match: a custom field id, a class or app name, a " +
      "user or group, a jira.permission.* key. Each match names the workflow, the " +
      "transition (id, from, to) or status, the rule kind and its position in execution " +
      "order, and the matching fields with an excerpt; get the full rule with " +
      "get_workflow(transition_ids). Exports every workflow's XML descriptor via a " +
      "ScriptRunner endpoint (Jira Administrators permission), one request per workflow, " +
      "so a full scan takes seconds, or tens of seconds when Jira rate-limits the requests; " +
      "narrow it with name_contains. Workflows whose export fails are counted in " +
      "failedCount (first few listed in failed).",
    inputShape: {
      query: z.string().min(2).describe("Text to find (case-insensitive substring)"),
      ...nameFilterShape,
      limit: z
        .coerce.number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe(`Maximum number of matches to return (default ${SEARCH_LIMIT})`),
    },
    async handler({ client }, args) {
      const needle = String(args.query).toLowerCase();
      const limit = args.limit ?? SEARCH_LIMIT;
      const workflows = await client.listWorkflows();
      const names = filterByName(
        workflows.map((wf: any) => ({ name: String(wf.name ?? wf.id?.name) })),
        args.name_contains,
      ).map((wf) => wf.name);

      const failed: Array<{ workflow: string; error: string }> = [];
      const perWorkflow = await boundedAll(
        names.map((workflow) => async () => {
          let parsed: ParsedWorkflow;
          try {
            const xmlStr = await client.exportWorkflowXml(workflow);
            if (!xmlStr) throw new Error("workflow XML export returned nothing");
            parsed = parseWorkflowXml(xmlStr);
          } catch (e: any) {
            // Missing permission affects every workflow — fail the whole call.
            if (isHttpStatusError(e) && (e.status === 401 || e.status === 403)) throw e;
            failed.push({ workflow, error: String(e?.message ?? e) });
            return [];
          }

          const hits: Record<string, unknown>[] = [];
          for (const s of parsed.steps) {
            const matches = matchMeta(s.meta, needle);
            if (matches.length > 0) {
              hits.push({ workflow, kind: "statusMeta", status: s.name, statusId: s.statusId, matches });
            }
          }
          for (const t of uniqueTransitions(parsed)) {
            const where = { workflow, transitionId: t.id, transition: t.name, from: t.from, to: t.to };
            const metaMatches = matchMeta(t.meta, needle);
            if (metaMatches.length > 0) hits.push({ ...where, kind: "transitionMeta", matches: metaMatches });

            const ruleLists: Array<[string, FunctionEntry[]]> = [
              ["condition", conditionLeaves(t.conditions)],
              ...RULE_KINDS.map(([key, kind]): [string, FunctionEntry[]] => [kind, t[key] ?? []]),
            ];
            for (const [kind, rules] of ruleLists) {
              rules.forEach((rule, i) => {
                const matches = matchRule(rule, needle);
                if (matches.length === 0) return;
                hits.push({
                  ...where,
                  kind,
                  position: i + 1,
                  type: rule.type,
                  ...(rule.className ? { className: rule.className } : {}),
                  matches,
                });
              });
            }
          }
          return hits;
        }),
      );

      const all = perWorkflow.flat();
      return dumps({
        query: args.query,
        workflowsScanned: names.length - failed.length,
        ...(failed.length > 0
          ? { failedCount: failed.length, failed: failed.slice(0, FAILED_SHOWN) }
          : {}),
        matchCount: all.length,
        truncated: all.length > limit,
        matches: all.slice(0, limit),
      });
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

];
