/**
 * Standalone self-test / coverage runner for the Jira DC MCP server.
 *
 * Exercises every tool against the live Jira instance, auto-discovers the
 * IDs/keys that parameterised tools need (project keys, scheme IDs, workflow
 * names, board IDs, ...) from the `list_*`/`dump_*` tools, runs optional-
 * parameter variants to measure parameter coverage, and prints a live report —
 * one line per tool variant as it completes — followed by a coverage summary.
 *
 * Tools are driven in-process through each ToolDef's `handler`, so the report
 * reflects the exact code path the MCP server's tool dispatch hits.
 *
 * Each tool's returned JSON is also written to a file (one per tool) under the
 * `selftest-output/` folder, so the outputs can be inspected afterwards.
 *
 * Usage:
 *   tsx test/selftest.ts [--only a,b] [--skip a,b] [--out-dir PATH] [--json PATH]
 *   npm run selftest -- --only list_projects
 *
 * Jira credentials are read from the environment, falling back to the
 * `atlassian-for-admins` server's `env` block in `.mcp.json`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { ALL_TOOLS } from "../src/tools/index.js";
import { JiraClient } from "../src/client.js";
import { AutomationCache } from "../src/automationCache.js";
import type { ToolContext } from "../src/tools/types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Populate JIRA_* env vars from .mcp.json when not already set. */
function loadEnv(): void {
  const mcp = path.join(ROOT, ".mcp.json");
  if (!fs.existsSync(mcp)) return;
  try {
    const cfg = JSON.parse(fs.readFileSync(mcp, "utf-8"));
    const env = cfg?.mcpServers?.["atlassian-for-admins"]?.env;
    if (env && typeof env === "object") {
      for (const [key, value] of Object.entries(env)) {
        if (typeof value === "string" && process.env[key] === undefined) {
          process.env[key] = value;
        }
      }
    }
  } catch {
    /* ignore a malformed .mcp.json */
  }
}

const PER_CALL_TIMEOUT = 45_000; // ms per individual tool call
const DEFAULT_OUT_DIR = path.join(ROOT, "selftest-output");

// Worst-to-best ranking used to roll variant statuses up to a tool status.
const STATUS_RANK: Record<string, number> = {
  error: 6, timeout: 5, tool_error: 4, empty: 3, pass: 2, unsupported: 1, skipped: 0,
};
const ICON: Record<string, string> = {
  pass: "PASS", empty: "EMPT", unsupported: "UNSUP", tool_error: "WARN",
  error: "FAIL", timeout: "TIME", skipped: "SKIP",
};
const PHASE_NAMES: Record<number, string> = {
  1: "Phase 1 - zero-arg discovery",
  2: "Phase 2 - dependent tools",
  3: "Phase 3 - second-order dependent tools",
  4: "Phase 4 - cache-mutating tools",
};

// Which tool produces each harvest key — used to auto-resolve --only prerequisites.
// Keys absent here are produced in Phase 0 (always available, no prerequisite tool).
const HARVEST_PRODUCERS: Record<string, string> = {
  project_keys: "list_projects",
  field_ids: "list_fields",
  custom_field_ids: "list_fields",
  workflow_names: "list_active_workflows",
  screen_ids: "list_screens",
  workflow_scheme_ids: "list_workflow_schemes",
  screen_scheme_ids: "list_screen_schemes",
  permission_scheme_ids: "list_permission_schemes",
  notification_scheme_ids: "list_notification_schemes",
  board_ids: "list_boards",
  service_desk_ids: "list_service_desks",
  service_desk_project_keys: "list_service_desks",
  rule_ids: "list_automation_rules",
  createmeta_pairs: "get_project_config",
  user_keys: "find_users",
  audit_item_ids: "get_automation_audit_log",
  group_names: "get_user_groups",
  issue_type_screen_scheme_ids: "list_issue_type_screen_schemes",
  schema_ids: "list_object_schemas",
  object_type_ids: "list_object_types",
  object_type_names: "list_object_types",
  object_ids: "search_objects_iql",
};

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

type Args = Record<string, any>;
type Harvest = Record<string, any[]>;

/** One invocation of a tool with a specific argument set. */
interface Variant {
  label: string;
  args: Args;
  branch?: string; // parameter-coverage tag
  note?: string;
}

const V = (label: string, args: Args, branch?: string, note?: string): Variant => ({
  label, args, branch, note,
});

/** A discovery closure; `needs` lists harvest keys the tool requires to run. */
type DiscoverFn = ((h: Harvest) => Variant[] | null) & { needs?: string[] };

/** How to test a single tool: which variants to run, given discovered data. */
interface ToolCase {
  name: string;
  phase: number;
  discover: DiscoverFn;
  skipReason: string;
  timeout: number;
  branches: string[]; // all parameter branches this tool can exercise
  needs: string[];    // harvest keys this tool requires to run at all
}

function toolCase(
  name: string,
  phase: number,
  discover: DiscoverFn,
  opts: { skipReason?: string; timeout?: number; branches?: string[] } = {},
): ToolCase {
  return {
    name,
    phase,
    discover,
    skipReason: opts.skipReason ?? "no live data discovered for a required parameter",
    timeout: opts.timeout ?? PER_CALL_TIMEOUT,
    branches: opts.branches ?? [],
    needs: [],
  };
}

interface VariantResult {
  label: string;
  branch?: string;
  args: Args;
  status: string; // pass | empty | unsupported | tool_error | error | timeout
  durationMs: number;
  resultBytes: number;
  error?: string;
  note?: string;
  parsed?: any; // not serialised
  raw?: string; // raw tool output, for file dump; not serialised
}

// ---------------------------------------------------------------------------
// Execution / harvest helpers
// ---------------------------------------------------------------------------

const round1 = (n: number): number => Math.round(n * 10) / 10;

function tryParseJson(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const isPlainObject = (v: any): boolean =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const isError = (parsed: any): boolean => isPlainObject(parsed) && "error" in parsed;

/** A paginated listing's `{ total, items }` envelope (see `paginate`). */
const isPage = (parsed: any): boolean =>
  isPlainObject(parsed) && Array.isArray(parsed.items) && typeof parsed.total === "number";

const isEmpty = (parsed: any): boolean =>
  (Array.isArray(parsed) && parsed.length === 0) ||
  (isPage(parsed) && parsed.total === 0) ||
  (isPlainObject(parsed) && Object.keys(parsed).length === 0);

class TimeoutError extends Error {}

/** Race a promise against a timeout; rejects with TimeoutError on expiry. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new TimeoutError(`exceeded ${(ms / 1000).toFixed(0)}s timeout`)),
      ms,
    );
    timer.unref();
  });
  return Promise.race([p.finally(() => clearTimeout(timer)), timeout]);
}

const TOOL_BY_NAME = new Map(ALL_TOOLS.map((t) => [t.name, t]));

/** Invoke a tool's handler directly — the dispatch path a real call hits. */
async function dispatch(ctx: ToolContext, name: string, args: Args): Promise<string> {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) throw new Error(`unknown tool: ${name}`);
  return tool.handler(ctx, args);
}

/** Run a single tool variant, capturing timing, errors and result classification. */
async function runOne(
  ctx: ToolContext,
  name: string,
  variant: Variant,
  timeout: number,
): Promise<VariantResult> {
  const started = performance.now();
  let raw: string;
  try {
    raw = await withTimeout(dispatch(ctx, name, variant.args), timeout);
  } catch (e: any) {
    const durationMs = performance.now() - started;
    if (e instanceof TimeoutError) {
      return {
        label: variant.label, branch: variant.branch, args: variant.args,
        status: "timeout", durationMs, resultBytes: 0, error: e.message, note: variant.note,
      };
    }
    // dispatch threw directly — an unhandled bug in a tool.
    return {
      label: variant.label, branch: variant.branch, args: variant.args,
      status: "error", durationMs, resultBytes: 0,
      error: `${e?.name ?? "Error"}: ${e?.message ?? e}`, note: variant.note,
    };
  }

  const durationMs = performance.now() - started;
  const parsed = tryParseJson(raw);
  let status: string;
  let message: string | undefined;
  if (isPlainObject(parsed) && "unsupported" in parsed) {
    status = "unsupported"; // tool ran; the Jira instance lacks this API
    message = parsed.unsupported;
  } else if (isError(parsed)) {
    status = "tool_error";
    message = parsed.error;
  } else if (isEmpty(parsed)) {
    status = "empty"; // call succeeded but returned no data
    message = undefined;
  } else {
    status = "pass";
    message = undefined;
  }
  return {
    label: variant.label, branch: variant.branch, args: variant.args, status,
    durationMs, resultBytes: (raw ?? "").length, error: message, note: variant.note,
    parsed, raw,
  };
}

/** Append unique, non-empty values to a harvest bucket, preserving order. */
function add(harvest: Harvest, key: string, values: any[]): void {
  const bucket = harvest[key] ?? (harvest[key] = []);
  for (const v of values) {
    if (v !== null && v !== undefined && v !== "" && !bucket.includes(v)) bucket.push(v);
  }
}

/** Extract reusable IDs/keys from a tool's (non-error) result into `harvest`. */
function harvest(h: Harvest, tool: string, parsed: any): void {
  const arr: any[] = Array.isArray(parsed) ? parsed : isPage(parsed) ? parsed.items : [];
  const objs = arr.filter(isPlainObject);
  switch (tool) {
    case "list_projects":
      add(h, "project_keys", objs.map((p) => p.key));
      break;
    case "list_fields": {
      const customs = objs.filter((f) => f.custom).map((f) => f.id);
      const allids = objs.map((f) => f.id);
      add(h, "custom_field_ids", customs);
      add(h, "field_ids", customs.length ? customs.slice(0, 1) : allids.slice(0, 1));
      break;
    }
    case "list_active_workflows":
    case "list_all_workflows":
      add(h, "workflow_names", objs.map((w) => w.name));
      break;
    case "list_screens":
      add(h, "screen_ids", objs.map((s) => s.id));
      break;
    case "list_workflow_schemes":
      add(h, "workflow_scheme_ids", objs.map((s) => s.id));
      break;
    case "list_screen_schemes":
      add(h, "screen_scheme_ids", objs.map((s) => s.id));
      break;
    case "list_permission_schemes":
      add(h, "permission_scheme_ids", objs.map((s) => s.id));
      break;
    case "list_notification_schemes":
      add(h, "notification_scheme_ids", objs.map((s) => s.id));
      break;
    case "list_boards":
      add(h, "board_ids", objs.map((b) => b.id));
      break;
    case "list_issue_type_screen_schemes":
      add(h, "issue_type_screen_scheme_ids", objs.map((s) => s.id));
      break;
    case "list_service_desks":
      add(h, "service_desk_ids", objs.map((d) => d.id));
      add(h, "service_desk_project_keys", objs.map((d) => d.projectKey));
      break;
    case "list_automation_rules":
      add(h, "rule_ids", objs.map((r) => r.id));
      break;
    case "get_project_config":
      if (isPlainObject(parsed)) {
        const pk = parsed.key;
        const pairs = (parsed.issueTypes ?? [])
          .filter((it: any) => isPlainObject(it) && pk && it.id)
          .map((it: any) => [pk, it.id]);
        add(h, "createmeta_pairs", pairs);
      }
      break;
    case "get_project_role_members":
      if (isPlainObject(parsed)) {
        for (const role of Object.values<any>(parsed)) {
          const actors = isPlainObject(role) ? role.actors ?? [] : [];
          for (const actor of actors) {
            const atype = String(actor?.type ?? "").toLowerCase();
            if (atype.includes("user") && actor?.name) add(h, "user_keys", [actor.name]);
            else if (atype.includes("group") && actor?.name) add(h, "group_names", [actor.name]);
          }
        }
      }
      break;
    case "find_users":
      add(h, "user_keys", objs.map((u) => u.key ?? u.name));
      add(h, "usernames", objs.map((u) => u.name));
      break;
    case "get_automation_audit_log":
      add(h, "audit_item_ids", objs.map((e) => e.id));
      break;
    case "get_user_groups":
      add(h, "group_names", objs.map((g) => g.name));
      break;
    case "list_object_schemas":
      add(h, "schema_ids", objs.map((s) => s.id));
      break;
    case "list_object_types":
      add(h, "object_type_ids", objs.map((t) => t.id));
      add(h, "object_type_names", objs.map((t) => t.name));
      break;
    case "search_objects_iql":
      // Returns an object { total, returned, objects: [...] }, not an array.
      if (isPlainObject(parsed)) {
        add(h, "object_ids", (parsed.objects ?? []).filter(isPlainObject).map((o: any) => o.id));
      }
      break;
  }
}

// ---------------------------------------------------------------------------
// Discovery closure factories
// ---------------------------------------------------------------------------

const noArgs: DiscoverFn = () => [V("default", {})];

/** A tool that needs one discovered value passed as a single argument. */
function single(harvestKey: string, argName: string): DiscoverFn {
  const disc: DiscoverFn = (h) => {
    const vals = h[harvestKey] ?? [];
    if (!vals.length) return null;
    return [V("default", { [argName]: vals[0] })];
  };
  disc.needs = [harvestKey];
  return disc;
}

// ---------------------------------------------------------------------------
// The test plan — one ToolCase per tool, ordered by discovery dependency
// ---------------------------------------------------------------------------

function buildTestPlan(): ToolCase[] {
  // --- multi-variant discover closures (parameter coverage) ----------------

  const discListFields: DiscoverFn = () => [
    // 'summary' is a universal system field — safe deterministic id filter.
    V("default", {}, "list_fields:default"),
    V("custom_only", { custom_only: true }, "list_fields:custom_only"),
    V("field_ids", { field_ids: ["summary"] }, "list_fields:field_ids"),
    V("name_contains", { name_contains: "sum" }, "list_fields:name_contains"),
    V("second page", { offset: 5, limit: 5 }, "list_fields:page"),
  ];

  const discCustomFieldsUsage: DiscoverFn = (h) => {
    const variants = [
      V("no filter", {}, "cfu:none"),
      V("search", { search: "field" }, "cfu:search"),
      V("unused_only", { unused_only: true }, "cfu:unused_only"),
    ];
    const pk = (h.project_keys ?? [])[0];
    if (pk) {
      variants.push(V("project_key+min_issues", { project_key: pk, min_issues: 1 }, "cfu:project"));
    }
    return variants;
  };

  const discListBoards: DiscoverFn = (h) => {
    const variants = [V("no project_key", {}, "boards:no_project")];
    const pk = (h.project_keys ?? [])[0];
    if (pk) variants.push(V("project_key", { project_key: pk }, "boards:project"));
    return variants;
  };

  const discListAutomationRules: DiscoverFn = (h) => {
    const variants = [V("no project_key", {}, "rules:no_project")];
    const pk = (h.project_keys ?? [])[0];
    if (pk) variants.push(V("project_key", { project_key: pk }, "rules:project"));
    return variants;
  };

  /** A real discovered issue key, else the <project>-1 heuristic, else null. */
  function issueKey(h: Harvest): [string | null, string | null] {
    const discovered = (h.issue_keys ?? [])[0];
    if (discovered) return [discovered, `discovered issue key ${discovered}`];
    const pk = (h.project_keys ?? [])[0];
    if (pk) return [`${pk}-1`, `heuristic issue key ${pk}-1 (issue-key discovery found none)`];
    return [null, null];
  }

  const discGetIssue: DiscoverFn = (h) => {
    const [key, note] = issueKey(h);
    if (!key) return null;
    return [
      V("default fields", { issue_key: key }, "issue:default_fields", note ?? undefined),
      V("explicit fields", { issue_key: key, fields: "summary,status" },
        "issue:explicit_fields", note ?? undefined),
    ];
  };

  const discGetIssueChangelog: DiscoverFn = (h) => {
    const [key, note] = issueKey(h);
    if (!key) return null;
    return [
      V("all changes", { issue_key: key }, "changelog:all", note ?? undefined),
      V("field filter", { issue_key: key, field: "status" }, "changelog:field", note ?? undefined),
    ];
  };

  const discAuditLog: DiscoverFn = () => [
    V("default", { limit: 10 }, "auditlog:default"),
    V("paged", { limit: 10, offset: 5 }, "auditlog:paged"),
    V("category filter", { limit: 10, categories: ["SUCCESS"] }, "auditlog:filtered"),
  ];

  const discRuleAuditLog: DiscoverFn = (h) => {
    const ids = h.rule_ids ?? [];
    if (!ids.length) return null;
    return [
      V("basic", { rule_id: ids[0], limit: 10 }, "ruleaudit:basic"),
      V("category filter", { rule_id: ids[0], limit: 10, categories: ["SUCCESS"] },
        "ruleaudit:filtered"),
    ];
  };

  const discSearchConfig: DiscoverFn = (h) => {
    const pk = (h.project_keys ?? [])[0];
    const variants = [V("keyword", { query: "status" }, "search:keyword")];
    if (pk) variants.unshift(V("project key", { query: pk }, "search:project_key"));
    return variants;
  };

  const discGetWorkflow: DiscoverFn = (h) => {
    const name = (h.workflow_names ?? [])[0];
    if (!name) return null;
    return [
      V("structure", { workflow_name: name }, "workflow:structure"),
      V("all rules", { workflow_name: name, transition_ids: "all" }, "workflow:all_rules"),
    ];
  };
  discGetWorkflow.needs = ["workflow_names"];

  // Scoped to one workflow: a full scan exports every workflow's XML.
  const discSearchWorkflowRules: DiscoverFn = (h) => {
    const name = (h.workflow_names ?? [])[0];
    if (!name) return null;
    return [V("class name", { query: "com.atlassian", name_contains: name })];
  };
  discSearchWorkflowRules.needs = ["workflow_names"];

  const discFindUsers: DiscoverFn = () => [
    V("query", { query: "a" }, "users:query"),
    V("query+max_results", { query: "a", max_results: 5 }, "users:query_max"),
  ];

  const discGroupMembers: DiscoverFn = (h) => {
    const groups = h.group_names ?? [];
    if (!groups.length) return null;
    return [
      V("basic", { group_name: groups[0] }, "members:basic"),
      V("include_inactive", { group_name: groups[0], include_inactive: true }, "members:inactive"),
    ];
  };

  const discCreatemeta: DiscoverFn = (h) => {
    const pairs = h.createmeta_pairs ?? [];
    if (!pairs.length) return null;
    const [pk, itid] = pairs[0];
    return [V("default", { project_key: pk, issue_type_id: itid })];
  };

  const discFieldConfig: DiscoverFn = (h) => {
    const ids = h.field_config_ids ?? [];
    if (ids.length) return [V("default", { fc_id: ids[0] })];
    return [V("synthetic id", { fc_id: 10000 },
      undefined, "no field configs discovered — jiraMcpFieldConfigurations " +
      "ScriptRunner endpoint may be undeployed")];
  };

  const discFieldConfigScheme: DiscoverFn = (h) => {
    const ids = h.field_config_scheme_ids ?? [];
    if (ids.length) return [V("default", { scheme_id: ids[0] })];
    return [V("synthetic id", { scheme_id: 10000 },
      undefined, "no schemes discovered — jiraMcpFieldConfigurationSchemes " +
      "ScriptRunner endpoint may be undeployed")];
  };

  const discListObjectTypes: DiscoverFn = (h) => {
    const ids = h.schema_ids ?? [];
    if (!ids.length) return null;
    return [
      V("flat", { schema_id: ids[0] }, "objtypes:flat"),
      V("hierarchical", { schema_id: ids[0], hierarchical: true }, "objtypes:tree"),
    ];
  };
  discListObjectTypes.needs = ["schema_ids"];

  const discSearchIql: DiscoverFn = (h) => {
    const names = h.object_type_names ?? [];
    const schemaId = (h.schema_ids ?? [])[0];
    if (!names.length || schemaId === undefined) return null;
    return [
      V("by object type", { iql: `objectType = "${names[0]}"`, schema_id: schemaId, max_results: 5 },
        "iql:by_type"),
    ];
  };
  discSearchIql.needs = ["object_type_names", "schema_ids"];

  const discTailServerLog: DiscoverFn = () => [
    V("default file", { lines: 20 }),
  ];

  const discGrepServerLog: DiscoverFn = () => [
    V("basic", { pattern: "ERROR", max_matches: 5 }, "greplog:basic"),
    V("context+rotations",
      { pattern: "error", rotations: 1, context_before: 1, context_after: 1,
        case_insensitive: true, max_matches: 5 },
      "greplog:context"),
  ];

  const discEffectivePerms: DiscoverFn = (h) => {
    const pk = (h.project_keys ?? [])[0];
    if (!pk) return null;
    const user = (h.usernames ?? [])[0];
    if (user) return [V("by user", { project_key: pk, username: user })];
    return [V("by permission", { project_key: pk, permission: "BROWSE_PROJECTS" })];
  };

  // Required harvest keys for closures that skip entirely without discovered
  // data (the single() factory tags its own; these are hand-written closures).
  discCreatemeta.needs = ["createmeta_pairs"];
  discEffectivePerms.needs = ["project_keys"];
  discRuleAuditLog.needs = ["rule_ids"];
  discGroupMembers.needs = ["group_names"];
  discGetIssue.needs = ["project_keys"];
  discGetIssueChangelog.needs = ["project_keys"];

  const plan: ToolCase[] = [
    // ---- Phase 1: zero-arg discovery -----------------------------------
    toolCase("dump_global_config", 1, noArgs),
    toolCase("dump_automation_rules", 1, noArgs),
    toolCase("list_projects", 1, noArgs),
    toolCase("list_active_workflows", 1, noArgs),
    toolCase("list_all_workflows", 1, noArgs),
    toolCase("list_screens", 1, noArgs),
    toolCase("list_workflow_schemes", 1, noArgs),
    toolCase("list_screen_schemes", 1, noArgs),
    toolCase("list_permission_schemes", 1, noArgs),
    toolCase("list_notification_schemes", 1, noArgs),
    toolCase("list_automation_rules", 1, discListAutomationRules,
      { branches: ["rules:no_project", "rules:project"] }),
    toolCase("list_boards", 1, discListBoards,
      { branches: ["boards:no_project", "boards:project"] }),
    toolCase("list_service_desks", 1, noArgs),
    toolCase("dump_plugin_inventory", 1, noArgs),
    toolCase("list_object_schemas", 1, noArgs,
      { skipReason: "Assets (Insight) not installed on this instance" }),
    toolCase("list_object_statuses", 1, noArgs,
      { skipReason: "Assets (Insight) not installed on this instance" }),
    toolCase("list_issue_type_screen_schemes", 1, noArgs),
    toolCase("list_listeners", 1, noArgs),
    toolCase("list_scheduled_services", 1, noArgs),
    toolCase("list_application_links", 1, noArgs),
    toolCase("list_server_log_files", 1, noArgs),
    toolCase("tail_server_log", 1, discTailServerLog),
    toolCase("grep_server_log", 1, discGrepServerLog,
      { branches: ["greplog:basic", "greplog:context"] }),
    toolCase("list_filters", 1, noArgs),
    toolCase("list_dashboards", 1, noArgs),
    toolCase("list_project_categories", 1, noArgs),
    toolCase("list_fields", 1, discListFields,
      { branches: ["list_fields:default", "list_fields:custom_only", "list_fields:field_ids",
        "list_fields:name_contains", "list_fields:page"] }),
    toolCase("list_custom_fields_usage", 1, discCustomFieldsUsage,
      { branches: ["cfu:none", "cfu:search", "cfu:unused_only", "cfu:project"] }),

    // ---- Phase 2: first-order dependent --------------------------------
    toolCase("get_project_config", 2, single("project_keys", "project_key")),
    toolCase("get_project_role_members", 2, single("project_keys", "project_key")),
    toolCase("get_project_components", 2, single("project_keys", "project_key")),
    toolCase("get_project_versions", 2, single("project_keys", "project_key")),
    toolCase("get_createmeta_fields", 2, discCreatemeta,
      { skipReason: "no project/issue-type pair discovered from get_project_config" }),
    toolCase("get_workflow", 2, discGetWorkflow,
      { branches: ["workflow:structure", "workflow:all_rules"] }),
    toolCase("search_workflow_rules", 2, discSearchWorkflowRules),
    toolCase("get_workflow_scheme", 2, single("workflow_scheme_ids", "scheme_id")),
    toolCase("get_screen_tabs_and_fields", 2, single("screen_ids", "screen_id")),
    toolCase("get_screen_scheme", 2, single("screen_scheme_ids", "scheme_id"),
      { skipReason: "no screen schemes discovered (reconstructed view may be empty)" }),
    toolCase("get_permission_scheme", 2, single("permission_scheme_ids", "scheme_id")),
    toolCase("get_notification_scheme", 2, single("notification_scheme_ids", "scheme_id")),
    toolCase("get_issue_type_scheme", 2, single("issue_type_scheme_ids", "scheme_id")),
    toolCase("get_issue_security_scheme", 2, single("issue_security_scheme_ids", "scheme_id"),
      { skipReason: "no issue security schemes exist on this instance" }),
    toolCase("get_priority_scheme", 2, single("priority_scheme_ids", "scheme_id"),
      { skipReason: "no priority schemes exist on this instance" }),
    // Field-config data comes from ScriptRunner endpoints; ids are seeded in
    // Phase 0. Falls back to a synthetic id when the endpoint is undeployed.
    toolCase("get_field_configuration", 2, discFieldConfig),
    toolCase("get_field_configuration_scheme", 2, discFieldConfigScheme),
    // find_field_usage scans every screen — give it generous headroom on large
    // instances before a timeout is treated as a genuine failure.
    toolCase("find_field_usage", 2, single("field_ids", "field_id"), { timeout: 240_000 }),
    toolCase("get_field_contexts", 2, single("field_ids", "field_id")),
    toolCase("get_automation_rule_detail", 2, single("rule_ids", "rule_id"),
      { skipReason: "no automation rules in cache" }),
    toolCase("get_automation_audit_log", 2, discAuditLog,
      { branches: ["auditlog:default", "auditlog:paged", "auditlog:filtered"] }),
    toolCase("get_automation_rule_audit_log", 2, discRuleAuditLog,
      { skipReason: "no automation rules in cache",
        branches: ["ruleaudit:basic", "ruleaudit:filtered"] }),
    toolCase("get_board_configuration", 2, single("board_ids", "board_id"),
      { skipReason: "instance has no agile boards" }),
    toolCase("get_service_desk_queues", 2, single("service_desk_ids", "service_desk_id"),
      { skipReason: "instance has no JSM service desks" }),
    toolCase("get_sla_config", 2, single("service_desk_project_keys", "project_key"),
      { skipReason: "instance has no JSM service desks" }),
    toolCase("analyze_project_config_chain", 2, single("project_keys", "project_key")),
    toolCase("search_config", 2, discSearchConfig,
      { branches: ["search:project_key", "search:keyword"] }),
    toolCase("get_issue", 2, discGetIssue,
      { branches: ["issue:default_fields", "issue:explicit_fields"] }),
    toolCase("get_issue_changelog", 2, discGetIssueChangelog,
      { branches: ["changelog:all", "changelog:field"] }),
    toolCase("find_users", 2, discFindUsers, { branches: ["users:query", "users:query_max"] }),
    toolCase("get_issue_type_screen_scheme", 2,
      single("issue_type_screen_scheme_ids", "scheme_id"),
      { skipReason: "no issue type screen schemes discovered" }),
    toolCase("get_effective_permissions", 2, discEffectivePerms),
    toolCase("get_object_schema", 2, single("schema_ids", "schema_id"),
      { skipReason: "no Assets object schema discovered" }),
    toolCase("list_object_types", 2, discListObjectTypes,
      { skipReason: "no Assets object schema discovered",
        branches: ["objtypes:flat", "objtypes:tree"] }),
    toolCase("get_schema_attributes", 2, single("schema_ids", "schema_id"),
      { skipReason: "no Assets object schema discovered" }),
    toolCase("dump_assets_schema", 2, single("schema_ids", "schema_id"),
      { skipReason: "no Assets object schema discovered" }),

    // ---- Phase 3: second-order dependent -------------------------------
    toolCase("get_automation_audit_item", 3, single("audit_item_ids", "item_id"),
      { skipReason: "audit log produced no entries to drill into" }),
    toolCase("get_user", 3, single("user_keys", "key"),
      { skipReason: "no user key discovered from find_users / role members" }),
    toolCase("get_user_groups", 3, single("user_keys", "key"),
      { skipReason: "no user key discovered from find_users / role members" }),
    toolCase("get_group_members", 3, discGroupMembers,
      { skipReason: "no group discovered from get_user_groups / role members",
        branches: ["members:basic", "members:inactive"] }),
    toolCase("get_object_type", 3, single("object_type_ids", "object_type_id"),
      { skipReason: "no Assets object type discovered" }),
    toolCase("get_object_type_attributes", 3, single("object_type_ids", "object_type_id"),
      { skipReason: "no Assets object type discovered" }),
    // search must precede get_object/* so object_ids are harvested in time.
    toolCase("search_objects_iql", 3, discSearchIql,
      { skipReason: "no Assets object type discovered to build an IQL query",
        branches: ["iql:by_type"] }),
    toolCase("get_object", 3, single("object_ids", "object_id"),
      { skipReason: "no Assets object discovered from search_objects_iql" }),
    toolCase("get_object_connected_tickets", 3, single("object_ids", "object_id"),
      { skipReason: "no Assets object discovered from search_objects_iql" }),

    // ---- Phase 4: cache-mutating, run last -----------------------------
    toolCase("refresh_automation_cache", 4, noArgs),
  ];

  // Populate each ToolCase.needs from its discover closure.
  for (const c of plan) c.needs = c.discover.needs ?? [];
  return plan;
}

/** Expand a --only set to include the discovery tools the selection depends on. */
function resolvePrerequisites(plan: ToolCase[], wanted: Set<string>): Set<string> {
  const byName = new Map(plan.map((c) => [c.name, c]));
  const effective = new Set(wanted);
  const queue = [...wanted];
  while (queue.length) {
    const c = byName.get(queue.pop()!);
    if (!c) continue;
    for (const key of c.needs) {
      const producer = HARVEST_PRODUCERS[key];
      if (producer && !effective.has(producer)) {
        effective.add(producer);
        queue.push(producer);
      }
    }
  }
  return effective;
}

// ---------------------------------------------------------------------------
// Live printing
// ---------------------------------------------------------------------------

function printPhase(phase: number): void {
  console.log(`\n${PHASE_NAMES[phase] ?? `Phase ${phase}`}`);
}

function printVariant(tool: string, vr: VariantResult): void {
  const icon = (ICON[vr.status] ?? vr.status).padEnd(5);
  const size = vr.resultBytes
    ? `${(vr.resultBytes / 1024).toFixed(1).padStart(7)} KB`
    : " ".repeat(10);
  console.log(
    `  ${icon} ${tool.padEnd(38)}${vr.label.padEnd(24)}` +
    `${vr.durationMs.toFixed(0).padStart(8)} ms  ${size}`,
  );
  if (vr.error) console.log(`        |_ ${vr.error}`);
}

function printSkip(tool: string, reason: string): void {
  console.log(`  ${"SKIP".padEnd(5)} ${tool.padEnd(38)}${reason}`);
}

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

/** Write the first variant's raw JSON output to out_dir/<tool>.json. */
function saveToolOutput(outDir: string, tool: string, variantResults: VariantResult[]): void {
  for (const vr of variantResults) {
    if (vr.raw != null) {
      fs.writeFileSync(path.join(outDir, `${tool}.json`), vr.raw, "utf-8");
      return;
    }
  }
}

function skippedTool(c: ToolCase, reason: string): any {
  return {
    tool: c.name, phase: c.phase, status: "skipped",
    variantsRun: 0, skipReason: reason, variants: [],
  };
}

function toolResult(c: ToolCase, variantResults: VariantResult[]): any {
  const worst = variantResults.reduce(
    (w, vr) => (STATUS_RANK[vr.status] > STATUS_RANK[w] ? vr.status : w),
    variantResults[0].status,
  );
  return {
    tool: c.name,
    phase: c.phase,
    status: worst,
    variantsRun: variantResults.length,
    variants: variantResults.map((vr) => ({
      label: vr.label,
      branch: vr.branch ?? null,
      status: vr.status,
      durationMs: round1(vr.durationMs),
      resultBytes: vr.resultBytes,
      args: vr.args,
      error: vr.error ?? null,
      note: vr.note ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

interface RunOptions {
  outDir: string;
  only: string[] | null;
  skip: string[] | null;
}

async function runSelfTest(ctx: ToolContext, opts: RunOptions): Promise<any> {
  const started = new Date();
  const t0 = performance.now();

  const onlySet = opts.only ? new Set(opts.only) : null;
  const skipSet = new Set(opts.skip ?? []);
  const harvestData: Harvest = {};
  const { outDir } = opts;

  // Fresh output directory for this run.
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`Tool outputs -> ${outDir}`);

  // Phase 0 — prime the automation cache so A4J tools are meaningful.
  let cacheStatus = "ok";
  try {
    await ctx.cache.ensureRefreshed();
  } catch (e: any) {
    cacheStatus = `${e?.name ?? "Error"}: ${e?.message ?? e}`;
  }
  console.log(`Automation cache: ${cacheStatus}`);

  // Phase 0 — seed IDs that have no dedicated discovery tool (each method
  // returns a list of objects carrying an "id").
  const seedMethods: Array<[string, string]> = [
    ["listIssueTypeSchemes", "issue_type_scheme_ids"],
    ["listIssueSecuritySchemes", "issue_security_scheme_ids"],
    ["listPrioritySchemes", "priority_scheme_ids"],
    ["listFieldConfigurations", "field_config_ids"],
    ["listFieldConfigurationSchemes", "field_config_scheme_ids"],
  ];
  for (const [method, key] of seedMethods) {
    try {
      const data = await (ctx.client as any)[method]();
      add(harvestData, key, (data as any[]).filter(isPlainObject).map((s) => s.id));
    } catch {
      /* endpoint unavailable — leave the bucket empty */
    }
  }

  // Phase 0 — discover a real issue key (no MCP tool returns issue keys).
  try {
    const data: any = await ctx.client.get("/rest/api/2/search", {
      jql: "order by updated DESC", maxResults: 1, fields: "key",
    });
    add(harvestData, "issue_keys", (data?.issues ?? []).map((i: any) => i.key));
  } catch {
    /* search unavailable — get_issue falls back to the <project>-1 heuristic */
  }

  const plan = buildTestPlan();
  const registered = new Set(ALL_TOOLS.map((t) => t.name));
  const plannedNames = new Set(plan.map((c) => c.name));

  // When --only is used, auto-include the discovery tools the selection depends
  // on, so any tool can be tested in isolation without listing its deps.
  let effectiveOnly = onlySet;
  if (onlySet) {
    effectiveOnly = resolvePrerequisites(plan, onlySet);
    const incoming = onlySet; // narrow for the filter closure
    const added = [...effectiveOnly].filter((n) => !incoming.has(n)).sort();
    if (added.length) {
      console.log(`--only: also running ${added.length} prerequisite discovery ` +
        `tool(s): ${added.join(", ")}`);
    }
  }

  const results: any[] = [];
  let currentPhase: number | null = null;
  for (const c of plan) {
    if (!registered.has(c.name)) continue; // plan references a removed tool
    if (effectiveOnly && !effectiveOnly.has(c.name)) continue;
    if (c.phase !== currentPhase) {
      currentPhase = c.phase;
      printPhase(c.phase);
    }

    if (skipSet.has(c.name)) {
      results.push(skippedTool(c, "excluded via --skip"));
      printSkip(c.name, "excluded via --skip");
      continue;
    }

    const variants = c.discover(harvestData);
    if (!variants || !variants.length) {
      results.push(skippedTool(c, c.skipReason));
      printSkip(c.name, c.skipReason);
      continue;
    }

    const variantResults: VariantResult[] = [];
    for (const variant of variants) {
      const vr = await runOne(ctx, c.name, variant, c.timeout);
      variantResults.push(vr);
      if (vr.parsed != null && !isError(vr.parsed)) harvest(harvestData, c.name, vr.parsed);
      printVariant(c.name, vr);
    }
    results.push(toolResult(c, variantResults));
    saveToolOutput(outDir, c.name, variantResults);
  }

  // Tools in the registry that the plan does not cover (e.g. newly added).
  for (const name of [...registered].filter((n) => !plannedNames.has(n)).sort()) {
    if (effectiveOnly && !effectiveOnly.has(name)) continue;
    results.push({
      tool: name, phase: 99, status: "skipped", variantsRun: 0,
      skipReason: "not covered by the self-test plan", variants: [],
    });
    printSkip(name, "not covered by the self-test plan");
  }

  // ---- aggregate ---------------------------------------------------------
  const inScope = effectiveOnly
    ? new Set([...registered].filter((n) => effectiveOnly!.has(n)))
    : registered;
  const toolsTotal = inScope.size;

  const counts: Record<string, number> = {
    pass: 0, empty: 0, unsupported: 0, tool_error: 0, error: 0, timeout: 0, skipped: 0,
  };
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;

  const vCounts: Record<string, number> = {
    pass: 0, empty: 0, unsupported: 0, tool_error: 0, error: 0, timeout: 0,
  };
  const exercisedBranches = new Set<string>();
  const failures: any[] = [];
  const skipped: any[] = [];
  for (const r of results) {
    if (r.status === "skipped") skipped.push({ tool: r.tool, reason: r.skipReason });
    for (const v of r.variants) {
      vCounts[v.status] = (vCounts[v.status] ?? 0) + 1;
      if (v.branch) exercisedBranches.add(v.branch);
      if (v.status === "error" || v.status === "timeout") {
        failures.push({ tool: r.tool, variant: v.label, status: v.status, error: v.error });
      }
    }
  }

  const plannedBranches = new Set<string>();
  for (const c of plan) {
    if (effectiveOnly && !effectiveOnly.has(c.name)) continue;
    for (const b of c.branches) plannedBranches.add(b);
  }
  const branchesHit = [...exercisedBranches].filter((b) => plannedBranches.has(b));

  const toolsRun = toolsTotal - counts.skipped;
  const pct = (num: number, den: number): number => (den ? round1((num / den) * 100) : 0);

  const discovery: Record<string, any> = {};
  for (const key of Object.keys(harvestData).sort()) {
    const vals = harvestData[key];
    discovery[key] = { count: vals.length, sample: vals.slice(0, 3) };
  }

  const report = {
    schemaVersion: 1,
    startedAt: started.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: round1(performance.now() - t0),
    options: { only: opts.only, skip: opts.skip },
    automationCache: cacheStatus,
    summary: {
      toolsTotal,
      toolsRun,
      toolsPassed: counts.pass,
      toolsEmpty: counts.empty,
      toolsUnsupported: counts.unsupported,
      toolsToolError: counts.tool_error,
      toolsFailed: counts.error + counts.timeout,
      toolsSkipped: counts.skipped,
      variantsTotal: Object.values(vCounts).reduce((a, b) => a + b, 0),
      variantsPassed: vCounts.pass,
      variantsEmpty: vCounts.empty,
      variantsUnsupported: vCounts.unsupported,
      variantsToolError: vCounts.tool_error,
      variantsFailed: vCounts.error + vCounts.timeout,
      coverage: {
        toolCoveragePct: pct(toolsRun, toolsTotal),
        passCoveragePct: pct(counts.pass, toolsTotal),
        parameterBranchesExercised: branchesHit.length,
        parameterBranchesPlanned: plannedBranches.size,
        parameterBranchCoveragePct: pct(branchesHit.length, plannedBranches.size),
      },
    },
    discovery,
    results,
    skipped,
    failures,
  };
  fs.writeFileSync(
    path.join(outDir, "_report.json"), JSON.stringify(report, null, 2), "utf-8",
  );
  return report;
}

// ---------------------------------------------------------------------------
// Summary printing
// ---------------------------------------------------------------------------

function printSummary(report: any): void {
  const s = report.summary;
  const cov = s.coverage;
  console.log("\n" + "=".repeat(72));
  console.log("SUMMARY");
  console.log("=".repeat(72));
  console.log(
    `  tools     : ${s.toolsPassed} passed  ${s.toolsEmpty} empty  ` +
    `${s.toolsUnsupported} unsupported  ${s.toolsToolError} tool-error  ` +
    `${s.toolsFailed} failed  ${s.toolsSkipped} skipped   (of ${s.toolsTotal})`,
  );
  console.log(
    `  variants  : ${s.variantsPassed} passed  ${s.variantsEmpty} empty  ` +
    `${s.variantsUnsupported} unsupported  ${s.variantsToolError} tool-error  ` +
    `${s.variantsFailed} failed   (of ${s.variantsTotal})`,
  );
  console.log(
    `  coverage  : tools ${cov.toolCoveragePct}%   pass ${cov.passCoveragePct}%   ` +
    `param-branches ${cov.parameterBranchesExercised}/` +
    `${cov.parameterBranchesPlanned} (${cov.parameterBranchCoveragePct}%)`,
  );
  console.log(`  duration  : ${(report.durationMs / 1000).toFixed(1)}s`);

  if (report.failures.length) {
    console.log("\n  FAILURES:");
    for (const f of report.failures) {
      console.log(`    ${f.tool} [${f.variant}] ${f.status}: ${f.error}`);
    }
  } else {
    console.log("\n  No hard failures.");
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

interface CliArgs {
  only: string[] | null;
  skip: string[] | null;
  outDir: string;
  json: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { only: null, skip: null, outDir: DEFAULT_OUT_DIR, json: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (): string => {
      const eq = a.indexOf("=");
      return eq >= 0 ? a.slice(eq + 1) : argv[++i];
    };
    if (a === "--only" || a.startsWith("--only=")) {
      out.only = value().split(",").map((t) => t.trim()).filter(Boolean);
    } else if (a === "--skip" || a.startsWith("--skip=")) {
      out.skip = value().split(",").map((t) => t.trim()).filter(Boolean);
    } else if (a === "--out-dir" || a.startsWith("--out-dir=")) {
      out.outDir = value();
    } else if (a === "--json" || a.startsWith("--json=")) {
      out.json = value();
    } else {
      console.error(`error: unknown argument ${a}`);
      process.exit(2);
    }
  }
  return out;
}

async function main(): Promise<number> {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));

  if (!process.env.JIRA_BASE_URL) {
    console.error("error: JIRA_BASE_URL is not set (and not found in .mcp.json)");
    return 2;
  }

  console.log(
    `Self-test against ${process.env.JIRA_BASE_URL}  (${ALL_TOOLS.length} tools registered)`,
  );

  const client = new JiraClient();
  const cache = new AutomationCache(client);
  const ctx: ToolContext = { client, cache };

  let report: any;
  try {
    report = await runSelfTest(ctx, { outDir: args.outDir, only: args.only, skip: args.skip });
  } finally {
    await client.close();
  }

  printSummary(report);

  const toolFiles = fs.readdirSync(args.outDir)
    .filter((f) => f.endsWith(".json") && f !== "_report.json");
  console.log(
    `\n  ${toolFiles.length} per-tool output files + _report.json written to ${args.outDir}`,
  );

  if (args.json) {
    fs.writeFileSync(args.json, JSON.stringify(report, null, 2), "utf-8");
    console.log(`  full JSON report also written to ${args.json}`);
  }

  return report.summary.toolsFailed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
