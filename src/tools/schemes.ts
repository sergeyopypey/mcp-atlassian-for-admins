/** Scheme introspection tools — permissions, notifications, issue security, priorities. */

import { z } from "zod";
import { dumps } from "../json.js";
import type { ToolDef } from "./types.js";

export const schemeTools: ToolDef[] = [
  {
    name: "get_permission_scheme",
    description: "Get full permission scheme with all grants (who can do what).",
    inputShape: { scheme_id: z.coerce.number().int().describe("Permission scheme ID") },
    async handler({ client }, args) {
      const scheme = await client.getPermissionScheme(args.scheme_id);
      const permissions: any[] = scheme.permissions ?? [];
      return dumps({
        id: scheme.id,
        name: scheme.name,
        description: scheme.description ?? "",
        grants: permissions.map((p: any) => ({
          permission: p.permission,
          holder: {
            type: p.holder?.type,
            parameter: p.holder?.parameter,
            value: p.holder?.value,
          },
        })),
        grantCount: permissions.length,
      });
    },
  },

  {
    name: "list_permission_schemes",
    description: "List all permission schemes with grant counts.",
    inputShape: {},
    async handler({ client }) {
      const schemes = await client.listPermissionSchemes();
      return dumps(
        schemes.map((s: any) => ({
          id: s.id,
          name: s.name,
          description: s.description ?? "",
          grantCount: (s.permissions ?? []).length,
        })),
      );
    },
  },

  {
    name: "get_notification_scheme",
    description:
      "Get notification scheme with all event-to-notification mappings. Each notification " +
      "has the recipient type (e.g. CurrentAssignee, Group, ProjectRole, UserCustomField), " +
      "its raw parameter, and a resolved target name (group, role, user, field, or email) when applicable.",
    inputShape: { scheme_id: z.coerce.number().int().describe("Notification scheme ID") },
    async handler({ client }, args) {
      const scheme = await client.getNotificationScheme(args.scheme_id);
      const events: any[] = scheme.notificationSchemeEvents ?? [];
      return dumps({
        id: scheme.id,
        name: scheme.name,
        description: scheme.description ?? "",
        events: events.map((e: any) => ({
          event:
            e.event && typeof e.event === "object" ? e.event.name : e.event,
          eventId: e.event && typeof e.event === "object" ? e.event.id : null,
          notifications: (e.notifications ?? []).map((n: any) => ({
            // Jira DC names the recipient kind `notificationType`
            // (CurrentAssignee, Reporter, Group, ProjectRole, UserCustomField, …).
            type: n.notificationType ?? n.type ?? null,
            parameter: n.parameter ?? null,
            target:
              n.group?.name ??
              n.projectRole?.name ??
              n.user?.name ??
              n.field?.name ??
              n.emailAddress ??
              null,
          })),
        })),
      });
    },
  },

  {
    name: "list_notification_schemes",
    description: "List all notification schemes.",
    inputShape: {},
    async handler({ client }) {
      const schemes = await client.listNotificationSchemes();
      return dumps(
        schemes.map((s: any) => ({
          id: s.id,
          name: s.name,
          description: s.description ?? "",
        })),
      );
    },
  },

  {
    name: "get_issue_type_scheme",
    description:
      "Get issue type scheme — which issue types are available and which is default.",
    inputShape: { scheme_id: z.coerce.number().int().describe("Issue type scheme ID") },
    async handler({ client }, args) {
      const scheme = await client.getIssueTypeScheme(args.scheme_id);
      const defaultIt = scheme.defaultIssueType;
      const issueTypes: any[] = scheme.issueTypes ?? [];
      return dumps({
        id: scheme.id,
        name: scheme.name,
        description: scheme.description ?? "",
        defaultIssueType:
          defaultIt && typeof defaultIt === "object"
            ? { id: defaultIt.id, name: defaultIt.name }
            : defaultIt,
        issueTypes: issueTypes.map((it: any) => ({
          id: it.id,
          name: it.name,
          subtask: it.subtask ?? false,
        })),
      });
    },
  },

  {
    name: "get_issue_security_scheme",
    description: "Get issue security scheme with security levels.",
    inputShape: { scheme_id: z.coerce.number().int().describe("Issue security scheme ID") },
    async handler({ client }, args) {
      const scheme = await client.getIssueSecurityScheme(args.scheme_id);
      const levels: any[] = scheme.levels ?? [];
      return dumps({
        id: scheme.id,
        name: scheme.name,
        description: scheme.description ?? "",
        defaultSecurityLevelId: scheme.defaultSecurityLevelId,
        levels: levels.map((lv: any) => ({
          id: lv.id,
          name: lv.name,
          description: lv.description ?? "",
        })),
      });
    },
  },

  {
    name: "get_priority_scheme",
    description: "Get priority scheme (Jira DC 10 feature).",
    inputShape: { scheme_id: z.coerce.number().int().describe("Priority scheme ID") },
    async handler({ client }, args) {
      return dumps(await client.getPriorityScheme(args.scheme_id));
    },
  },
];
