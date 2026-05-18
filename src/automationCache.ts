/**
 * In-memory cache for Automation for Jira (A4J) rules.
 *
 * Jira DC 10 exposes only a single bulk-export endpoint for automation rules.
 * This module fetches all rules at startup and refreshes every 10 minutes, and
 * builds a project ID↔key mapping so rules can be filtered by project key.
 */

import type { JiraClient } from "./client.js";

const REFRESH_INTERVAL_MS = 600_000; // 10 minutes

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type Rule = Record<string, any>;

export class AutomationCache {
  private readonly client: JiraClient;
  private rules: Rule[] = [];
  private lastRefreshTs = 0;
  private timer: NodeJS.Timeout | null = null;
  private idToKey = new Map<string, string>();
  private keyToId = new Map<string, string>();

  constructor(client: JiraClient) {
    this.client = client;
  }

  // -- lifecycle ----------------------------------------------------------

  /** Perform the initial fetch and start the background refresh loop. */
  async start(): Promise<void> {
    await this.doRefresh();
    this.timer = setInterval(() => {
      void this.tick();
    }, REFRESH_INTERVAL_MS);
    // Never let the refresh timer alone keep the process alive.
    this.timer.unref();
  }

  /** Cancel the background refresh loop. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Force an immediate refresh. Returns the number of rules loaded. */
  async refresh(): Promise<number> {
    await this.doRefresh();
    return this.rules.length;
  }

  // -- data access --------------------------------------------------------

  /** If the cache has never been successfully populated, force a refresh. */
  async ensureRefreshed(): Promise<void> {
    if (this.lastRefreshTs === 0) {
      console.error("Automation cache not yet populated — refreshing now");
      await this.doRefresh();
    }
  }

  async getAllRules(): Promise<Rule[]> {
    await this.ensureRefreshed();
    return [...this.rules];
  }

  async getRuleById(ruleId: number): Promise<Rule | null> {
    await this.ensureRefreshed();
    for (const rule of this.rules) {
      if (rule.id === ruleId) return rule;
    }
    return null;
  }

  /** Filter cached rules by project key (see `ruleMatchesProject`). */
  async getRulesForProject(projectKey: string): Promise<Rule[]> {
    await this.ensureRefreshed();
    const keyUpper = projectKey.toUpperCase();
    const projectId = this.keyToId.get(keyUpper) ?? null;
    const result: Rule[] = [];
    const seen = new Set<unknown>();

    for (const rule of this.rules) {
      const ruleId = rule.id;
      if (seen.has(ruleId)) continue;
      if (this.ruleMatchesProject(rule, keyUpper, projectId)) {
        result.push(rule);
        seen.add(ruleId);
      }
    }
    return result;
  }

  get lastRefresh(): number {
    return this.lastRefreshTs;
  }

  get ruleCount(): number {
    return this.rules.length;
  }

  // -- internals ----------------------------------------------------------

  private ruleMatchesProject(rule: Rule, keyUpper: string, projectId: string | null): boolean {
    // 1. Check 'projects' array (has projectId, sometimes projectKey).
    const projects = rule.projects;
    if (Array.isArray(projects)) {
      for (const p of projects) {
        if (!p || typeof p !== "object") continue;
        const pkey = p.projectKey;
        if (pkey && String(pkey).toUpperCase() === keyUpper) return true;
        if (projectId && String(p.projectId) === projectId) return true;
      }
    }

    // 2. Check ruleScope.
    const scope = rule.ruleScope;
    if (scope && typeof scope === "object") {
      for (const res of scope.resources ?? []) {
        if (typeof res === "string" && res.toUpperCase().includes(keyUpper)) return true;
      }
    }

    // 3. Search serialized rule for any project reference.
    return this.ruleJsonMentionsProject(rule, keyUpper, projectId);
  }

  private ruleJsonMentionsProject(
    rule: Rule,
    keyUpper: string,
    projectId: string | null,
  ): boolean {
    const ruleStr = JSON.stringify(rule);
    const escKey = escapeRegExp(keyUpper);

    // 1. JQL context: project = KEY, project in (KEY, ...), project="KEY"
    const jql = new RegExp(`project\\s*(?:=|in\\s*\\()[^)]*\\b${escKey}\\b`, "i");
    if (jql.test(ruleStr)) return true;

    // 2. Any JSON field whose name contains "project" holding the project key.
    const projectField = new RegExp(`"[^"]*[Pp]roject[^"]*"\\s*:\\s*"${escKey}"`);
    if (projectField.test(ruleStr)) return true;

    // 3. Nested key inside a project object.
    const nestedKey = new RegExp(
      `"[^"]*[Pp]roject[^"]*"\\s*:\\s*\\{[^}]*"key"\\s*:\\s*"${escKey}"`,
    );
    if (nestedKey.test(ruleStr)) return true;

    if (projectId) {
      const escId = escapeRegExp(projectId);
      const nestedId = new RegExp(
        `"[^"]*[Pp]roject[^"]*"\\s*:\\s*\\{[^}]*"id"\\s*:\\s*"?${escId}"?`,
      );
      if (nestedId.test(ruleStr)) return true;

      const projectIdPattern = new RegExp(
        `"[^"]*[Pp]roject[^"]*[Ii]d[^"]*"\\s*:\\s*"?${escId}\\b`,
      );
      if (projectIdPattern.test(ruleStr)) return true;
    }

    return false;
  }

  private async buildProjectIndex(): Promise<void> {
    try {
      const projects = await this.client.listProjects("");
      const idToKey = new Map<string, string>();
      const keyToId = new Map<string, string>();
      for (const p of projects) {
        const pid = String(p.id ?? "");
        const pkey = p.key ?? "";
        if (pid && pkey) {
          idToKey.set(pid, pkey);
          keyToId.set(String(pkey).toUpperCase(), pid);
        }
      }
      this.idToKey = idToKey;
      this.keyToId = keyToId;
      console.error(`Project index built: ${idToKey.size} projects`);
    } catch (e) {
      console.error(`Failed to build project index: ${e}`);
    }
  }

  private async doRefresh(): Promise<void> {
    try {
      if (this.idToKey.size === 0) {
        await this.buildProjectIndex();
      }
      this.rules = await this.client.exportAutomationRules();
      this.lastRefreshTs = Date.now() / 1000;
      console.error(`Automation cache refreshed: ${this.rules.length} rules loaded`);
    } catch (e) {
      console.error(`Failed to refresh automation cache: ${e}`);
    }
  }

  private async tick(): Promise<void> {
    await this.buildProjectIndex();
    await this.doRefresh();
  }
}
