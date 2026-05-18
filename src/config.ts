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
