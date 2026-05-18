/** HTTP error analogue of httpx.HTTPStatusError — raised on a non-2xx response. */
export class HttpStatusError extends Error {
  readonly status: number;
  readonly body: string;
  readonly url: string;

  constructor(status: number, body: string, url: string) {
    super(`HTTP ${status} for ${url}`);
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
