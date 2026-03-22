import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const JIRA_BASE = (() => {
  try {
    return readFileSync(join(__dirname, "..", ".jira-base"), "utf-8").trim();
  } catch {
    return process.env.JIRA_BASE_URL;
  }
})();
const JIRA_TOKEN = (() => {
  try {
    return readFileSync(join(__dirname, "..", ".jira-token"), "utf-8").trim();
  } catch {
    return process.env.JIRA_TOKEN;
  }
})();
const JIRA_BASIC = (() => {
  try {
    return readFileSync(join(__dirname, "..", ".jira-basic"), "utf-8").trim();
  } catch {
    return process.env.JIRA_BASIC_AUTH;
  }
})();

function authHeader(path: string): string {
  // Use Basic auth for standard REST API, Bearer for automation API
  if (JIRA_BASIC && path.startsWith("/rest/api/")) {
    return `Basic ${JIRA_BASIC}`;
  }
  return `Bearer ${JIRA_TOKEN}`;
}

async function jiraGet(path: string) {
  const res = await fetch(`${JIRA_BASE}${path}`, {
    headers: { Authorization: authHeader(path) },
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Jira API returned ${res.status}: ${body.slice(0, 200)}`);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`Jira API returned non-JSON response: ${body.slice(0, 200)}`);
  }
}

async function fetchRules() {
  const res = await fetch(
    `${JIRA_BASE}/rest/cb-automation/latest/project/GLOBAL/rule/export`,
    { headers: { Authorization: `Bearer ${JIRA_TOKEN}` } }
  );
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Jira API returned ${res.status}: ${body.slice(0, 200)}`);
  }
  try {
    return JSON.parse(body).rules;
  } catch {
    throw new Error(`Jira API returned non-JSON response: ${body.slice(0, 200)}`);
  }
}

const server = new McpServer({ name: "jira-automation", version: "1.0.0" });

// Tool 1: list + search
server.tool("list_automations",
  { query: z.string().optional() },
  async ({ query }) => {
    const rules = await fetchRules();
    const filtered = query
      ? rules.filter((r: any) =>
        r.name.toLowerCase().includes(query.toLowerCase()) ||
        r.state.toLowerCase().includes(query.toLowerCase()))
      : rules;
    return {
      content: [{
        type: "text" as const, text: JSON.stringify(
          filtered.map((r: any) => ({ id: r.id, name: r.name, state: r.state }))
        )
      }]
    };
  }
);

// Tool 2: get full rule detail
server.tool("get_automation",
  { id: z.coerce.number() },
  async ({ id }) => {
    const rules = await fetchRules();
    const rule = rules.find((r: any) => r.id === id);
    if (!rule) return { content: [{ type: "text" as const, text: "Not found" }] };
    return { content: [{ type: "text" as const, text: JSON.stringify(rule, null, 2) }] };
  }
);

// Tool 3: list workflow schemes (via project associations, since GET /workflowscheme returns 405)
server.tool("list_workflow_schemes",
  {},
  async () => {
    const projects = await jiraGet("/rest/api/2/project");
    const seen = new Map<number, any>();
    for (const p of (Array.isArray(projects) ? projects : [])) {
      try {
        const ws = await jiraGet(`/rest/api/2/project/${p.key}/workflowscheme`);
        if (ws?.id && !seen.has(ws.id)) {
          seen.set(ws.id, {
            id: ws.id, name: ws.name, description: ws.description,
            defaultWorkflow: ws.defaultWorkflow, projects: [p.key]
          });
        } else if (ws?.id && seen.has(ws.id)) {
          seen.get(ws.id).projects.push(p.key);
        }
      } catch {}
    }
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify([...seen.values()], null, 2)
      }]
    };
  }
);

// Tool 4: get workflow scheme detail
server.tool("get_workflow_scheme",
  { id: z.coerce.number() },
  async ({ id }) => {
    const data = await jiraGet(`/rest/api/2/workflowscheme/${id}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// Tool 5: list issue type schemes
server.tool("list_issuetype_schemes",
  {},
  async () => {
    const data = await jiraGet("/rest/api/2/issuetypescheme");
    const schemes = Array.isArray(data) ? data : data.schemes ?? [data];
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(schemes.map((s: any) => ({
          id: s.id, name: s.name, description: s.description, defaultIssueTypeId: s.defaultIssueTypeId
        })), null, 2)
      }]
    };
  }
);

// Tool 6: get issue type scheme detail
server.tool("get_issuetype_scheme",
  { id: z.coerce.number() },
  async ({ id }) => {
    const data = await jiraGet(`/rest/api/2/issuetypescheme/${id}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// Tool 7: list issue security schemes
server.tool("list_issuesecurity_schemes",
  {},
  async () => {
    const data = await jiraGet("/rest/api/2/issuesecurityschemes");
    const schemes = data.issueSecuritySchemes ?? (Array.isArray(data) ? data : [data]);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(schemes.map((s: any) => ({
          id: s.id, name: s.name, description: s.description, defaultSecurityLevelId: s.defaultSecurityLevelId
        })), null, 2)
      }]
    };
  }
);

// Tool 8: get issue security scheme detail
server.tool("get_issuesecurity_scheme",
  { id: z.coerce.number() },
  async ({ id }) => {
    const data = await jiraGet(`/rest/api/2/issuesecurityschemes/${id}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// Tool 9: list permission schemes
server.tool("list_permission_schemes",
  {},
  async () => {
    const data = await jiraGet("/rest/api/2/permissionscheme");
    const schemes = data.permissionSchemes ?? (Array.isArray(data) ? data : [data]);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(schemes.map((s: any) => ({
          id: s.id, name: s.name, description: s.description
        })), null, 2)
      }]
    };
  }
);

// Tool 10: get permission scheme detail
server.tool("get_permission_scheme",
  { id: z.coerce.number() },
  async ({ id }) => {
    const data = await jiraGet(`/rest/api/2/permissionscheme/${id}?expand=permissions`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// Tool 11: list workflows
server.tool("list_workflows",
  {},
  async () => {
    const data = await jiraGet("/rest/api/2/workflow");
    const workflows = Array.isArray(data) ? data : data.values ?? [data];
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(workflows.map((w: any) => ({
          name: w.name, description: w.description, steps: w.steps?.length ?? 0, isDefault: w.isDefault
        })), null, 2)
      }]
    };
  }
);

// Tool 12: get workflow detail via ScriptRunner XML export
server.tool("get_workflow",
  { name: z.string() },
  async ({ name }) => {
    // Fetch workflow XML from ScriptRunner endpoint
    const res = await fetch(
      `${JIRA_BASE}/rest/scriptrunner/latest/custom/exportWorkflow?workflowName=${encodeURIComponent(name)}`,
      { headers: { Authorization: `Basic ${JIRA_BASIC}` } }
    );
    const xml = await res.text();
    if (!res.ok) {
      throw new Error(`ScriptRunner returned ${res.status}: ${xml.slice(0, 200)}`);
    }

    // Parse XML into structured JSON
    function getAttr(tag: string, attr: string): string {
      const m = tag.match(new RegExp(`${attr}="([^"]*)"`));
      return m ? m[1] : "";
    }

    function parseMeta(block: string): Record<string, string> {
      const meta: Record<string, string> = {};
      for (const m of block.matchAll(/<meta name="([^"]*)">([\s\S]*?)<\/meta>/g)) {
        meta[m[1]] = m[2].trim();
      }
      return meta;
    }

    function parseArgs(block: string): Record<string, string> {
      const args: Record<string, string> = {};
      for (const m of block.matchAll(/<arg name="([^"]*)">([\s\S]*?)<\/arg>/g)) {
        args[m[1]] = m[2].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
      }
      return args;
    }

    function parseFunction(block: string): any {
      const type = getAttr(block, "type");
      const args = parseArgs(block);
      return {
        type,
        className: args["class.name"] || args["full.module.key"] || null,
        args
      };
    }

    function parseFunctions(block: string, tag: string): any[] {
      const results: any[] = [];
      const regex = new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, "g");
      for (const m of block.matchAll(regex)) {
        results.push(parseFunction(m[0]));
      }
      return results;
    }

    function parseConditions(block: string): any {
      // Check for nested conditions
      const condBlockMatch = block.match(/<conditions\s+type="([^"]*)">([\s\S]*?)<\/conditions>/);
      if (condBlockMatch) {
        const type = condBlockMatch[1] === "AND" ? "AND" : "OR";
        const inner = condBlockMatch[2];
        const conditions: any[] = [];
        // Parse individual condition elements
        for (const cm of inner.matchAll(/<condition\s[^>]*type="([^"]*)"[^>]*>([\s\S]*?)<\/condition>/g)) {
          const args = parseArgs(cm[2]);
          conditions.push({
            type: cm[1],
            className: args["class.name"] || null,
            negate: cm[0].includes('negate="true"'),
            args
          });
        }
        // Parse nested conditions groups
        for (const nested of inner.matchAll(/<conditions\s+type="([^"]*)">([\s\S]*?)<\/conditions>/g)) {
          conditions.push(parseConditions(nested[0]));
        }
        return { operator: type, conditions };
      }
      return null;
    }

    function parseRestriction(block: string): any {
      const restrictionMatch = block.match(/<restrict-to>([\s\S]*?)<\/restrict-to>/);
      if (!restrictionMatch) return null;
      return parseConditions(restrictionMatch[1]);
    }

    function parseAction(actionBlock: string): any {
      const id = getAttr(actionBlock, "id");
      const name = getAttr(actionBlock, "name");
      const meta = parseMeta(actionBlock);

      const result: any = {
        id: parseInt(id),
        name,
        screenId: meta["jira.fieldscreen.id"] || null,
        description: meta["jira.description"] || null,
      };

      // Destination
      const urMatch = actionBlock.match(/<unconditional-result[^>]*>/);
      if (urMatch) {
        result.destinationStep = parseInt(getAttr(urMatch[0], "step")) || null;
        result.destinationStatus = getAttr(urMatch[0], "status") || null;
      }

      // Conditions
      const restriction = parseRestriction(actionBlock);
      if (restriction) result.conditions = restriction;

      // Validators
      const validatorsMatch = actionBlock.match(/<validators>([\s\S]*?)<\/validators>/);
      if (validatorsMatch) {
        result.validators = parseFunctions(validatorsMatch[1], "validator");
      }

      // Post-functions
      const postFuncsMatch = actionBlock.match(/<post-functions>([\s\S]*?)<\/post-functions>/);
      if (postFuncsMatch) {
        result.postFunctions = parseFunctions(postFuncsMatch[1], "function");
      }

      // Pre-functions
      const preFuncsMatch = actionBlock.match(/<pre-functions>([\s\S]*?)<\/pre-functions>/);
      if (preFuncsMatch) {
        result.preFunctions = parseFunctions(preFuncsMatch[1], "function");
      }

      return result;
    }

    // Parse steps
    const steps: any[] = [];
    for (const sm of xml.matchAll(/<step\s+id="(\d+)"\s+name="([^"]*)">([\s\S]*?)<\/step>/g)) {
      const stepMeta = parseMeta(sm[3]);
      steps.push({
        id: parseInt(sm[1]),
        name: sm[2],
        statusId: stepMeta["jira.status.id"] || null,
      });
    }

    // Parse initial actions
    const initialActions: any[] = [];
    const initMatch = xml.match(/<initial-actions>([\s\S]*?)<\/initial-actions>/);
    if (initMatch) {
      for (const am of initMatch[1].matchAll(/<action\s[^>]*>([\s\S]*?)<\/action>/g)) {
        initialActions.push(parseAction(am[0]));
      }
    }

    // Parse global actions
    const globalActions: any[] = [];
    const globalMatch = xml.match(/<global-actions>([\s\S]*?)<\/global-actions>/);
    if (globalMatch) {
      for (const am of globalMatch[1].matchAll(/<action\s[^>]*>([\s\S]*?)<\/action>/g)) {
        const action = parseAction(am[0]);
        action.global = true;
        globalActions.push(action);
      }
    }

    // Parse step actions (common actions)
    const stepActions: any[] = [];
    for (const sm of xml.matchAll(/<step\s+id="\d+"[^>]*>([\s\S]*?)<\/step>/g)) {
      const actionsMatch = sm[1].match(/<actions>([\s\S]*?)<\/actions>/);
      if (actionsMatch) {
        for (const am of actionsMatch[1].matchAll(/<action\s[^>]*>([\s\S]*?)<\/action>/g)) {
          stepActions.push(parseAction(am[0]));
        }
      }
    }

    // Deduplicate step actions by id
    const seenIds = new Set<number>();
    const uniqueStepActions = stepActions.filter(a => {
      if (seenIds.has(a.id)) return false;
      seenIds.add(a.id);
      return true;
    });

    const workflowMeta = parseMeta(xml);
    const result = {
      name,
      description: workflowMeta["jira.description"] || "",
      steps,
      initialActions,
      globalActions,
      transitions: uniqueStepActions,
    };

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool 13: list custom fields
server.tool("list_customfields",
  { query: z.string().optional() },
  async ({ query }) => {
    const data = await jiraGet("/rest/api/2/field");
    const fields = (Array.isArray(data) ? data : [data]).filter((f: any) => f.custom);
    const filtered = query
      ? fields.filter((f: any) =>
          f.name.toLowerCase().includes(query.toLowerCase()) ||
          f.id.toLowerCase().includes(query.toLowerCase()))
      : fields;
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(filtered.map((f: any) => ({
          id: f.id, name: f.name, type: f.schema?.type, customType: f.schema?.custom
        })), null, 2)
      }]
    };
  }
);

// Tool 14: get custom field detail
server.tool("get_customfield",
  { id: z.string() },
  async ({ id }) => {
    const data = await jiraGet("/rest/api/2/field");
    const fields = Array.isArray(data) ? data : [data];
    const field = fields.find((f: any) => f.id === id);
    if (!field) return { content: [{ type: "text" as const, text: "Not found" }] };
    return { content: [{ type: "text" as const, text: JSON.stringify(field, null, 2) }] };
  }
);

// Tool 15: get custom field options (for select/multi-select fields)
server.tool("get_customfield_options",
  { id: z.coerce.number() },
  async ({ id }) => {
    const data = await jiraGet(`/rest/api/2/customFieldOption/${id}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// --- Projects ---

// Tool 16: list projects
server.tool("list_projects",
  { query: z.string().optional() },
  async ({ query }) => {
    const data = await jiraGet("/rest/api/2/project?expand=lead");
    const projects = Array.isArray(data) ? data : [data];
    const filtered = query
      ? projects.filter((p: any) =>
          p.key.toLowerCase().includes(query.toLowerCase()) ||
          p.name.toLowerCase().includes(query.toLowerCase()))
      : projects;
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(filtered.map((p: any) => ({
          id: p.id, key: p.key, name: p.name, projectTypeKey: p.projectTypeKey,
          lead: p.lead?.displayName
        })), null, 2)
      }]
    };
  }
);

// Tool 17: get project detail (includes schemes)
server.tool("get_project",
  { key: z.string() },
  async ({ key }) => {
    const data = await jiraGet(`/rest/api/2/project/${encodeURIComponent(key)}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// Tool 18: get project schemes (workflow, issuetype, screen, field config, notification, permission)
server.tool("get_project_schemes",
  { key: z.string() },
  async ({ key }) => {
    const results: Record<string, any> = {};
    const k = encodeURIComponent(key);
    const endpoints: Record<string, string> = {
      workflowScheme: `/rest/api/2/project/${k}/workflowscheme`,
      notificationScheme: `/rest/api/2/project/${k}/notificationscheme`,
      permissionScheme: `/rest/api/2/project/${k}/permissionscheme`,
      issueSecurityScheme: `/rest/api/2/project/${k}/issuesecuritylevelscheme`,
    };
    for (const [name, path] of Object.entries(endpoints)) {
      try {
        results[name] = await jiraGet(path);
      } catch (e: any) {
        results[name] = { error: e.message };
      }
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
  }
);

// --- Issue Types ---

// Tool 19: list issue types
server.tool("list_issuetypes",
  { query: z.string().optional() },
  async ({ query }) => {
    const data = await jiraGet("/rest/api/2/issuetype");
    const types = Array.isArray(data) ? data : [data];
    const filtered = query
      ? types.filter((t: any) =>
          t.name.toLowerCase().includes(query.toLowerCase()))
      : types;
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(filtered.map((t: any) => ({
          id: t.id, name: t.name, subtask: t.subtask, description: t.description
        })), null, 2)
      }]
    };
  }
);

// --- Statuses ---

// Tool 20: list statuses
server.tool("list_statuses",
  { query: z.string().optional() },
  async ({ query }) => {
    const data = await jiraGet("/rest/api/2/status");
    const statuses = Array.isArray(data) ? data : [data];
    const filtered = query
      ? statuses.filter((s: any) =>
          s.name.toLowerCase().includes(query.toLowerCase()))
      : statuses;
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(filtered.map((s: any) => ({
          id: s.id, name: s.name, category: s.statusCategory?.name
        })), null, 2)
      }]
    };
  }
);

// --- Screens ---

// Tool 21: list screens
server.tool("list_screens",
  { query: z.string().optional() },
  async ({ query }) => {
    const data = await jiraGet("/rest/api/2/screens?expand=fieldScreenSchemes");
    const screens = Array.isArray(data) ? data : data.values ?? [data];
    const filtered = query
      ? screens.filter((s: any) =>
          s.name?.toLowerCase().includes(query.toLowerCase()))
      : screens;
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(filtered.map((s: any) => ({
          id: s.id, name: s.name, description: s.description,
          screenSchemes: s.fieldScreenSchemes?.map((ss: any) => ({ id: ss.id, name: ss.name })) ?? []
        })), null, 2)
      }]
    };
  }
);

// Tool 22: get screen tabs and fields
server.tool("get_screen",
  { id: z.coerce.number() },
  async ({ id }) => {
    const tabs = await jiraGet(`/rest/api/2/screens/${id}/tabs`);
    const tabsArr = Array.isArray(tabs) ? tabs : [tabs];
    const result: any[] = [];
    for (const tab of tabsArr) {
      const fields = await jiraGet(`/rest/api/2/screens/${id}/tabs/${tab.id}/fields`);
      result.push({
        tabId: tab.id,
        tabName: tab.name,
        fields: (Array.isArray(fields) ? fields : [fields]).map((f: any) => ({
          id: f.id, name: f.name
        }))
      });
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// --- Field Configurations ---
// Note: /rest/api/2/screenscheme, /rest/api/2/fieldconfiguration are 404 on this DC version (10.3.12)
// Screen schemes and field configs are accessible per-screen and per-project instead

// --- Notification Schemes ---

// Tool 26: list notification schemes
server.tool("list_notification_schemes",
  {},
  async () => {
    const data = await jiraGet("/rest/api/2/notificationscheme");
    const schemes = Array.isArray(data) ? data : data.values ?? [data];
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(schemes.map((s: any) => ({
          id: s.id, name: s.name, description: s.description
        })), null, 2)
      }]
    };
  }
);

// Tool 27: get notification scheme detail
server.tool("get_notification_scheme",
  { id: z.coerce.number() },
  async ({ id }) => {
    const data = await jiraGet(`/rest/api/2/notificationscheme/${id}?expand=all`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// --- Resolutions & Priorities ---

// Tool 28: list resolutions
server.tool("list_resolutions",
  {},
  async () => {
    const data = await jiraGet("/rest/api/2/resolution");
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// Tool 29: list priorities
server.tool("list_priorities",
  {},
  async () => {
    const data = await jiraGet("/rest/api/2/priority");
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// --- Project Roles ---

// Tool 30: list project roles
server.tool("list_roles",
  {},
  async () => {
    const data = await jiraGet("/rest/api/2/role");
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// Tool 31: get project role members for a project
server.tool("get_project_role",
  { projectKey: z.string(), roleId: z.coerce.number() },
  async ({ projectKey, roleId }) => {
    const data = await jiraGet(`/rest/api/2/project/${encodeURIComponent(projectKey)}/role/${roleId}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// Tool 32: list ScriptRunner scripts (workflows, listeners, REST endpoints, behaviours, etc.)
server.tool("list_scriptrunner_scripts",
  { category: z.enum(["workflows", "listeners", "fields", "endpoints", "behaviours", "fragments", "jobs"]).optional() },
  async ({ category }) => {
    const res = await fetch(
      `${JIRA_BASE}/rest/scriptrunner/latest/canned/com.onresolve.scriptrunner.canned.jira.admin.ScriptRegistry`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${JIRA_BASIC}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      }
    );
    const body = await res.text();
    if (!res.ok) {
      throw new Error(`ScriptRunner returned ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = JSON.parse(body);
    const scripts = data.output?.scripts ?? {};
    if (category) {
      return { content: [{ type: "text" as const, text: JSON.stringify(scripts[category] ?? [], null, 2) }] };
    }
    // Return summary of all categories
    const summary: Record<string, number> = {};
    for (const [k, v] of Object.entries(scripts)) {
      summary[k] = Array.isArray(v) ? v.length : 0;
    }
    return { content: [{ type: "text" as const, text: JSON.stringify({ categories: data.output?.tabs, counts: summary, scripts }, null, 2) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
