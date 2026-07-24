/**
 * Server log introspection tools.
 *
 * Read-only list/tail/grep over the Jira server's log files (atlassian-jira.log
 * and rotations, Tomcat logs) via the jiraMcpServerLog ScriptRunner endpoint —
 * replaces the SSH-and-grep loop during incident investigations. The endpoint
 * restricts access server-side to files directly inside the Jira and Tomcat log
 * directories and requires jira-administrators membership.
 */

import { z } from "zod";
import { dumps } from "../json.js";
import type { ToolDef } from "./types.js";

export const logTools: ToolDef[] = [
  {
    name: "list_server_log_files",
    description:
      "List the server's log files (name, size, last modified) from the Jira " +
      "log directory and the Tomcat logs directory.",
    inputShape: {},
    async handler({ client }) {
      const data = await client.listServerLogFiles();
      return dumps(data);
    },
  },

  {
    name: "tail_server_log",
    description:
      "Return the last N lines of a server log file (default atlassian-jira.log). " +
      "Use list_server_log_files to discover file names.",
    inputShape: {
      file: z
        .string()
        .optional()
        .describe("Log file name without path (default atlassian-jira.log)"),
      lines: z
        .number()
        .int()
        .optional()
        .describe("Trailing lines to return (default 100, max 1000)"),
    },
    async handler({ client }, args) {
      const data = await client.tailServerLog(args.file, args.lines);
      return dumps(data);
    },
  },

  {
    name: "grep_server_log",
    description:
      "Search a server log file with a Java regex, like `grep` over " +
      "atlassian-jira.log. Set rotations=N to also scan <file>.1..<file>.N " +
      "(oldest first, so matches are chronological). Supports before/after " +
      "context lines. Anchor patterns with a date prefix (e.g. '^2026-07-18 06:') " +
      "to narrow a time window.",
    inputShape: {
      pattern: z.string().describe("Java regex matched against each line"),
      file: z
        .string()
        .optional()
        .describe("Log file name without path (default atlassian-jira.log)"),
      rotations: z
        .number()
        .int()
        .optional()
        .describe("Also scan rotated files <file>.1..<file>.N (default 0, max 100)"),
      context_before: z
        .number()
        .int()
        .optional()
        .describe("Context lines before each match (default 0, max 10)"),
      context_after: z
        .number()
        .int()
        .optional()
        .describe("Context lines after each match (default 0, max 10)"),
      case_insensitive: z.boolean().optional().describe("Case-insensitive matching"),
      max_matches: z
        .number()
        .int()
        .optional()
        .describe("Stop after this many matches (default 200, max 1000)"),
    },
    async handler({ client }, args) {
      const data = await client.grepServerLog({
        pattern: args.pattern,
        file: args.file,
        rotations: args.rotations,
        contextBefore: args.context_before,
        contextAfter: args.context_after,
        caseInsensitive: args.case_insensitive,
        maxMatches: args.max_matches,
      });
      return dumps(data);
    },
  },
];
