# MCP Atlassian for Admins

An MCP (Model Context Protocol) server that gives AI assistants read access to Jira Data Center administration configuration — automation rules, workflows, schemes, custom fields, ScriptRunner scripts, and more.

Built for Jira DC admins who want to explore and analyze their instance configuration through AI tools like Claude.

## Features

**29 read-only tools** covering:

| Category | Tools |
|---|---|
| Automation rules | `list_automations`, `get_automation` |
| Workflows | `list_workflows`, `get_workflow` (full XML export via ScriptRunner) |
| Workflow schemes | `list_workflow_schemes`, `get_workflow_scheme` |
| Projects | `list_projects`, `get_project`, `get_project_schemes` |
| Issue types | `list_issuetypes`, `list_issuetype_schemes`, `get_issuetype_scheme` |
| Custom fields | `list_customfields`, `get_customfield`, `get_customfield_options` |
| Screens | `list_screens`, `get_screen` |
| Security schemes | `list_issuesecurity_schemes`, `get_issuesecurity_scheme` |
| Permission schemes | `list_permission_schemes`, `get_permission_scheme` |
| Notification schemes | `list_notification_schemes`, `get_notification_scheme` |
| Statuses | `list_statuses` |
| Reference data | `list_resolutions`, `list_priorities`, `list_roles`, `get_project_role` |
| ScriptRunner | `list_scriptrunner_scripts` |

## Prerequisites

- Node.js 18+
- Jira Data Center instance
- [ScriptRunner for Jira](https://marketplace.atlassian.com/apps/6820/scriptrunner-for-jira-dc) (required for workflow XML export and script listing)
- A Jira personal access token (Bearer) and/or Basic auth credentials

## Setup

```bash
npm install
npm run build
```

### Credentials

The server reads credentials from local files (preferred) or environment variables as fallback:

| File | Env variable | Description |
|---|---|---|
| `.jira-base` | `JIRA_BASE_URL` | Jira instance URL (e.g. `https://jira.example.com`) |
| `.jira-token` | `JIRA_TOKEN` | Personal access token for automation API |
| `.jira-basic` | `JIRA_BASIC_AUTH` | Base64-encoded `user:password` for REST API / ScriptRunner |

Create the credential files in the project root:

```bash
echo "https://jira.example.com" > .jira-base
echo "your-personal-access-token" > .jira-token
echo "dXNlcjpwYXNzd29yZA==" > .jira-basic
```

These files are gitignored by default.

## Usage

### With Claude Code

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "jira-automation": {
      "command": "node",
      "args": ["path/to/mcp-atlassian-for-admins/dist/server.js"],
      "env": {
        "JIRA_BASE_URL": "https://jira.example.com",
        "JIRA_TOKEN": "your-token",
        "JIRA_BASIC_AUTH": "your-base64-credentials"
      }
    }
  }
}
```

### Standalone

```bash
npm start
```

The server communicates over stdio using the MCP protocol.

## Authentication

The server uses two auth methods depending on the API:

- **Bearer token** — used for the Automation for Jira API (`/rest/cb-automation/`)
- **Basic auth** — used for the standard REST API (`/rest/api/2/`) and ScriptRunner endpoints

## License

MIT
