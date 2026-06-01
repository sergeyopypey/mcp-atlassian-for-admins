/** Environment-driven configuration — mirrors the Python client's `_env` usage. */

export interface JiraConfig {
  baseUrl: string;
  verifySsl: boolean;
  headers: Record<string, string>;
}

function env(name: string, def?: string, required = false): string | undefined {
  const val = process.env[name] ?? def;
  if (required && !val) {
    throw new Error(`Environment variable ${name} is required but not set`);
  }
  return val;
}

/**
 * Resolve the reverse-proxy Basic credential, if any.
 * Accepts a pre-encoded base64 string (`JIRA_PROXY_BASIC`) or a raw
 * `JIRA_PROXY_USER` / `JIRA_PROXY_PASS` pair which is then base64-encoded.
 * Returns undefined when no proxy credential is configured.
 */
function proxyBasicCredential(): string | undefined {
  const pre = env("JIRA_PROXY_BASIC");
  if (pre) return pre;
  const user = env("JIRA_PROXY_USER");
  const pass = env("JIRA_PROXY_PASS");
  if (user && pass !== undefined) {
    return Buffer.from(`${user}:${pass}`).toString("base64");
  }
  return undefined;
}

/** Build the Jira connection config from JIRA_* environment variables. */
export function loadConfig(): JiraConfig {
  const baseUrl = env("JIRA_BASE_URL", undefined, true)!.replace(/\/+$/, "");
  const verifySsl = ["true", "1", "yes"].includes(
    (env("JIRA_VERIFY_SSL", "true") ?? "true").toLowerCase(),
  );

  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  // Gateway mode: a reverse proxy in front of Jira consumes the `Authorization`
  // header for its own Basic auth, so the Jira PAT cannot ride there. It travels
  // in a separate header (default `X-Jira-Token`) that the proxy validates and
  // rewrites into `Authorization: Bearer` toward Jira. Active when a proxy Basic
  // credential is supplied; otherwise we fall back to direct auth below.
  const proxyBasic = proxyBasicCredential();
  if (proxyBasic) {
    headers.Authorization = `Basic ${proxyBasic}`;
    const tokenHeader = env("JIRA_TOKEN_HEADER", "X-Jira-Token")!;
    headers[tokenHeader] = env("JIRA_PAT", undefined, true)!;
    return { baseUrl, verifySsl, headers };
  }

  const authType = env("JIRA_AUTH_TYPE", "pat");
  if (authType === "pat") {
    const token = env("JIRA_PAT", undefined, true)!;
    headers.Authorization = `Bearer ${token}`;
  } else {
    const user = env("JIRA_USERNAME", undefined, true)!;
    const pwd = env("JIRA_PASSWORD", undefined, true)!;
    const creds = Buffer.from(`${user}:${pwd}`).toString("base64");
    headers.Authorization = `Basic ${creds}`;
  }

  return { baseUrl, verifySsl, headers };
}
