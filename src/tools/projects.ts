/** Project introspection tools. */

import { z } from "zod";
import { JiraClient } from "../client.js";
import { isHttpStatusError } from "../errors.js";
import { dumps } from "../json.js";
import type { ToolDef } from "./types.js";

/**
 * Resolve the full scheme chain for a project.
 *
 * Uses project-level endpoints (`/project/{key}/workflowscheme`, etc.) which
 * are available on Jira DC 10.x; falls back gracefully on 404/405.
 * Exported for reuse by the analysis tools.
 */
export async function resolveProjectConfig(
  client: JiraClient,
  projectKey: string,
): Promise<Record<string, any>> {
  const project = await client.getProject(projectKey);
  const pid = Number(project.id);

  const tryGet = async (path: string): Promise<any> => {
    try {
      return await client.get(path);
    } catch (e) {
      if (isHttpStatusError(e)) return null;
      throw e;
    }
  };

  const wfScheme = await tryGet(`/rest/api/2/project/${projectKey}/workflowscheme`);
  const notifScheme = await tryGet(`/rest/api/2/project/${projectKey}/notificationscheme`);
  const permScheme = await tryGet(`/rest/api/2/project/${projectKey}/permissionscheme`);
  const secScheme = await tryGet(`/rest/api/2/project/${projectKey}/issuesecuritylevelscheme`);

  return {
    key: project.key,
    name: project.name,
    id: pid,
    projectTypeKey: project.projectTypeKey,
    lead: project.lead ? (project.lead.displayName ?? null) : null,
    issueTypes: (project.issueTypes ?? []).map((it: any) => ({
      id: it.id,
      name: it.name,
      subtask: it.subtask ?? false,
    })),
    schemes: {
      workflowScheme: {
        id: wfScheme ? (wfScheme.id ?? null) : null,
        name: wfScheme ? wfScheme.name : "Default",
        defaultWorkflow: wfScheme ? (wfScheme.defaultWorkflow ?? null) : null,
        issueTypeMappings: wfScheme ? (wfScheme.issueTypeMappings ?? {}) : {},
      },
      notificationScheme: {
        id: notifScheme ? (notifScheme.id ?? null) : null,
        name: notifScheme ? notifScheme.name : "Default",
      },
      permissionScheme: {
        id: permScheme ? (permScheme.id ?? null) : null,
        name: permScheme ? permScheme.name : "Default",
      },
      issueSecurityScheme: {
        id: secScheme ? (secScheme.id ?? null) : null,
        name: secScheme ? secScheme.name : null,
      },
    },
  };
}

export const projectTools: ToolDef[] = [
  {
    name: "list_projects",
    description: "List all Jira projects with key, name, type, lead.",
    inputShape: {},
    async handler({ client }) {
      const projects = await client.listProjects();
      return dumps(
        projects.map((p: any) => ({
          id: p.id,
          key: p.key,
          name: p.name,
          projectTypeKey: p.projectTypeKey,
          lead: p.lead ? (p.lead.displayName ?? null) : null,
          description: (p.description || "").slice(0, 200),
        })),
      );
    },
  },

  {
    name: "get_project_config",
    description:
      "Get the full configuration chain for a project: which workflow scheme, " +
      "issue type scheme, issue type screen scheme, and field configuration scheme " +
      "it uses, plus its available issue types. Essential for understanding a project's setup.",
    inputShape: { project_key: z.string().describe("Jira project key (e.g. 'CORE')") },
    async handler({ client }, args) {
      return dumps(await resolveProjectConfig(client, args.project_key));
    },
  },

  {
    name: "get_project_role_members",
    description: "Get all roles and their members/actors for a project.",
    inputShape: { project_key: z.string().describe("Jira project key") },
    async handler({ client }, args) {
      const rolesMap: Record<string, string> = await client.getProjectRoles(args.project_key);
      const result: Record<string, unknown> = {};
      for (const [roleName, roleUrl] of Object.entries(rolesMap)) {
        const roleId = Number(roleUrl.replace(/\/+$/, "").split("/").pop());
        const roleData = await client.getProjectRoleActors(args.project_key, roleId);
        result[roleName] = {
          id: roleId,
          actors: (roleData.actors ?? []).map((a: any) => ({
            displayName: a.displayName,
            type: a.type,
            name: a.name,
          })),
        };
      }
      return dumps(result);
    },
  },

  {
    name: "get_project_components",
    description: "Get components for a project with leads and descriptions.",
    inputShape: { project_key: z.string().describe("Jira project key") },
    async handler({ client }, args) {
      const comps = await client.getProjectComponents(args.project_key);
      return dumps(
        comps.map((c: any) => ({
          id: c.id,
          name: c.name,
          lead: c.lead ? (c.lead.displayName ?? null) : null,
          assigneeType: c.assigneeType,
          description: c.description ?? "",
        })),
      );
    },
  },

  {
    name: "get_project_versions",
    description: "Get versions for a project with release status and dates.",
    inputShape: { project_key: z.string().describe("Jira project key") },
    async handler({ client }, args) {
      const versions = await client.getProjectVersions(args.project_key);
      return dumps(
        versions.map((v: any) => ({
          id: v.id,
          name: v.name,
          released: v.released ?? false,
          archived: v.archived ?? false,
          releaseDate: v.releaseDate,
          description: v.description ?? "",
        })),
      );
    },
  },

  {
    name: "list_project_categories",
    description: "List all project categories used to group projects.",
    inputShape: {},
    async handler({ client }) {
      const categories = await client.listProjectCategories();
      return dumps(
        categories.map((c: any) => ({
          id: c.id,
          name: c.name,
          description: c.description ?? "",
        })),
      );
    },
  },
];
