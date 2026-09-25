const ERROR_DETAIL_MAX_CHARS = 500;

/**
 * The human-readable reason from an error response body, for the error
 * message: Jira's `{errorMessages, errors}` joined, or a short plain-text
 * body. HTML error pages carry nothing useful and yield "".
 */
export function errorDetail(body: string): string {
  const text = (body ?? "").trim();
  if (!text || text.startsWith("<")) return "";
  let detail = text;
  try {
    const data = JSON.parse(text);
    const parts: string[] = [];
    if (Array.isArray(data?.errorMessages)) parts.push(...data.errorMessages.map(String));
    if (data?.errors && typeof data.errors === "object") {
      for (const [k, v] of Object.entries(data.errors)) parts.push(`${k}: ${String(v)}`);
    }
    if (parts.length === 0 && typeof data?.message === "string") parts.push(data.message);
    if (parts.length > 0) detail = parts.join("; ");
  } catch {
    // not JSON — keep the raw text
  }
  return detail.length > ERROR_DETAIL_MAX_CHARS
    ? `${detail.slice(0, ERROR_DETAIL_MAX_CHARS)}…`
    : detail;
}

/** HTTP error analogue of httpx.HTTPStatusError — raised on a non-2xx response. */
export class HttpStatusError extends Error {
  readonly status: number;
  readonly body: string;
  readonly url: string;

  constructor(status: number, body: string, url: string, message?: string) {
    const detail = message === undefined ? errorDetail(body) : "";
    super(message ?? `HTTP ${status} for ${url}${detail ? `: ${detail}` : ""}`);
    this.name = "HttpStatusError";
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

/** True when `e` is an HttpStatusError (the only error type the client catches). */
export function isHttpStatusError(e: unknown): e is HttpStatusError {
  return e instanceof HttpStatusError;
}
