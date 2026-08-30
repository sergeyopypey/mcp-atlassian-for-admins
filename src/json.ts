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
