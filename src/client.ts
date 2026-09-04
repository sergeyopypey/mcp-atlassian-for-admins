/**
 * Jira Data Center 10 REST API client.
 *
 * Covers REST API v2, Automation for Jira (A4J / cb-automation) and the
 * ScriptRunner custom endpoints. Port of the Python `client.py`.
 */

import { Agent, fetch } from "undici";

/** The options bag accepted by undici's `fetch` (includes `dispatcher`). */
type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;
import { loadConfig, type JiraConfig } from "./config.js";
import { HttpStatusError, isHttpStatusError } from "./errors.js";

const PAGINATION_MAX = 1000; // safety cap so we never loop forever
const MAX_CONCURRENCY = 10; // cap parallel requests; DC returns 403 above ~50 rapid concurrent
const REQUEST_TIMEOUT_MS = 60_000;

// Assets (Insight) lives on the same DC host as Jira. The original
// `/rest/insight/1.0` path works on every bundled version (JSM DC 4.15+); the
// newer `/rest/assets/1.0` alias is identical by suffix. Default to insight for
// the widest compatibility; override via ASSETS_API_BASE when needed.
const INSIGHT_BASE = (process.env.ASSETS_API_BASE ?? "/rest/insight/1.0").replace(/\/+$/, "");
const IQL_PAGE_SIZE = 50; // Insight default is 25; bump for fewer round-trips

// UPM (plugin manager) only emits its own `application/vnd.atl.plugins.*+json`
// media types; the client's default `Accept: application/json` gets a 406.
const UPM_ACCEPT = { Accept: "*/*" };

/** JSON value shorthand — Jira responses are untyped at the boundary. */
type Json = any;

/** Query params; `null`/`undefined` values are dropped, matching httpx. */
type Params = Record<string, string | number | boolean | null | undefined> | undefined;

/**
 * Run thunks with at most `limit` in flight; results in input order.
 *
 * Takes thunks (not promises) because a JS promise begins executing the moment
 * it is created — a semaphore over already-created promises would bound nothing.
 */
export async function boundedAll<T>(
  thunks: Array<() => Promise<T>>,
  limit = MAX_CONCURRENCY,
): Promise<T[]> {
  const results = new Array<T>(thunks.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= thunks.length) return;
      results[i] = await thunks[i]();
    }
  }

  const workers = Array.from({ length: Math.min(limit, thunks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Accumulate `page`/`resultPerPage`-style results until the reported total is
 * reached, a page comes back empty, or the safety cap trips. Pure over the
 * page-fetcher so it is unit-testable without a network. Insight/Assets paginate
 * this way (not Jira's `startAt`/`maxResults`), so `getPaged` cannot be reused.
 */
export async function collectPagedEntries<T>(
  fetchPage: (page: number) => Promise<{ entries: T[]; total: number }>,
  opts: { maxResults?: number } = {},
): Promise<T[]> {
  const results: T[] = [];
  for (let page = 1; page <= PAGINATION_MAX; page++) {
    const { entries, total } = await fetchPage(page);
    results.push(...entries);
    if (entries.length === 0) break;
    if (results.length >= total) break;
    if (opts.maxResults !== undefined && results.length >= opts.maxResults) break;
  }
  return opts.maxResults !== undefined ? results.slice(0, opts.maxResults) : results;
}

function buildQuery(params: Params): string {
  if (!params) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined) continue;
    sp.append(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/** Returns true for Jira user key format (e.g. JIRAUSER10000). */
export function isUserKey(input: string): boolean {
  return /^JIRAUSER\d+$/i.test(input);
}

export class JiraClient {
  private readonly config: JiraConfig;
  private readonly agent: Agent;

  constructor(config: JiraConfig = loadConfig()) {
    this.config = config;
    this.agent = new Agent({
      keepAliveTimeout: 30_000,
      connect: { rejectUnauthorized: config.verifySsl },
    });
  }

  async close(): Promise<void> {
    await this.agent.close();
  }

  // -- low-level ----------------------------------------------------------

  private async request(
    method: string,
    path: string,
    opts: { params?: Params; json?: Json; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; text: string }> {
    const url = this.config.baseUrl + path + buildQuery(opts.params);
    const init: FetchInit = {
      method,
      headers: opts.headers ? { ...this.config.headers, ...opts.headers } : this.config.headers,
      dispatcher: this.agent,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    };
    if (opts.json !== undefined) init.body = JSON.stringify(opts.json);
    const res = await fetch(url, init);
    const text = await res.text();
    return { status: res.status, text };
  }

  private parse(text: string): Json {
    return text.length > 0 ? JSON.parse(text) : undefined;
  }

  async get(path: string, params?: Params, headers?: Record<string, string>): Promise<Json> {
    const { status, text } = await this.request("GET", path, { params, headers });
    if (status >= 400) throw new HttpStatusError(status, text, this.config.baseUrl + path);
    return this.parse(text);
  }

  async post(path: string, json?: Json): Promise<Json> {
    const { status, text } = await this.request("POST", path, { json });
    if (status >= 400) throw new HttpStatusError(status, text, this.config.baseUrl + path);
    return this.parse(text);
  }

  async put(path: string, json?: Json): Promise<Json> {
    const { status, text } = await this.request("PUT", path, { json });
    if (status >= 400) throw new HttpStatusError(status, text, this.config.baseUrl + path);
    return this.parse(text);
  }

  async delete(path: string): Promise<void> {
    const { status, text } = await this.request("DELETE", path);
    if (status >= 400) throw new HttpStatusError(status, text, this.config.baseUrl + path);
  }

  /** Auto-paginate endpoints that return `{startAt, maxResults, total, <key>}`. */
  async getPaged(
    path: string,
    key = "values",
    params: Params = {},
    pageSize = 50,
  ): Promise<Json[]> {
    const results: Json[] = [];
    let start = 0;
    for (let i = 0; i < PAGINATION_MAX; i++) {
      const data = await this.get(path, { ...params, startAt: start, maxResults: pageSize });
      const batch: Json[] = (data && data[key]) || [];
      results.push(...batch);
      const total: number = data && data.total !== undefined ? data.total : results.length;
      if (results.length >= total || batch.length === 0) break;
      start += batch.length;
    }
    return results;
  }

  /**
   * GET a ScriptRunner custom REST endpoint and return parsed JSON.
   * Raises loudly (status + body) on any failure — never silently degraded.
   */
  private async scriptrunnerGet(endpoint: string, params?: Params): Promise<Json> {
    const { status, text } = await this.request(
      "GET",
      `/rest/scriptrunner/latest/custom/${endpoint}`,
      { params },
    );
    if (status >= 400) {
      const body = (text || "").split(/\s+/).join(" ").slice(0, 300);
      throw new Error(`ScriptRunner endpoint /${endpoint} returned HTTP ${status}: ${body}`);
    }
    return this.parse(text);
  }

  /**
   * GET a binary response (no JSON/text decoding). The normal request path
   * reads `res.text()`, which mangles binary payloads such as zip archives.
   */
  async getBytes(path: string, params?: Params): Promise<Buffer> {
    const url = this.config.baseUrl + path + buildQuery(params);
    // The default `Accept: application/json` makes binary endpoints answer 406
    // (e.g. ScriptRunner's zip export); accept anything for raw downloads.
    const res = await fetch(url, {
      method: "GET",
      headers: { ...this.config.headers, Accept: "*/*" },
      dispatcher: this.agent,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status >= 400) {
      throw new HttpStatusError(res.status, await res.text(), url);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * Download ScriptRunner's "Export all scripts" bundle as a zip Buffer.
   *
   * This is the same endpoint the script-registry admin page calls; a PAT
   * (admin) is sufficient — no WebSudo. `isActive=false` exports everything
   * (the "Export all scripts" button); `isActive=true` is "Export active
   * scripts only".
   */
  async exportScriptRegistryZip(activeOnly = false): Promise<Buffer> {
    return this.getBytes("/rest/scriptrunner/latest/script/export", { isActive: activeOnly });
  }

  // ======================================================================
  // REST API v2 — read operations
  // ======================================================================

  async serverInfo(): Promise<Json> {
    return this.get("/rest/api/2/serverInfo");
  }

  async configuration(): Promise<Json> {
    return this.get("/rest/api/2/configuration");
  }

  // -- projects -----------------------------------------------------------

  async listProjects(expand = "description,lead,url,projectKeys"): Promise<Json[]> {
    return this.get("/rest/api/2/project", { expand });
  }

  async getProject(
    key: string,
    expand = "description,lead,url,issueTypes,projectKeys",
  ): Promise<Json> {
    return this.get(`/rest/api/2/project/${encodeURIComponent(key)}`, { expand });
  }

  async getProjectComponents(key: string): Promise<Json[]> {
    return this.get(`/rest/api/2/project/${encodeURIComponent(key)}/components`);
  }

  async getProjectVersions(key: string): Promise<Json[]> {
    return this.get(`/rest/api/2/project/${encodeURIComponent(key)}/versions`);
  }

  async getProjectRoles(key: string): Promise<Json> {
    return this.get(`/rest/api/2/project/${encodeURIComponent(key)}/role`);
  }

  async getProjectRoleActors(key: string, roleId: number): Promise<Json> {
    return this.get(`/rest/api/2/project/${encodeURIComponent(key)}/role/${roleId}`);
  }

  // -- global config ------------------------------------------------------

  async listIssueTypes(): Promise<Json[]> {
    return this.get("/rest/api/2/issuetype");
  }

  async listStatuses(): Promise<Json[]> {
    return this.get("/rest/api/2/status");
  }

  async listResolutions(): Promise<Json[]> {
    return this.get("/rest/api/2/resolution");
  }

  async listPriorities(): Promise<Json[]> {
    return this.get("/rest/api/2/priority");
  }

  async listFields(): Promise<Json[]> {
    return this.get("/rest/api/2/field");
  }

  /** Jira DC 10 endpoint with per-field usage stats (server-side paging is broken). */
  async listCustomFieldsUsage(maxResults = 1000): Promise<Json> {
    return this.get("/rest/api/2/customFields", {
      startAt: 0,
      maxResults: Math.min(maxResults, 1000),
    });
  }

  async listIssueLinkTypes(): Promise<Json[]> {
    const data = await this.get("/rest/api/2/issueLinkType");
    return data?.issueLinkTypes ?? [];
  }

  // ======================================================================
  // Workflows
  // ======================================================================

  async listWorkflows(): Promise<Json[]> {
    return this.get("/rest/api/2/workflow");
  }

  async getWorkflowByName(name: string): Promise<Json | null> {
    const workflows = await this.listWorkflows();
    for (const wf of workflows) {
      if (wf?.name === name) return wf;
    }
    return null;
  }

  async getWorkflowTransitions(workflowId: string | number): Promise<Json[]> {
    try {
      return await this.get(`/rest/api/2/workflow/${workflowId}/transitions`);
    } catch (e) {
      if (isHttpStatusError(e)) return [];
      throw e;
    }
  }

  async getWorkflowDesigner(workflowName: string): Promise<Json | null> {
    try {
      return await this.get("/rest/workflowDesigner/latest/workflows", { name: workflowName });
    } catch (e) {
      if (isHttpStatusError(e)) return null;
      throw e;
    }
  }

  /** Export a workflow as raw XML via a ScriptRunner custom endpoint. */
  /**
   * Fetch a workflow's XML descriptor (null on a network failure or an empty
   * body). Throws HttpStatusError on an error status, with a message naming
   * the cause: 401/403 means the token's user lacks the Jira Administrators
   * global permission the endpoint requires.
   */
  async exportWorkflowXml(workflowName: string): Promise<string | null> {
    let res: { status: number; text: string };
    try {
      res = await this.request(
        "GET",
        "/rest/scriptrunner/latest/custom/jiraMcpExportWorkflow",
        { params: { workflowName } },
      );
    } catch {
      return null;
    }
    if (res.status >= 400) {
      const cause =
        res.status === 401 || res.status === 403
          ? "the token's user lacks the Jira Administrators global permission the endpoint requires"
          : (res.text || "").split(/\s+/).join(" ").slice(0, 200);
      throw new HttpStatusError(
        res.status,
        res.text,
        "/rest/scriptrunner/latest/custom/jiraMcpExportWorkflow",
        `jiraMcpExportWorkflow returned HTTP ${res.status}: ${cause}`,
      );
    }
    return res.text.length > 0 ? res.text : null;
  }

  async getProjectStatuses(projectKey: string): Promise<Json[]> {
    return this.get(`/rest/api/2/project/${encodeURIComponent(projectKey)}/statuses`);
  }

  async listJsmServiceDesks(): Promise<Json[]> {
    try {
      const data = await this.get("/rest/servicedeskapi/servicedesk");
      return data?.values ?? [];
    } catch (e) {
      if (isHttpStatusError(e)) return [];
      throw e;
    }
  }

  // -- createmeta / editmeta ----------------------------------------------

  async getCreatemetaFields(projectKey: string, issueTypeId: string): Promise<Json[]> {
    return this.getPaged(
      `/rest/api/2/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${issueTypeId}`,
      "values",
    );
  }

  async getEditmeta(issueKey: string): Promise<Json> {
    const data = await this.get(`/rest/api/2/issue/${encodeURIComponent(issueKey)}/editmeta`);
    return data?.fields ?? {};
  }

  // -- custom field contexts (ScriptRunner) -------------------------------

  async listCustomFieldContexts(fieldId?: string): Promise<Json[]> {
    const data = await this.scriptrunnerGet(
      "jiraMcpCustomFieldContexts",
      fieldId ? { fieldId } : undefined,
    );
    return data && typeof data === "object" ? (data.fields ?? []) : [];
  }

  // ======================================================================
  // Schemes
  // ======================================================================

  async listWorkflowSchemes(): Promise<Json[]> {
    // Try paginated GET first (works on some DC 10.x patch levels).
    try {
      return await this.getPaged("/rest/api/2/workflowscheme", "values");
    } catch (e) {
      if (!isHttpStatusError(e) || e.status !== 405) throw e;
    }
    // Fallback: discover scheme IDs from project associations, then fetch each.
    let projects: Json[];
    try {
      projects = await this.listProjects("");
    } catch {
      projects = [];
    }

    const projectSchemeId = async (projectKey: string): Promise<number | null> => {
      try {
        const data = await this.get(`/rest/api/2/project/${projectKey}/workflowscheme`);
        if (data && typeof data === "object" && data.id) return Number(data.id);
        return null;
      } catch (e) {
        if (isHttpStatusError(e)) return null;
        throw e;
      }
    };

    const ids = await boundedAll(projects.map((p) => () => projectSchemeId(p.key)));
    const schemeIds = [...new Set(ids.filter((s): s is number => s !== null))].sort(
      (a, b) => a - b,
    );

    const fetchScheme = async (schemeId: number): Promise<Json | null> => {
      try {
        return await this.get(`/rest/api/2/workflowscheme/${schemeId}`);
      } catch (e) {
        if (isHttpStatusError(e)) return null;
        throw e;
      }
    };

    const fetched = await boundedAll(schemeIds.map((sid) => () => fetchScheme(sid)));
    return fetched.filter((s) => s !== null);
  }

  async getWorkflowScheme(schemeId: number): Promise<Json> {
    return this.get(`/rest/api/2/workflowscheme/${schemeId}`);
  }

  async listIssueTypeSchemes(): Promise<Json[]> {
    const data = await this.get("/rest/api/2/issuetypescheme");
    return data && typeof data === "object" && !Array.isArray(data)
      ? (data.schemes ?? [])
      : data;
  }

  async getIssueTypeScheme(schemeId: number): Promise<Json> {
    return this.get(`/rest/api/2/issuetypescheme/${schemeId}`, {
      expand: "issueTypes,defaultIssueType",
    });
  }

  // -- issue type screen schemes (ScriptRunner) ---------------------------

  async listIssueTypeScreenSchemes(): Promise<Json[]> {
    const data = await this.scriptrunnerGet("jiraMcpIssueTypeScreenSchemes");
    return data && typeof data === "object" ? (data.issueTypeScreenSchemes ?? []) : [];
  }

  async getIssueTypeScreenScheme(schemeId: number): Promise<Json | null> {
    const data = await this.scriptrunnerGet("jiraMcpIssueTypeScreenSchemes", { id: schemeId });
    const schemes =
      data && typeof data === "object" ? (data.issueTypeScreenSchemes ?? []) : [];
    return schemes.length > 0 ? schemes[0] : null;
  }

  // -- screen schemes (ScriptRunner) --------------------------------------

  async listScreenSchemes(): Promise<Json[]> {
    const data = await this.scriptrunnerGet("jiraMcpScreenSchemes");
    return data && typeof data === "object" ? (data.screenSchemes ?? []) : [];
  }

  async getScreenScheme(schemeId: number): Promise<Json | null> {
    const data = await this.scriptrunnerGet("jiraMcpScreenSchemes", { id: schemeId });
    const schemes = data && typeof data === "object" ? (data.screenSchemes ?? []) : [];
    return schemes.length > 0 ? schemes[0] : null;
  }

  // -- screens ------------------------------------------------------------

  async listScreens(expand = ""): Promise<Json[]> {
    const params: Params = expand ? { expand } : {};
    return this.getPaged("/rest/api/2/screens", "screens", params);
  }

  async getScreenTabs(screenId: number): Promise<Json[]> {
    return this.get(`/rest/api/2/screens/${screenId}/tabs`);
  }

  async getScreenTabFields(screenId: number, tabId: number): Promise<Json[]> {
    return this.get(`/rest/api/2/screens/${screenId}/tabs/${tabId}/fields`);
  }

  /** Get a screen with all tabs and their fields. */
  async getScreenFull(screenId: number): Promise<Json> {
    const tabs = await this.getScreenTabs(screenId);
    for (const tab of tabs) {
      tab.fields = await this.getScreenTabFields(screenId, tab.id);
    }
    return { screenId, tabs };
  }

  // -- field configurations (ScriptRunner) --------------------------------

  async listFieldConfigurations(): Promise<Json[]> {
    const data = await this.scriptrunnerGet("jiraMcpFieldConfigurations");
    return data && typeof data === "object" ? (data.fieldConfigurations ?? []) : [];
  }

  async listFieldConfigurationSchemes(): Promise<Json[]> {
    const data = await this.scriptrunnerGet("jiraMcpFieldConfigurationSchemes");
    return data && typeof data === "object" ? (data.fieldConfigurationSchemes ?? []) : [];
  }

  // -- instance administration (ScriptRunner) -----------------------------

  async listListeners(): Promise<Json[]> {
    const data = await this.scriptrunnerGet("jiraMcpListeners");
    return data && typeof data === "object" ? (data.listeners ?? []) : [];
  }

  async listScheduledServices(): Promise<Json[]> {
    const data = await this.scriptrunnerGet("jiraMcpScheduledServices");
    return data && typeof data === "object" ? (data.services ?? []) : [];
  }

  async listApplicationLinks(): Promise<Json[]> {
    const data = await this.scriptrunnerGet("jiraMcpApplicationLinks");
    return data && typeof data === "object" ? (data.applicationLinks ?? []) : [];
  }

  async getEffectivePermissions(
    projectKey: string,
    username?: string,
    permission?: string,
  ): Promise<Json> {
    const params: Params = { projectKey };
    if (username) params.username = username;
    if (permission) params.permission = permission;
    return this.scriptrunnerGet("jiraMcpEffectivePermissions", params);
  }

  // -- server logs (ScriptRunner) -----------------------------------------

  async listServerLogFiles(): Promise<Json> {
    return this.scriptrunnerGet("jiraMcpServerLog", { action: "list" });
  }

  async tailServerLog(file?: string, lines?: number): Promise<Json> {
    return this.scriptrunnerGet("jiraMcpServerLog", { action: "tail", file, lines });
  }

  async grepServerLog(opts: {
    pattern: string;
    file?: string;
    rotations?: number;
    contextBefore?: number;
    contextAfter?: number;
    caseInsensitive?: boolean;
    maxMatches?: number;
  }): Promise<Json> {
    return this.scriptrunnerGet("jiraMcpServerLog", {
      action: "grep",
      pattern: opts.pattern,
      file: opts.file,
      rotations: opts.rotations,
      contextBefore: opts.contextBefore,
      contextAfter: opts.contextAfter,
      caseInsensitive: opts.caseInsensitive,
      maxMatches: opts.maxMatches,
    });
  }

  // -- permission schemes -------------------------------------------------

  async listPermissionSchemes(): Promise<Json[]> {
    const data = await this.get("/rest/api/2/permissionscheme", { expand: "all" });
    return data?.permissionSchemes ?? [];
  }

  async getPermissionScheme(schemeId: number): Promise<Json> {
    return this.get(`/rest/api/2/permissionscheme/${schemeId}`, { expand: "all" });
  }

  // -- notification schemes -----------------------------------------------

  async listNotificationSchemes(): Promise<Json[]> {
    return this.getPaged("/rest/api/2/notificationscheme", "values");
  }

  async getNotificationScheme(schemeId: number): Promise<Json> {
    return this.get(`/rest/api/2/notificationscheme/${schemeId}`, {
      // `all` also expands group/projectRole/user/field details per notification.
      expand: "all",
    });
  }

  // -- issue security schemes ---------------------------------------------

  async listIssueSecuritySchemes(): Promise<Json[]> {
    const data = await this.get("/rest/api/2/issuesecurityschemes");
    return data?.issueSecuritySchemes ?? [];
  }

  async getIssueSecurityScheme(schemeId: number): Promise<Json> {
    return this.get(`/rest/api/2/issuesecurityschemes/${schemeId}`);
  }

  async getIssueSecurityLevels(schemeId: number): Promise<Json> {
    const data = await this.get(`/rest/api/2/issuesecurityschemes/${schemeId}/members`);
    return data && typeof data === "object" ? (data.body ?? data) : data;
  }

  // -- priority schemes (DC 10) -------------------------------------------

  async listPrioritySchemes(): Promise<Json[]> {
    try {
      const data = await this.get("/rest/api/2/priorityschemes");
      return data && typeof data === "object" ? (data.schemes ?? []) : [];
    } catch (e) {
      if (isHttpStatusError(e) && e.status === 404) return [];
      throw e;
    }
  }

  async getPriorityScheme(schemeId: number): Promise<Json> {
    return this.get(`/rest/api/2/priorityschemes/${schemeId}`);
  }

  // ======================================================================
  // Agile boards
  // ======================================================================

  async listBoards(projectKey?: string): Promise<Json[]> {
    const params: Params = {};
    if (projectKey) params.projectKeyOrId = projectKey;
    try {
      return await this.getPaged("/rest/agile/1.0/board", "values", params);
    } catch (e) {
      if (isHttpStatusError(e)) return [];
      throw e;
    }
  }

  async getBoardConfiguration(boardId: number): Promise<Json> {
    return this.get(`/rest/agile/1.0/board/${boardId}/configuration`);
  }

  // ======================================================================
  // JSM Service Desk
  // ======================================================================

  async getServiceDeskQueues(serviceDeskId: number): Promise<Json[]> {
    try {
      const data = await this.get(`/rest/servicedeskapi/servicedesk/${serviceDeskId}/queue`);
      return data && typeof data === "object" && !Array.isArray(data)
        ? (data.values ?? [])
        : data;
    } catch (e) {
      if (isHttpStatusError(e)) return [];
      throw e;
    }
  }

  // ======================================================================
  // Filters, dashboards, categories
  // ======================================================================

  async listFilters(): Promise<Json[]> {
    try {
      return await this.get("/rest/api/2/filter/favourite");
    } catch (e) {
      if (isHttpStatusError(e)) return [];
      throw e;
    }
  }

  async listDashboards(): Promise<Json[]> {
    try {
      return await this.getPaged("/rest/api/2/dashboard", "dashboards");
    } catch (e) {
      if (isHttpStatusError(e)) return [];
      throw e;
    }
  }

  async listProjectCategories(): Promise<Json[]> {
    try {
      return await this.get("/rest/api/2/projectCategory");
    } catch (e) {
      if (isHttpStatusError(e)) return [];
      throw e;
    }
  }

  // ======================================================================
  // Scheme ↔ project associations
  // ======================================================================

  async getWorkflowSchemeProjectAssociations(schemeId: number): Promise<Json[]> {
    try {
      const data = await this.get("/rest/api/2/workflowscheme/project", {
        workflowSchemeId: schemeId,
      });
      return data?.values ?? [];
    } catch (e) {
      if (isHttpStatusError(e)) return [];
      throw e;
    }
  }

  /**
   * Projects explicitly associated with an issue type scheme. Projects on the
   * global default scheme are not listed. (The Cloud-style bulk
   * `/issuetypescheme/project` endpoint does not exist on DC.)
   */
  async getIssueTypeSchemeAssociations(schemeId: number | string): Promise<Json[]> {
    return this.get(`/rest/api/2/issuetypescheme/${schemeId}/associations`);
  }

  // ======================================================================
  // Issues
  // ======================================================================

  async getIssue(issueKey: string, fields?: string, expand?: string): Promise<Json> {
    const params: Params = {};
    if (fields) params.fields = fields;
    if (expand) params.expand = expand;
    return this.get(
      `/rest/api/2/issue/${encodeURIComponent(issueKey)}`,
      Object.keys(params).length > 0 ? params : undefined,
    );
  }

  // ======================================================================
  // Users
  // ======================================================================

  async getUser(input: string): Promise<Json> {
    return this.get("/rest/api/2/user", isUserKey(input) ? { key: input } : { username: input });
  }

  async findUsers(query: string, maxResults = 10, includeInactive = false): Promise<Json[]> {
    return this.get("/rest/api/2/user/search", {
      username: query, // Even though parameter is username, this endpoint performs loose search on username, displayName, emailAddress
      maxResults,
      includeActive: true,
      includeInactive,
    });
  }

  async getUserGroups(input: string): Promise<Json[]> {
    const params = isUserKey(input)
      ? { key: input, expand: "groups" }
      : { username: input, expand: "groups" };
    const user = await this.get("/rest/api/2/user", params);
    return user?.groups?.items ?? [];
  }

  async getGroupMembers(
    groupName: string,
    includeInactive = false,
    maxResults = 1000,
  ): Promise<Json[]> {
    return this.getPaged(
      "/rest/api/2/group/member",
      "values",
      { groupname: groupName, includeInactiveUsers: String(includeInactive).toLowerCase() },
      Math.min(maxResults, 50),
    );
  }

  // ======================================================================
  // Automation for Jira (A4J) — /rest/cb-automation/
  // ======================================================================

  async getAutomationAuditLog(opts: {
    limit?: number;
    offset?: number;
    categories?: string[] | null;
    dateFrom?: string | null;
    dateTo?: string | null;
    ruleId?: number | null;
  }): Promise<Json> {
    const { limit = 50, offset = 0, categories, dateFrom, dateTo, ruleId } = opts;
    try {
      const sp = new URLSearchParams();
      sp.append("limit", String(limit));
      sp.append("offset", String(offset));
      if (categories) for (const cat of categories) sp.append("categories", cat);
      if (dateFrom) sp.append("dateFrom", dateFrom);
      if (dateTo) sp.append("dateTo", dateTo);
      if (ruleId !== undefined && ruleId !== null) sp.append("ruleId", String(ruleId));

      const path = `/rest/cb-automation/latest/audit/GLOBAL?${sp.toString()}`;
      const { status, text } = await this.request("GET", path);
      if (status >= 400) {
        console.error(`A4J audit log failed: ${status}`);
        return { results: [] };
      }
      return text.length > 0 ? JSON.parse(text) : { results: [] };
    } catch (e) {
      console.error(`A4J audit log error: ${e}`);
      return { results: [] };
    }
  }

  async getAutomationAuditItem(itemId: number): Promise<Json> {
    try {
      return await this.get(`/rest/cb-automation/latest/audit/GLOBAL/item/${itemId}`);
    } catch (e) {
      if (isHttpStatusError(e)) {
        return { error: `Failed to fetch audit item ${itemId}: HTTP ${e.status}` };
      }
      throw e;
    }
  }

  /** Export all automation rules via the single GLOBAL export endpoint. */
  async exportAutomationRules(): Promise<Json[]> {
    try {
      const { status, text } = await this.request(
        "GET",
        "/rest/cb-automation/latest/project/GLOBAL/rule/export",
      );
      if (status >= 400) {
        console.error(`A4J rule export endpoint failed: status=${status}`);
        return [];
      }
      if (text.length === 0) {
        console.error("A4J export returned empty body");
        return [];
      }
      const data = JSON.parse(text);
      if (Array.isArray(data)) return data;
      return data.rules ?? data.results ?? data.values ?? [];
    } catch (e) {
      console.error(`A4J rule export unexpected error: ${e}`);
      return [];
    }
  }

  // ======================================================================
  // Assets (Insight) — read operations on /rest/insight/1.0 (DC, IQL-based)
  // ======================================================================

  /** All object schemas. Insight wraps the list in `objectschemas`. */
  async listObjectSchemas(): Promise<Json[]> {
    const data = await this.get(`${INSIGHT_BASE}/objectschema/list`);
    return data?.objectschemas ?? [];
  }

  async getObjectSchema(schemaId: number): Promise<Json> {
    return this.get(`${INSIGHT_BASE}/objectschema/${schemaId}`);
  }

  /** Object types in a schema — flat list by default, hierarchical tree if asked. */
  async listObjectTypes(schemaId: number, hierarchical = false): Promise<Json[]> {
    const suffix = hierarchical ? "objecttypes" : "objecttypes/flat";
    return this.get(`${INSIGHT_BASE}/objectschema/${schemaId}/${suffix}`);
  }

  /** All attribute definitions across a schema. */
  async getSchemaAttributes(schemaId: number): Promise<Json[]> {
    return this.get(`${INSIGHT_BASE}/objectschema/${schemaId}/attributes`);
  }

  async getObjectType(objectTypeId: number): Promise<Json> {
    return this.get(`${INSIGHT_BASE}/objecttype/${objectTypeId}`);
  }

  /** Attribute definitions for one object type (the core of a structure audit). */
  async getObjectTypeAttributes(objectTypeId: number): Promise<Json[]> {
    return this.get(`${INSIGHT_BASE}/objecttype/${objectTypeId}/attributes`);
  }

  /** Status types — global, or scoped to a schema when `schemaId` is given. */
  async listObjectStatuses(schemaId?: number): Promise<Json[]> {
    return this.get(
      `${INSIGHT_BASE}/config/statustype`,
      schemaId !== undefined ? { objectSchemaId: schemaId } : undefined,
    );
  }

  async getObject(objectId: number): Promise<Json> {
    return this.get(`${INSIGHT_BASE}/object/${objectId}`);
  }

  async getObjectAttributes(objectId: number): Promise<Json[]> {
    return this.get(`${INSIGHT_BASE}/object/${objectId}/attributes`);
  }

  /** Jira issues/tickets connected to an object. */
  async getObjectConnectedTickets(objectId: number): Promise<Json> {
    return this.get(`${INSIGHT_BASE}/objectconnectedtickets/${objectId}/tickets`);
  }

  /**
   * IQL search over objects. Pages through `iql/objects` (page/resultPerPage)
   * and returns the collected objects plus the reported total match count.
   */
  async searchObjectsIql(
    iql: string,
    opts: { objectSchemaId?: number; includeAttributes?: boolean; maxResults?: number } = {},
  ): Promise<{ objects: Json[]; total: number }> {
    let total = 0;
    const objects = await collectPagedEntries<Json>(
      async (page) => {
        const data = await this.get(`${INSIGHT_BASE}/iql/objects`, {
          iql,
          objectSchemaId: opts.objectSchemaId,
          page,
          resultPerPage: IQL_PAGE_SIZE,
          includeAttributes: opts.includeAttributes ?? true,
        });
        total = data?.totalFilterCount ?? 0;
        return { entries: data?.objectEntries ?? [], total };
      },
      { maxResults: opts.maxResults },
    );
    return { objects, total };
  }

  // ======================================================================
  // Plugins (UPM / Universal Plugin Manager) — read operations
  // ======================================================================

  /**
   * All registered plugins. UPM wraps the list in `plugins`. UPM only serves its
   * own vendor media types, so the default `Accept: application/json` draws a 406;
   * UPM_ACCEPT sends a wildcard and lets content negotiation pick UPM's JSON.
   */
  async listPlugins(): Promise<Json[]> {
    const data = await this.get("/rest/plugins/1.0/", undefined, UPM_ACCEPT);
    return data?.plugins ?? [];
  }

  /**
   * License detail for one plugin. License lookup is best-effort: plugins without
   * a license answer 404, and some bundled apps (e.g. language packs) even 500 on
   * this route. Any HTTP error → null so a bulk dump never aborts on one plugin;
   * non-HTTP errors (network/timeout) still propagate.
   */
  async getPluginLicense(pluginKey: string): Promise<Json | null> {
    try {
      return await this.get(
        `/rest/plugins/1.0/${encodeURIComponent(pluginKey)}-key/license`,
        undefined,
        UPM_ACCEPT,
      );
    } catch (e) {
      if (isHttpStatusError(e)) return null;
      throw e;
    }
  }
}
