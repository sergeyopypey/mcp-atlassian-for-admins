/**
 * Serialize a value as compact JSON (no indentation).
 *
 * MCP clients cap the size of a tool result (Claude Code: ~25k tokens), and
 * indentation alone adds 30–45% to a typical response, so output is compact.
 *
 * Standard JS semantics: object properties whose value is `undefined` are
 * omitted from the output, so a field missing from a Jira response yields no
 * key (rather than an explicit `null`).
 */
export function dumps(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Largest tool result (in characters) handed to the MCP client. Claude Code
 * drops results over ~25k tokens, which dense JSON reaches at roughly 75k
 * characters; an oversized result is replaced by an error telling the model
 * how to narrow the call. `JIRA_MCP_MAX_RESPONSE_CHARS=0` disables the check.
 */
export const MAX_RESPONSE_CHARS = Number(process.env.JIRA_MCP_MAX_RESPONSE_CHARS ?? 60_000);

/** True when a serialized result exceeds MAX_RESPONSE_CHARS (never when the check is off). */
export function exceedsResponseLimit(text: string): boolean {
  return MAX_RESPONSE_CHARS > 0 && text.length > MAX_RESPONSE_CHARS;
}
