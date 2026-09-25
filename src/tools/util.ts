/** Shared helpers for tool handlers — ports of Python idioms. */

import { z } from "zod";

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

// -- listing: filters and pagination ----------------------------------------
//
// Instance-wide listings on a large Jira (1000+ automation rules, 800+ fields)
// exceed what an MCP client accepts in one tool result, so list-style tools
// take a name filter plus offset/limit and return a `Page` envelope.

/** Zod shape for a case-insensitive name substring filter. */
export const nameFilterShape = {
  name_contains: z
    .string()
    .optional()
    .describe("Only return items whose name contains this text (case-insensitive)"),
};

/** Keep items whose `name` contains `needle` (case-insensitive); no-op without a needle. */
export function filterByName<T extends { name?: unknown }>(items: T[], needle?: string): T[] {
  if (!needle) return items;
  const n = needle.toLowerCase();
  return items.filter((it) => String(it.name ?? "").toLowerCase().includes(n));
}

/**
 * Zod shape for offset/limit pagination. `limit` has no schema default so a
 * tool can pick its default at call time (e.g. smaller in a detail mode).
 */
export function pageShape(defaultLimit: number | string) {
  return {
    offset: z
      .coerce.number()
      .int()
      .min(0)
      .optional()
      .describe("Number of matching items to skip (default 0). Use nextOffset from the previous page."),
    limit: z
      .coerce.number()
      .int()
      .min(1)
      .optional()
      .describe(`Maximum number of items to return (default ${defaultLimit})`),
  };
}

/** One page of a listing. `nextOffset` is null on the last page. */
export interface Page<T> {
  total: number;
  offset: number;
  returned: number;
  nextOffset: number | null;
  items: T[];
}

/** Slice `items` into a `Page` using `args.offset` / `args.limit`. */
export function paginate<T>(
  items: T[],
  args: { offset?: number; limit?: number },
  defaultLimit: number,
): Page<T> {
  const offset = Math.max(0, args.offset ?? 0);
  const limit = Math.max(1, args.limit ?? defaultLimit);
  const slice = items.slice(offset, offset + limit);
  const end = offset + slice.length;
  return {
    total: items.length,
    offset,
    returned: slice.length,
    nextOffset: end < items.length ? end : null,
    items: slice,
  };
}
