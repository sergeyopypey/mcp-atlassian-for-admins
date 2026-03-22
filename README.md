# Jira Data Center 10 MCP Server

A **read-only** Model Context Protocol (MCP) server for deep introspection of **Jira Data Center 10**. Designed to give AI assistants (Claude, etc.) full contextual understanding of your Jira instance — schemes, workflows, automations, screens, fields, and their relationships.

> **Note:** This MCP server operates in **read-only mode**. It does not have rights to change any Jira configuration. All tools are introspection and analysis only.

## Goals

| Goal | How the MCP helps |
|---|---|
| **Fast understanding of processes** | Dump entire project configs, workflow graphs, automation rules in one call |
| **Find breaches / bugs in processes** | AI can compare workflow paths vs business rules, find orphan statuses, missing validators, inconsistent schemes |
| **Validate requirements for non-Jira-experts** | Feed a change request + current config to AI → get impact analysis, risk assessment, step-by-step plan |

---

## Architecture

```
┌─────────────┐       MCP (stdio/SSE)       ┌──────────────────────┐
│  AI Client   │◄──────────────────────────►│  jira-dc-mcp server  │
│  (Claude)    │                             │  (read-only)         │
└─────────────┘                             │                      │
                                            │  ┌────────────────┐  │
                                            │  │  Jira REST v2   │  │
                                            │  │  Client         │──┼──► Jira DC 10
                                            │  └────────────────┘  │     REST API
                                            │  ┌────────────────┐  │
                                            │  │  A4J Automation │  │
                                            │  │  Cache (10 min) │──┼──► /rest/cb-automation/
                                            │  └────────────────┘  │     latest/project/GLOBAL/
                                            └──────────────────────┘     rule/export
```

### Automation Rules Cache

Jira DC 10 provides a single endpoint for automation rules:
`/rest/cb-automation/latest/project/GLOBAL/rule/export`

There are no per-project or per-rule-ID endpoints. The MCP server fetches all
automation rules at startup and refreshes the cache every **10 minutes**. All
automation tool calls are served from this in-memory cache.

## Available Tools (31 tools)

### Dump / Introspection Tools

| Tool | Description |
|---|---|
| `dump_global_config` | Full instance config: fields, issue types, statuses, resolutions, priorities, link types |
| `dump_all_schemes` | Every scheme in the instance with their associations |
| `dump_workflows` | All workflows with statuses, transitions, conditions, validators, post-functions |
| `dump_automation_rules` | All Automation for Jira (A4J) rules from cache |
| `dump_full_instance` | Nuclear option — dumps everything into a single structured JSON |

### Project Tools

| Tool | Description |
|---|---|
| `list_projects` | List all projects with lead, type, category |
| `get_project_config` | Single project's full configuration chain |
| `get_project_role_members` | Who has what role in a project |
| `get_project_components` | Components and their leads |
| `get_project_versions` | Versions with release status |

### Workflow Tools

| Tool | Description |
|---|---|
| `list_workflows` | All workflows (name, step count, transition count) |
| `get_workflow_detail` | Full workflow: steps, transitions, conditions, validators, post-functions, properties |
| `get_workflow_scheme` | Workflow scheme with issue-type-to-workflow mappings |
| `list_workflow_schemes` | All workflow schemes |

### Screen Tools

| Tool | Description |
|---|---|
| `list_screens` | All screens |
| `get_screen_tabs_and_fields` | Screen's tabs with all fields in order |
| `list_screen_schemes` | All screen schemes |
| `get_screen_scheme` | Screen scheme → operation-to-screen mapping |
| `list_issue_type_screen_schemes` | All issue type screen schemes |
| `get_issue_type_screen_scheme` | Issue type screen scheme → issue-type-to-screen-scheme mapping |

### Field Tools

| Tool | Description |
|---|---|
| `list_fields` | All fields (system + custom) with types, search keys |
| `get_field_configuration` | Field config: required, hidden, renderer, description per field |
| `get_field_configuration_scheme` | Field config scheme → issue-type-to-field-config mapping |
| `find_field_usage` | Where a field appears across all screens and field configs |

### Scheme Tools

| Tool | Description |
|---|---|
| `get_permission_scheme` | Full permission scheme with all grants |
| `list_permission_schemes` | All permission schemes with grant counts |
| `get_notification_scheme` | Notification scheme with all event mappings |
| `list_notification_schemes` | All notification schemes |
| `get_issue_type_scheme` | Issue type scheme → which issue types are available |
| `get_priority_scheme` | Priority scheme (DC 10 feature) |
| `get_issue_security_scheme` | Issue security scheme with levels and members |
| `list_all_scheme_types` | Overview of every scheme type and count |

### Automation (A4J) Tools

| Tool | Description |
|---|---|
| `list_automation_rules` | All rules from cache, with optional project_key filter |
| `get_automation_rule_detail` | Full rule detail from cache: trigger, conditions, actions, smart values |

### Analysis Tools

| Tool | Description |
|---|---|
| `analyze_project_config_chain` | Resolve the full scheme chain for a project and report inconsistencies |
| `search_config` | Free-text search across all config entities |

---

## Setup

### Prerequisites

- Python 3.11+
- Jira Data Center 10.x instance
- A Jira user with **Jira Administrator** global permission (for full config reads)
- Personal Access Token (recommended) or basic auth credentials

### Install

```bash
cd jira-dc-mcp
pip install -e .
```

### Configuration

Set environment variables:

```bash
export JIRA_BASE_URL="https://jira.yourcompany.com"
export JIRA_AUTH_TYPE="pat"                          # "pat" or "basic"
export JIRA_PAT="your-personal-access-token"         # if auth_type=pat
# OR
export JIRA_USERNAME="admin"                         # if auth_type=basic
export JIRA_PASSWORD="password"                      # if auth_type=basic
export JIRA_VERIFY_SSL="true"                        # set "false" for self-signed certs
```

### Run

**Stdio mode** (for Claude Desktop / Claude Code):

```bash
python -m jira_dc_mcp
```

**SSE mode** (for remote / web clients):

```bash
python -m jira_dc_mcp --transport sse --port 8080
```

### Claude Desktop Configuration

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "jira-dc": {
      "command": "python",
      "args": ["-m", "jira_dc_mcp"],
      "env": {
        "JIRA_BASE_URL": "https://jira.yourcompany.com",
        "JIRA_AUTH_TYPE": "pat",
        "JIRA_PAT": "your-token-here"
      }
    }
  }
}
```

### Claude Code Configuration

```bash
claude mcp add jira-dc -- python -m jira_dc_mcp
```

---

## Usage Ideas

### Core Use Cases

1. **Process Understanding** — "Dump the full config of project CORE and explain the workflow for Bug issue type"
2. **Bug/Breach Detection** — "Analyze project SALES workflow for any transitions that skip required fields or allow unauthorized role transitions"
3. **Requirement Validation** — "We want to add a new issue type 'Security Incident' to project INFRA. What screens, workflows, and field configs need to change?"

### Extended Use Cases

4. **Scheme Drift Detection** — Compare schemes across projects to find unintended divergence
5. **Workflow Complexity Audit** — Find workflows with too many statuses/transitions, dead-end statuses, or unreachable states
6. **Field Sprawl Analysis** — Identify unused custom fields, duplicate fields, or fields that exist on screens but are hidden in field configs
7. **Automation Conflict Detection** — Find A4J rules that could conflict (same trigger + overlapping conditions but different actions)
8. **Permission Gap Analysis** — Cross-reference permission schemes with workflow post-functions
9. **Onboarding Documentation** — Auto-generate process documentation from workflow + screen + field config
10. **Change Impact Simulation** — Before modifying a shared scheme, identify all projects affected
11. **Compliance Auditing** — Verify that specific fields are required on specific transitions
12. **Migration Planning** — Dump full config as a baseline before DC→Cloud migration
13. **Security Review** — Cross-reference issue security schemes with permission schemes to find data exposure risks
14. **Cross-Project Standardization** — Generate a report showing how each project deviates from a "golden" configuration template

---

## Project Structure

```
jira-dc-mcp/
├── README.md
├── pyproject.toml
├── requirements.txt
├── src/
│   └── jira_dc_mcp/
│       ├── __init__.py
│       ├── __main__.py              # Entry point
│       ├── server.py                # MCP server setup & tool registration
│       ├── client.py                # Jira REST API client (httpx-based)
│       ├── automation_cache.py      # A4J rules cache (10-min refresh)
│       └── tools/
│           ├── __init__.py
│           ├── dump.py              # Bulk dump tools
│           ├── projects.py          # Project introspection
│           ├── workflows.py         # Workflow tools
│           ├── screens.py           # Screen & field layout tools
│           ├── fields.py            # Field & field configuration tools
│           ├── schemes.py           # All scheme types
│           ├── automation.py        # A4J automation rules (from cache)
│           └── analysis.py          # Cross-cutting analysis tools
```

## API Coverage

| Jira API | Endpoints Used |
|---|---|
| REST API v2 | `/rest/api/2/project`, `/rest/api/2/workflow`, `/rest/api/2/screens`, `/rest/api/2/field`, `/rest/api/2/fieldconfiguration`, `/rest/api/2/issuetype`, `/rest/api/2/status`, `/rest/api/2/resolution`, `/rest/api/2/priority`, `/rest/api/2/notificationscheme`, `/rest/api/2/permissionscheme`, `/rest/api/2/issuesecurityschemes`, `/rest/api/2/workflowscheme`, `/rest/api/2/issuetypescheme`, `/rest/api/2/issuetypescreenscheme`, `/rest/api/2/screenscheme`, `/rest/api/2/fieldconfigurationscheme`, `/rest/api/2/priorityscheme` |
| Automation for Jira | `/rest/cb-automation/latest/project/GLOBAL/rule/export` |
| Workflow (extended) | `/rest/api/2/workflow/{id}/transitions`, `/rest/api/2/workflow/{id}/properties` |

## License

MIT
