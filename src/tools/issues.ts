/** Issue lookup tools. */

import { z } from "zod";
import { isHttpStatusError } from "../errors.js";
import { dumps } from "../json.js";
import type { ToolDef } from "./types.js";
import { has } from "./util.js";

function nameOf(obj: any): string | null {
  return obj ? obj.name : null;
}

function userOf(obj: any): { key: any; displayName: any } | null {
  if (!obj) return null;
  return { key: obj.key, displayName: obj.displayName };
}

export const issueTools: ToolDef[] = [
  {
    name: "get_issue",
    description:
      "Get a Jira issue by key (e.g. 'PROJ-123'). Returns summary, status, type, " +
      "priority, assignee, reporter, labels, components, description, links, and " +
      "recent comments. Optionally pass a comma-separated list of field IDs to restrict output.",
    inputShape: {
      issue_key: z.string().describe("Issue key (e.g. 'PROJ-123')"),
      fields: z
        .string()
        .optional()
        .describe(
          "Comma-separated field IDs to return (e.g. 'summary,status,customfield_10001'). " +
            "Omit for default fields.",
        ),
    },
    async handler({ client }, args) {
      const issueKey = args.issue_key;
      const fields: string | undefined = args.fields;
      try {
        const issue = await client.getIssue(issueKey, fields);

        const result: Record<string, any> = {
          key: issue.key,
          id: issue.id,
          self: issue.self,
        };

        const f = issue.fields ?? {};
        const out: Record<string, any> = {
          summary: f.summary,
          status: nameOf(f.status),
          issuetype: nameOf(f.issuetype),
          priority: nameOf(f.priority),
          resolution: nameOf(f.resolution),
          assignee: userOf(f.assignee),
          reporter: userOf(f.reporter),
          created: f.created,
          updated: f.updated,
          resolutiondate: f.resolutiondate,
          labels: f.labels ?? [],
          components: (f.components ?? []).map((c: any) => c.name),
          description: f.description,
        };
        result.fields = out;

        if (fields) {
          const requested = new Set(fields.split(",").map((fid) => fid.trim()));
          for (const fid of requested) {
            if (fid.startsWith("customfield_") && !has(out, fid)) {
              out[fid] = f[fid];
            }
          }
        }

        const links: any[] = f.issuelinks ?? [];
        if (links.length > 0) {
          out.issuelinks = links.map((link: any) => {
            const linked = link.outwardIssue || link.inwardIssue || {};
            return {
              type: link.type?.name,
              direction: has(link, "outwardIssue") ? "outward" : "inward",
              issue: linked.key,
              summary: (linked.fields ?? {}).summary,
            };
          });
        }

        const commentData = f.comment ?? {};
        if (Object.keys(commentData).length > 0) {
          const comments: any[] = commentData.comments ?? [];
          out.comment_count = has(commentData, "total") ? commentData.total : comments.length;
          out.recent_comments = comments.slice(-5).map((c: any) => ({
            author: userOf(c.author),
            created: c.created,
            body: c.body,
          }));
        }

        return dumps(result);
      } catch (e) {
        if (isHttpStatusError(e)) {
          if (e.status === 404) return dumps({ error: `Issue not found: ${issueKey}` });
          return dumps({ error: `HTTP ${e.status}: ${e.body.slice(0, 200)}` });
        }
        throw e;
      }
    },
  },

  {
    name: "get_issue_changelog",
    description:
      "Get the changelog (edit history) for an issue. Shows who changed what field, " +
      "when, and from/to values. Optionally filter to a single field name " +
      "(e.g. 'assignee', 'status', 'priority'). Use to trace how an issue was modified over time.",
    inputShape: {
      issue_key: z.string().describe("Issue key (e.g. 'PROJ-123')"),
      field: z
        .string()
        .optional()
        .describe(
          "Optional field name to filter changes (e.g. 'assignee', 'status'). " +
            "Omit for all changes.",
        ),
    },
    async handler({ client }, args) {
      const issueKey = args.issue_key;
      const field: string | undefined = args.field;
      try {
        const issue = await client.getIssue(issueKey, "summary", "changelog");
        const changelog = issue.changelog ?? {};
        const histories: any[] = changelog.histories ?? [];

        const changes: any[] = [];
        for (const h of histories) {
          for (const item of h.items ?? []) {
            if (field && (item.field ?? "").toLowerCase() !== field.toLowerCase()) continue;
            changes.push({
              when: h.created,
              who: userOf(h.author),
              field: item.field,
              from: item.fromString,
              to: item.toString,
            });
          }
        }

        return dumps({
          key: issue.key,
          total_history_entries: has(changelog, "total") ? changelog.total : histories.length,
          changes,
        });
      } catch (e) {
        if (isHttpStatusError(e)) {
          if (e.status === 404) return dumps({ error: `Issue not found: ${issueKey}` });
          return dumps({ error: `HTTP ${e.status}: ${e.body.slice(0, 200)}` });
        }
        throw e;
      }
    },
  },
];
