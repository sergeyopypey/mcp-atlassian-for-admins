/**
 * OpenSymphony workflow XML parser — port of the helpers in `tools/workflows.py`.
 *
 * Parses a workflow descriptor (as exported by the jiraMcpExportWorkflow
 * ScriptRunner endpoint) into a structured object: steps, their transitions
 * (actions), and conditions / validators / pre- and post-functions.
 */

import { DOMParser } from "@xmldom/xmldom";

// Minimal structural typing for the @xmldom/xmldom node we traverse.
interface XmlNode {
  nodeType: number;
  nodeName: string;
  childNodes: { length: number; item(i: number): XmlNode | null } | ArrayLike<XmlNode>;
  textContent?: string | null;
  getAttribute?(name: string): string | null;
  hasAttribute?(name: string): boolean;
}

const ELEMENT_NODE = 1;

function childNodeArray(node: XmlNode): XmlNode[] {
  const cn = node.childNodes as ArrayLike<XmlNode>;
  const out: XmlNode[] = [];
  for (let i = 0; i < cn.length; i++) {
    const c = cn[i] ?? (node.childNodes as any).item?.(i);
    if (c) out.push(c as XmlNode);
  }
  return out;
}

/** Direct child elements with the given tag name. */
function children(node: XmlNode, tag: string): XmlNode[] {
  return childNodeArray(node).filter((c) => c.nodeType === ELEMENT_NODE && c.nodeName === tag);
}

/** First direct child element with the given tag name, or null. */
function firstChild(node: XmlNode, tag: string): XmlNode | null {
  return children(node, tag)[0] ?? null;
}

/** All descendant elements (any depth) with the given tag name. */
function descendants(node: XmlNode, tag: string): XmlNode[] {
  const out: XmlNode[] = [];
  for (const c of childNodeArray(node)) {
    if (c.nodeType !== ELEMENT_NODE) continue;
    if (c.nodeName === tag) out.push(c);
    out.push(...descendants(c, tag));
  }
  return out;
}

/** Descendant elements named `parentTag` whose direct child is named `childTag`. */
function descendantPath(node: XmlNode, parentTag: string, childTag: string): XmlNode[] {
  return descendants(node, parentTag).flatMap((p) => children(p, childTag));
}

function attr(node: XmlNode, name: string, def = ""): string {
  if (node.hasAttribute?.(name)) return node.getAttribute?.(name) ?? def;
  return def;
}

function intAttr(node: XmlNode, name: string): number {
  const raw = attr(node, name, "0");
  const n = parseInt(raw || "0", 10);
  return Number.isNaN(n) ? 0 : n;
}

function elementText(node: XmlNode): string {
  return node.textContent ?? "";
}

// Map of known Jira/plugin class names to readable short names.
const KNOWN_CLASSES: Record<string, string> = {
  "com.atlassian.jira.workflow.condition.AllowOnlyAssignee": "OnlyAssignee",
  "com.atlassian.jira.workflow.condition.AllowOnlyReporter": "OnlyReporter",
  "com.atlassian.jira.workflow.condition.PermissionCondition": "HasPermission",
  "com.atlassian.jira.workflow.condition.SubTaskBlockingCondition": "SubTaskBlocking",
  "com.atlassian.jira.workflow.function.issue.UpdateIssueStatusFunction": "UpdateStatus",
  "com.atlassian.jira.workflow.function.issue.UpdateIssueFieldFunction": "UpdateField",
  "com.atlassian.jira.workflow.function.issue.AssignToCurrentUserFunction": "AssignToCurrentUser",
  "com.atlassian.jira.workflow.function.issue.AssignToLeadFunction": "AssignToLead",
  "com.atlassian.jira.workflow.function.issue.AssignToReporterFunction": "AssignToReporter",
  "com.atlassian.jira.workflow.function.misc.CreateCommentFunction": "CreateComment",
  "com.atlassian.jira.workflow.function.event.FireIssueEventFunction": "FireEvent",
  "com.atlassian.jira.workflow.function.issue.GenerateChangeHistoryFunction":
    "GenerateChangeHistory",
  "com.atlassian.jira.workflow.function.issue.IssueReindexFunction": "ReindexIssue",
  "com.atlassian.jira.workflow.function.issue.IssueCreateFunction": "CreateIssue",
  "com.atlassian.jira.workflow.function.issue.IssueStoreFunction": "StoreIssue",
  "com.atlassian.jira.workflow.validator.PermissionValidator": "PermissionValidator",
  "com.atlassian.jira.workflow.validator.UserPermissionValidator": "UserPermissionValidator",
  "com.atlassian.jira.workflow.validator.FieldRequiredValidator": "FieldRequired",
  "com.atlassian.servicedesk.plugins.automation.action.AutomationRuleInvokerFunction":
    "JSM_AutomationInvoker",
  "com.atlassian.servicedesk.internal.feature.approval.ApprovalFunction": "JSM_Approval",
};

/** Simplify a Java class name to a readable short name. */
function simplifyClass(className: string): string {
  if (className in KNOWN_CLASSES) return KNOWN_CLASSES[className];
  if (className.includes(".")) return className.slice(className.lastIndexOf(".") + 1);
  return className;
}

// ScriptRunner stores some `<arg>` values base64-encoded, prefixed with a
// `` `!` `` magic marker followed by a JSON payload `{script, scriptPath, …}`.
// The base64 of that marker is the literal "YCFg" — a cheap pre-filter.
const SR_BLOB_PREFIX = "YCFg";
const SR_BLOB_MAGIC = "`!`";

/**
 * Decode a ScriptRunner base64 arg value to readable text.
 *
 * Returns the inline Groovy script, a `scriptPath: …` reference, or the
 * decoded plain text. Any value that is not a recognised blob is returned
 * unchanged, so this is safe to apply to every arg.
 */
function decodeScriptRunnerValue(value: string): string {
  if (!value.startsWith(SR_BLOB_PREFIX)) return value;

  let decoded: string;
  try {
    decoded = Buffer.from(value, "base64").toString("utf8");
  } catch {
    return value;
  }
  if (!decoded.startsWith(SR_BLOB_MAGIC)) return value;

  const payload = decoded.slice(SR_BLOB_MAGIC.length);
  if (!payload.trimStart().startsWith("{")) return payload; // plain text (e.g. a description)

  try {
    const obj = JSON.parse(payload.trimStart()) as {
      script?: string | null;
      scriptPath?: string | null;
    };
    if (obj.script) return obj.script;
    if (obj.scriptPath) return `scriptPath: ${obj.scriptPath}`;
    return payload;
  } catch {
    return payload;
  }
}

/** Read `<arg name="...">value</arg>` children into an ordered plain object. */
function readArgs(node: XmlNode): Record<string, string> {
  const args: Record<string, string> = {};
  for (const a of children(node, "arg")) {
    args[attr(a, "name")] = decodeScriptRunnerValue(elementText(a));
  }
  return args;
}

function pop(obj: Record<string, string>, key: string, def: string): string {
  const has = Object.prototype.hasOwnProperty.call(obj, key);
  const val = has ? obj[key] : def;
  if (has) delete obj[key];
  return val;
}

function hasKeys(obj: Record<string, unknown>): boolean {
  return Object.keys(obj).length > 0;
}

/**
 * Readable type plus, for classes outside KNOWN_CLASSES, the full class name —
 * the short name alone is ambiguous across apps (JMWE and Jira both ship a
 * `FieldRequiredValidator`) and hides which app provides the rule.
 */
function classInfo(className: string): { type: string; className?: string } {
  const type = simplifyClass(className);
  return type === className || className in KNOWN_CLASSES ? { type } : { type, className };
}

/** Read `<meta name="...">value</meta>` children, minus keys already surfaced elsewhere. */
function readMeta(node: XmlNode, skip: string[] = []): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const m of children(node, "meta")) {
    const name = attr(m, "name");
    if (!skip.includes(name)) meta[name] = elementText(m);
  }
  return meta;
}

type Condition = {
  type: string;
  className?: string;
  negate?: true;
  args?: Record<string, string>;
};
type ConditionBlock = Condition | { operator: string; items: Array<Condition | ConditionBlock> };

/** Recursively parse a conditions block (AND/OR with nesting). */
function parseConditionBlock(condEl: XmlNode): ConditionBlock | null {
  const condType = attr(condEl, "type", "AND");
  const items: Array<Condition | ConditionBlock> = [];

  for (const c of children(condEl, "condition")) {
    const funcType = attr(c, "type");
    const negate = attr(c, "negate", "false").toLowerCase() === "true";
    const args = readArgs(c);
    const entry: Condition = classInfo(pop(args, "class.name", funcType));
    if (negate) entry.negate = true;
    if (hasKeys(args)) entry.args = args;
    items.push(entry);
  }

  for (const nested of children(condEl, "conditions")) {
    const nestedParsed = parseConditionBlock(nested);
    if (nestedParsed) items.push(nestedParsed);
  }

  if (items.length === 0) return null;
  if (items.length === 1) return items[0];
  return { operator: condType, items };
}

function parseConditions(restrictEl: XmlNode | null): ConditionBlock | null {
  if (!restrictEl) return null;
  const conditionsEl = firstChild(restrictEl, "conditions");
  if (!conditionsEl) return null;
  return parseConditionBlock(conditionsEl);
}

interface FunctionEntry {
  type: string;
  className?: string;
  args?: Record<string, string>;
}

/** Parse validator or function elements under `parentTag/childTag`. */
function parseFunctions(parent: XmlNode, parentTag: string, childTag: string): FunctionEntry[] {
  const result: FunctionEntry[] = [];
  for (const func of descendantPath(parent, parentTag, childTag)) {
    const funcType = attr(func, "type");
    const args = readArgs(func);
    const className = pop(args, "class.name", funcType);
    const entry: FunctionEntry = classInfo(className);
    if (hasKeys(args)) {
      delete args["full.module.key"];
      if (hasKeys(args)) entry.args = args;
    }
    result.push(entry);
  }
  return result;
}

export interface ActionEntry {
  id: number;
  name: string;
  from: string;
  to: string | null;
  screenId?: string;
  meta?: Record<string, string>;
  conditions?: ConditionBlock;
  validators?: FunctionEntry[];
  preFunctions?: FunctionEntry[];
  postFunctions?: FunctionEntry[];
}

/** Target of a `step="-1"` result: the issue stays in its current status. */
const CURRENT_STATUS = "(current status)";

/** Parse a single action (transition) element. */
function parseAction(actionEl: XmlNode, fromStep: string, stepMap: Map<number, string>): ActionEntry {
  const actionId = intAttr(actionEl, "id");
  const actionName = attr(actionEl, "name");

  const results = [
    ...descendants(actionEl, "unconditional-result"),
    ...descendants(actionEl, "default-result"),
  ];
  let targetStatus: string | null = null;
  for (const r of results) {
    const stepIdStr = r.hasAttribute?.("step") ? r.getAttribute?.("step") : null;
    if (stepIdStr) {
      const stepIdInt = parseInt(stepIdStr, 10);
      // step="-1" keeps the issue in the status it is transitioned from.
      targetStatus =
        stepIdInt === -1
          ? CURRENT_STATUS
          : (stepMap.get(stepIdInt) ?? `step-${stepIdStr}`);
      break;
    }
  }

  const screenId = children(actionEl, "meta").find(
    (m) => attr(m, "name") === "jira.fieldscreen.id",
  );
  const actionMeta = readMeta(actionEl, ["jira.fieldscreen.id"]);

  const entry: ActionEntry = {
    id: actionId,
    name: actionName,
    from: fromStep,
    to: targetStatus,
  };

  if (screenId && elementText(screenId)) entry.screenId = elementText(screenId);
  if (hasKeys(actionMeta)) entry.meta = actionMeta;

  const conditions = parseConditions(firstChild(actionEl, "restrict-to"));
  if (conditions) entry.conditions = conditions;

  const validators = parseFunctions(actionEl, "validators", "validator");
  if (validators.length > 0) entry.validators = validators;

  const preFunctions = parseFunctions(actionEl, "pre-functions", "function");
  if (preFunctions.length > 0) entry.preFunctions = preFunctions;

  const postFunctions = parseFunctions(actionEl, "post-functions", "function");
  if (postFunctions.length > 0) entry.postFunctions = postFunctions;

  return entry;
}

export interface ParsedWorkflow {
  meta?: Record<string, string>;
  steps: Array<{
    id: number;
    name: string;
    statusId: string | null;
    meta?: Record<string, string>;
    actions?: ActionEntry[];
  }>;
  initialActions?: ActionEntry[];
  globalActions?: ActionEntry[];
  [k: string]: unknown;
}

/** Parse an OpenSymphony workflow XML descriptor into a structured object. */
export function parseWorkflowXml(xmlStr: string): ParsedWorkflow {
  const doc = new DOMParser().parseFromString(xmlStr, "text/xml") as unknown as {
    documentElement: XmlNode | null;
  };
  const root = doc.documentElement;
  if (!root) throw new Error("Failed to parse workflow XML");

  // common-action lookup: id → action element.
  const commonActionMap = new Map<string, XmlNode>();
  for (const ca of descendantPath(root, "common-actions", "action")) {
    const aid = ca.hasAttribute?.("id") ? ca.getAttribute?.("id") : null;
    if (aid) commonActionMap.set(aid, ca);
  }

  // First pass: step id → step name.
  const stepMap = new Map<number, string>();
  for (const step of descendants(root, "step")) {
    stepMap.set(intAttr(step, "id"), attr(step, "name"));
  }

  // Second pass: parse steps with inline and common-action transitions.
  const steps: ParsedWorkflow["steps"] = [];
  for (const step of descendants(root, "step")) {
    const stepId = intAttr(step, "id");
    const stepName = attr(step, "name");

    const statusId = children(step, "meta").find((m) => attr(m, "name") === "jira.status.id");
    // Status properties such as jira.permission.* and jira.issue.editable.
    const stepMeta = readMeta(step, ["jira.status.id"]);

    const stepEntry: ParsedWorkflow["steps"][number] = {
      id: stepId,
      name: stepName,
      statusId: statusId ? elementText(statusId) : null,
    };
    if (hasKeys(stepMeta)) stepEntry.meta = stepMeta;

    const actions: ActionEntry[] = [];
    for (const action of descendants(step, "action")) {
      actions.push(parseAction(action, stepName, stepMap));
    }
    for (const caRef of descendants(step, "common-action")) {
      const caId = caRef.hasAttribute?.("id") ? caRef.getAttribute?.("id") : null;
      if (caId && commonActionMap.has(caId)) {
        actions.push(parseAction(commonActionMap.get(caId)!, stepName, stepMap));
      }
    }

    if (actions.length > 0) stepEntry.actions = actions;
    steps.push(stepEntry);
  }

  const initialActions: ActionEntry[] = descendantPath(root, "initial-actions", "action").map(
    (a) => parseAction(a, "(initial)", stepMap),
  );
  const globalActions: ActionEntry[] = descendantPath(root, "global-actions", "action").map(
    (a) => parseAction(a, "(global)", stepMap),
  );

  const result: ParsedWorkflow = { steps };
  const workflowMeta = readMeta(root);
  if (hasKeys(workflowMeta)) result.meta = workflowMeta;
  if (initialActions.length > 0) result.initialActions = initialActions;
  if (globalActions.length > 0) result.globalActions = globalActions;
  return result;
}
