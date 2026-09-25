/** JSM Service Desk introspection tools. */

import { z } from "zod";
import { dumps } from "../json.js";
import type { ToolDef } from "./types.js";
import { safe, safeList } from "./util.js";

/** An SLA start/pause/stop condition, keeping the ids needed to tell app-provided ones apart. */
function formatSlaCondition(c: any): Record<string, unknown> {
  return {
    name: c.name,
    pluginKey: c.pluginKey,
    factoryKey: c.factoryKey,
    conditionId: c.conditionId,
    ...(c.missing ? { missing: true } : {}),
  };
}

/** Milliseconds as "10h", "1h 30m" or "45m" — how the SLA goal editor writes them. */
function formatDuration(ms: unknown): string | null {
  const total = Math.round(Number(ms) / 60_000);
  if (!Number.isFinite(total)) return null;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return [h ? `${h}h` : "", m || !h ? `${m}m` : ""].filter(Boolean).join(" ");
}

/** Milliseconds since midnight as "HH:MM". */
function formatTimeOfDay(ms: unknown): string {
  const total = Math.round(Number(ms) / 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/** A calendar list entry merged with its detail (null for the built-in 24/7 calendar). */
function formatSlaCalendar(c: any, detail: any): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: c.id ?? null,
    name: c.name,
    description: c.description || undefined,
    usedBy: (c.dependentMetrics ?? []).map((m: any) => m.metricName),
  };
  if (c.id == null) {
    out.workingTimes = "24/7";
    return out;
  }
  if (!detail) {
    out.workingTimes = "unavailable";
    return out;
  }
  out.timeZone = detail.timeZone;
  out.workingTimes = (detail.workingTimes ?? []).map((w: any) => ({
    day: w.day,
    start: formatTimeOfDay(w.start),
    end: formatTimeOfDay(w.end),
    ...(w.disabled ? { disabled: true } : {}),
  }));
  out.holidays = (detail.holidays ?? []).map((h: any) => ({
    name: h.name,
    date: h.date,
    recurring: h.recurring,
  }));
  return out;
}

export const serviceDeskTools: ToolDef[] = [
  {
    name: "list_service_desks",
    description: "List all JSM service desks with project associations.",
    inputShape: {},
    async handler({ client }) {
      const desks = await client.listJsmServiceDesks();
      return dumps(
        desks.map((d: any) => ({
          id: d.id,
          projectId: d.projectId,
          projectKey: d.projectKey,
          projectName: d.projectName,
        })),
      );
    },
  },

  {
    name: "get_service_desk_queues",
    description:
      "Get queues for a JSM service desk — how requests are triaged and routed. " +
      "Shows queue names, backing JQL, and issue counts.",
    inputShape: {
      service_desk_id: z
        .coerce.number()
        .int()
        .describe("Service desk ID (from list_service_desks)"),
    },
    async handler({ client }, args) {
      const queues = await client.getServiceDeskQueues(args.service_desk_id);
      return dumps(
        queues.map((q: any) => ({
          id: q.id,
          name: q.name,
          jql: q.jql,
          issueCount: q.issueCount,
        })),
      );
    },
  },

  {
    name: "get_sla_config",
    description:
      "Get the SLA configuration of a JSM service project — what the Project settings → " +
      "SLAs and Calendars pages show. Per SLA metric: its custom field, start / pause / stop " +
      "conditions, goals in evaluation order (JQL, target duration — null for a goal with no " +
      "target — and calendar; the default goal has empty JQL and covers all remaining " +
      "issues), and configProblems reported by " +
      "JSM's SLA validation (e.g. goal JQL referencing values that do not exist, conditions " +
      "on statuses not in the project's workflows; conditions from an uninstalled app are " +
      "marked missing). Also the project's calendars with time zone, working hours and " +
      "holidays, and whether SLA values on existing issues are up to date. Read from JSM's " +
      "internal admin REST API; fails for projects that are not service desks.",
    inputShape: {
      project_key: z.string().describe("Service project key (from list_service_desks)"),
    },
    async handler({ client }, args) {
      const projectKey = String(args.project_key).toUpperCase();
      const desk = (await client.listJsmServiceDesks()).find(
        (d: any) => String(d.projectKey).toUpperCase() === projectKey,
      );
      if (!desk) {
        throw new Error(`Project ${projectKey} is not a JSM service desk (or JSM is not installed)`);
      }
      const deskId = Number(desk.id);

      const data = await client.getSlaMetrics(projectKey);
      const metrics: any[] = data?.timeMetrics ?? [];
      const calendarRefs: any[] = data?.calendarRefs ?? [];
      const defaultCalendar =
        calendarRefs.find((c: any) => c.default)?.name ?? "Default 24/7 calendar";
      const calendarName = (id: unknown) =>
        id == null
          ? defaultCalendar
          : (calendarRefs.find((c: any) => c.id === id)?.name ?? `calendar ${id}`);

      const [validations, calendars] = await Promise.all([
        Promise.all(
          metrics.map((m: any) =>
            safe(client.getSlaValidation(deskId, m.id), null).then(
              (v: any) => v?.slaConfigurationErrors,
            ),
          ),
        ),
        safeList(client.getSlaCalendars(deskId)).then((list) =>
          Promise.all(
            list.map(async (c: any) =>
              formatSlaCalendar(
                c,
                c.id == null ? null : await safe(client.getSlaCalendar(deskId, c.id), null),
              ),
            ),
          ),
        ),
      ]);

      const consistency = data?.slaConsistencyData;
      return dumps({
        projectKey,
        serviceDeskId: deskId,
        metrics: metrics.map((m: any, i: number) => {
          const def = m.config?.definition ?? {};
          const out: Record<string, unknown> = {
            id: m.id,
            name: m.name,
            field: m.customFieldId != null ? `customfield_${m.customFieldId}` : null,
            customerVisible: m.customerVisible,
            start: (def.start ?? []).map(formatSlaCondition),
            pause: (def.pause ?? []).map(formatSlaCondition),
            stop: (def.stop ?? []).map(formatSlaCondition),
            goals: (m.config?.goals ?? []).map((g: any) => ({
              jql: g.jqlQuery ?? "",
              duration: formatDuration(g.duration),
              durationMinutes: Math.round(Number(g.duration) / 60_000),
              calendar: calendarName(g.calendarId),
              ...(g.defaultGoal ? { defaultGoal: true } : {}),
            })),
          };
          if (def.inconsistent) out.inconsistent = true;
          if (validations[i] === undefined) out.configProblems = "validation unavailable";
          else if (validations[i].length) {
            out.configProblems = validations[i].map((p: any) => ({
              type: p.type,
              field: p.field,
              value: p.value,
              message: p.message,
              ...(p.warning ? { warning: true } : {}),
            }));
          }
          return out;
        }),
        calendars,
        issueSlaValues: consistency
          ? {
              upToDate: consistency.upToDate,
              updating: consistency.updating,
              totalIssues: consistency.totalIssueCount,
              outdatedIssues: consistency.outdatedIssueCount,
            }
          : null,
      });
    },
  },
];
