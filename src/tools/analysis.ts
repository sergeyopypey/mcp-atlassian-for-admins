/** Cross-cutting analysis tools — config chain resolution, search. */

import { z } from "zod";
import { dumps } from "../json.js";
import type { ToolDef } from "./types.js";
import { resolveProjectConfig } from "./projects.js";
import { has, safeList } from "./util.js";

export const analysisTools: ToolDef[] = [
  {
    name: "analyze_project_config_chain",
    description:
      "Resolve the FULL scheme chain for a project and report inconsistencies. " +
      "Shows: project → issue types → workflow scheme → workflows, " +
      "issue type screen scheme → screen schemes → screens, " +
      "field configuration scheme → field configs. " +
      "Reports issues (missing mappings) and warnings.",
    inputShape: { project_key: z.string().describe("Jira project key") },
    async handler({ client }, args) {
      const config = await resolveProjectConfig(client, args.project_key);
      const issues: string[] = [];
      const warnings: string[] = [];

      const issueTypes: any[] = config.issueTypes ?? [];
      if (issueTypes.length === 0) {
        issues.push("Project has no issue types configured");
      }

      const wfScheme = (config.schemes ?? {}).workflowScheme ?? {};
      const wfMappings = wfScheme.issueTypeMappings ?? {};
      const defaultWf = wfScheme.defaultWorkflow;

      for (const it of issueTypes) {
        const itId = it.id;
        const assignedWf = has(wfMappings, itId) ? wfMappings[itId] : defaultWf;
        if (!assignedWf) {
          issues.push(`Issue type '${it.name}' (id=${itId}) has no workflow mapped`);
        }
      }

      const itss = (config.schemes ?? {}).issueTypeScreenScheme ?? {};
      if (!itss.id) {
        warnings.push("Project uses default issue type screen scheme");
      }

      const fcs = (config.schemes ?? {}).fieldConfigurationScheme ?? {};
      if (!fcs.id) {
        warnings.push(
          "Project uses default field configuration scheme (all fields use default config)",
        );
      }

      const chain: Record<string, any> = {
        project: { key: config.key, name: config.name },
        issueTypes,
        workflowScheme: wfScheme,
        issueTypeScreenScheme: itss,
        fieldConfigurationScheme: fcs,
        issues,
        warnings,
      };

      if (itss.id) {
        try {
          const itssItems = await client.getIssueTypeScreenSchemeItems([itss.id]);
          const screenSchemeIds = new Set<number>();
          for (const item of itssItems) {
            const ssid = item.screenSchemeId;
            if (ssid) screenSchemeIds.add(Number(ssid));
          }

          chain.resolvedScreenSchemes = [];
          for (const ssid of screenSchemeIds) {
            try {
              const ss = await client.getScreenScheme(ssid);
              chain.resolvedScreenSchemes.push(ss ? ss : { id: ssid, error: "not found" });
            } catch {
              chain.resolvedScreenSchemes.push({ id: ssid, error: "failed to fetch" });
            }
          }
        } catch {
          // ignore
        }
      }

      return dumps(chain);
    },
  },

  {
    name: "search_config",
    description:
      "Free-text search across all config entities: fields, screens, workflows, " +
      "workflow schemes, issue type schemes, permission schemes. " +
      "Case-insensitive search on names and IDs.",
    inputShape: { query: z.string().describe("Search text") },
    async handler({ client }, args) {
      const q = String(args.query).toLowerCase();
      const hits: any[] = [];

      const [fields, screens, workflows, wfSchemes, itSchemes, permSchemes] =
        await Promise.all([
          safeList(client.listFields()),
          safeList(client.listScreens()),
          safeList(client.listWorkflows()),
          safeList(client.listWorkflowSchemes()),
          safeList(client.listIssueTypeSchemes()),
          safeList(client.listPermissionSchemes()),
        ]);

      for (const f of fields) {
        if (
          (f.name ?? "").toLowerCase().includes(q) ||
          (f.id ?? "").toLowerCase().includes(q)
        ) {
          hits.push({ type: "field", id: f.id, name: f.name, custom: f.custom });
        }
      }

      for (const s of screens) {
        if ((s.name ?? "").toLowerCase().includes(q)) {
          hits.push({ type: "screen", id: s.id, name: s.name });
        }
      }

      for (const w of workflows) {
        const name =
          w.name ||
          (typeof w.id === "object" && w.id !== null ? (w.id.name ?? "") : "");
        if (
          (name ?? "").toLowerCase().includes(q) ||
          (w.description ?? "").toLowerCase().includes(q)
        ) {
          hits.push({ type: "workflow", name });
        }
      }

      for (const ws of wfSchemes) {
        if ((ws.name ?? "").toLowerCase().includes(q)) {
          hits.push({ type: "workflowScheme", id: ws.id, name: ws.name });
        }
      }

      for (const its of itSchemes) {
        if ((its.name ?? "").toLowerCase().includes(q)) {
          hits.push({ type: "issueTypeScheme", id: its.id, name: its.name });
        }
      }

      for (const ps of permSchemes) {
        if ((ps.name ?? "").toLowerCase().includes(q)) {
          hits.push({ type: "permissionScheme", id: ps.id, name: ps.name });
        }
      }

      return dumps({ query: args.query, hits, count: hits.length });
    },
  },
];
