/**
 * Serialize a value as pretty-printed JSON (2-space indent).
 *
 * Standard JS semantics: object properties whose value is `undefined` are
 * omitted from the output, so a field missing from a Jira response yields no
 * key (rather than an explicit `null`).
 */
export function dumps(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
