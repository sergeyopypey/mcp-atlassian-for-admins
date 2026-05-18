# Jira Data Center 10 MCP Server (TypeScript)

A **read-only** Model Context Protocol (MCP) server for deep introspection of
**Jira Data Center 10**. TypeScript port of the original Python server — same 60
tools, same input schemas, same JSON output shapes, same environment config.

> **Read-only** — this server cannot modify any Jira configuration.

## Prerequisites

- Node.js 20 LTS or newer
- Jira Data Center 10.x
- A Jira PAT with **Jira Administrator** permission (for full config reads)

## Install & build

```bash
npm install
npm run build      # bundles dist/index.js
```

## Configuration

The server reads these `JIRA_*` environment variables:

| Variable          | Required        | Default | Purpose                             |
| ----------------- | --------------- | ------- | ----------------------------------- |
| `JIRA_BASE_URL`   | yes             | —       | Jira instance base URL              |
| `JIRA_AUTH_TYPE`  | no              | `pat`   | `pat` or `basic`                    |
| `JIRA_PAT`        | if auth = pat   | —       | Personal access token (Bearer auth) |
| `JIRA_USERNAME`   | if auth = basic | —       | Username for basic auth             |
| `JIRA_PASSWORD`   | if auth = basic | —       | Password for basic auth             |
| `JIRA_VERIFY_SSL` | no              | `true`  | Set `false` for self-signed certs   |

## Run

stdio transport only:

```bash
npm start                       # node dist/index.js
```

For development (rebuild + restart on change):

```bash
npm run dev
```

## MCP client configuration

```json
{
  "mcpServers": {
    "jira-dc": {
      "command": "node",
      "args": ["E:/jira-dc-mcp/dist/index.js"],
      "env": {
        "JIRA_BASE_URL": "https://jira.yourcompany.com",
        "JIRA_AUTH_TYPE": "pat",
        "JIRA_PAT": "your-token-here"
      }
    }
  }
}
```

## Testing

```bash
npm run typecheck   # tsc --noEmit
npm test            # node:test unit tests for the port helpers
```

## Layout

```
src/
  index.ts            CLI entry (stdio)
  server.ts           McpServer + tool registration
  config.ts           JIRA_* environment parsing
  client.ts           JiraClient — fetch/undici wrapper
  automationCache.ts  A4J rule cache (startup fetch + 600s refresh)
  errors.ts           HttpStatusError
  json.ts             dumps() — Python-compatible JSON serialization
  lib/workflowXml.ts  OpenSymphony workflow XML parser
  tools/              one module per tool area, aggregated in tools/index.ts
test/
  unit/               node:test unit tests
```
