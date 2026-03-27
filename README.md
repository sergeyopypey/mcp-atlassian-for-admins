# Jira Data Center 10 MCP Server

A **read-only** Model Context Protocol (MCP) server for deep introspection of **Jira Data Center 10**. Gives AI assistants full contextual understanding of a Jira instance — schemes, workflows, automations, screens, fields, issues, and their relationships.

> **Read-only** — this server cannot modify any Jira configuration. All tools are introspection and analysis only.

## What It's For

- **Automation bug research** — trace why an A4J rule fails: inspect the rule definition, walk the audit log, check required fields via createmeta, compare with working sibling rules
- **Process understanding** — dump a project's full config chain (workflow scheme, screen scheme, field configs) in one call
- **Impact analysis** — before changing a shared scheme, find every project affected
- **Configuration audits** — detect orphan statuses, missing validators, scheme drift across projects, field sprawl

---

## Architecture

```
┌─────────────┐       MCP (stdio/SSE)       ┌──────────────────────┐
│  MCP Client  │◄──────────────────────────►│  jira-dc-mcp server  │
│              │                             │  (read-only)         │
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

Jira DC 10 exposes a single bulk-export endpoint for automation rules — no per-rule or per-project endpoints exist. The server fetches all rules at startup and refreshes every **10 minutes**. All automation tool calls are served from this cache.

## Available Tools

### Issues

| Tool | Description |
|---|---|
| `get_issue` | Get issue by key — summary, status, type, assignee, description, links, comments. Optionally restrict to specific field IDs |

### Dump / Introspection

| Tool | Description |
|---|---|
| `dump_global_config` | Full instance config: fields, issue types, statuses, resolutions, priorities, link types |
| `dump_all_schemes` | Every scheme in the instance with associations |
| `dump_workflows` | All workflows with statuses, transitions, conditions, validators, post-functions |
| `dump_automation_rules` | All A4J rules from cache |
| `dump_full_instance` | Everything in one structured JSON |

### Projects

| Tool | Description |
|---|---|
| `list_projects` | All projects with lead, type, category |
| `get_project_config` | Full configuration chain for a project |
| `get_project_role_members` | Role membership for a project |
| `get_project_components` | Components and leads |
| `get_project_versions` | Versions with release status |
| `list_project_categories` | Project categories |

### Workflows

| Tool | Description |
|---|---|
| `list_all_workflows` | All workflows (name, step count, transition count) |
| `list_active_workflows` | Only workflows in use by active projects |
| `get_workflow_detail` | Full workflow: steps, transitions, conditions, validators, post-functions, properties |
| `get_workflow_statuses_and_transitions` | Statuses and transitions for a workflow |
| `get_workflow_scheme` | Workflow scheme with issue-type-to-workflow mappings |
| `list_workflow_schemes` | All workflow schemes |

### Screens

| Tool | Description |
|---|---|
| `list_screens` | All screens |
| `get_screen_tabs_and_fields` | Screen's tabs with all fields in order |
| `list_screen_schemes` | All screen schemes |
| `get_screen_scheme` | Screen scheme operation-to-screen mapping |

### Fields

| Tool | Description |
|---|---|
| `list_fields` | All fields (system + custom) with types, clause names. Filter by IDs or custom-only |
| `get_field_configuration` | Field config: required, hidden, renderer per field |
| `get_field_configuration_scheme` | Issue-type-to-field-config mapping |
| `find_field_usage` | Where a field appears across all screens |
| `get_field_contexts` | Custom field contexts — project + issue type scoping (internal API) |
| `get_createmeta_fields` | Fields on the CREATE screen for a project + issue type, including **allowed values** for select/radio/checkbox fields |

### Schemes

| Tool | Description |
|---|---|
| `get_permission_scheme` | Full permission scheme with all grants |
| `list_permission_schemes` | All permission schemes |
| `get_notification_scheme` | Notification scheme with event mappings |
| `list_notification_schemes` | All notification schemes |
| `get_issue_type_scheme` | Which issue types are available in a scheme |
| `get_priority_scheme` | Priority scheme (DC 10 feature) |
| `get_issue_security_scheme` | Issue security scheme with levels and members |
| `list_all_scheme_types` | Overview of every scheme type and count |

### Automation (A4J)

| Tool | Description |
|---|---|
| `list_automation_rules` | All rules from cache, optionally filtered by project key |
| `get_automation_rule_detail` | Full rule: trigger, conditions, actions, smart values |
| `get_automation_audit_log` | Global execution history — filter by category, date range |
| `get_automation_rule_audit_log` | Execution history for a specific rule |
| `get_automation_audit_item` | Detailed audit entry — component-level results, error messages |
| `refresh_automation_cache` | Force-refresh the rules cache |

### Boards & Service Desks

| Tool | Description |
|---|---|
| `list_boards` | All boards |
| `get_board_configuration` | Board config: filter, columns, estimation |
| `list_service_desks` | All service desks |
| `get_service_desk_queues` | Queues for a service desk |
| `get_service_desk_slas` | SLA definitions |
| `list_filters` | All shared filters |
| `list_dashboards` | All dashboards |
| `list_webhooks` | All webhooks |

### Users

| Tool | Description |
|---|---|
| `get_user` | User details by key |
| `find_users` | Search users by name/email |

### Analysis

| Tool | Description |
|---|---|
| `analyze_project_config_chain` | Resolve full scheme chain for a project, report inconsistencies |
| `search_config` | Free-text search across all config entities |

---

## Setup

### Prerequisites

- Python 3.11+
- Jira Data Center 10.x
- A Jira PAT with **Jira Administrator** permission (for full config reads)

### Install

```bash
cd jira-dc-mcp
pip install -e .
```

### Configuration

```bash
export JIRA_BASE_URL="https://jira.yourcompany.com"
export JIRA_AUTH_TYPE="pat"
export JIRA_PAT="your-personal-access-token"
# Optional:
export JIRA_VERIFY_SSL="false"   # for self-signed certs
```

### Run

**Stdio**:

```bash
python -m jira_dc_mcp
```

**SSE**:

```bash
python -m jira_dc_mcp --transport sse --port 8080
```

### MCP Client Configuration

Add to `.mcp.json`:

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
