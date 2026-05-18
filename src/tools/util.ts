/** Shared helpers for tool handlers — ports of Python idioms. */

/** Run a promise, swallowing errors and returning `fallback` instead. */
export async function safe<T>(p: Promise<T>, fallback: T, label = ""): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (label) console.error(`dump: ${label} failed — ${e}`);
    return fallback;
  }
}

/** Run a promise, returning `[]` on any error. */
export async function safeList<T>(p: Promise<T[]>): Promise<T[]> {
  try {
    return await p;
  } catch {
    return [];
  }
}

/** True when `obj` has its own property `key` (mirrors Python's `key in dict`). */
export function has(obj: unknown, key: string): boolean {
  return typeof obj === "object" && obj !== null && Object.prototype.hasOwnProperty.call(obj, key);
}
