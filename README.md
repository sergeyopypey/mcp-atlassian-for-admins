# Jira Data Center 10 MCP Server (TypeScript)

A **read-only** Model Context Protocol (MCP) server for deep introspection of
**Jira Data Center 10** — 60 tools covering projects, workflows, schemes,
fields, automation, and more.

> **Read-only** — this server cannot modify any Jira configuration.

## Prerequisites

- Node.js 20 LTS or newer
- Jira Data Center 10.x
- A Jira PAT with **Jira Administrator** permission (for full config reads)

## Building

```bash
npm install
npm run build
```

## MCP client configuration

See `.mcp.json.example` for an example configuration file.

## Tools

All 60 tools are read-only. Tools marked † require the companion ScriptRunner
Groovy endpoints (see [`scriptrunner-endpoints/`](scriptrunner-endpoints/)).

**Projects**

- `list_projects` — all projects with key, name, type, lead
- `get_project_config` — a project's full scheme chain and issue types
- `get_project_role_members` — roles and their members/actors for a project
- `get_project_components` — components with leads and descriptions
- `get_project_versions` — versions with release status and dates
- `list_project_categories` — all project categories

**Workflows**

- `list_active_workflows` — active workflows (excludes backups and copies)
- `list_all_workflows` — all workflows including backups and deprecated
- `get_workflow_detail` — full workflow: statuses, transitions, conditions, validators, post-functions
- `get_workflow_statuses_and_transitions` — statuses and transitions with screens and fields
- `list_workflow_schemes` — all workflow schemes with issue-type mappings
- `get_workflow_scheme` — one workflow scheme by ID
- `get_workflow_transition_details` † — full transition rule config (post-function, condition, validator args)

**Screens**

- `list_screens` — all screens with IDs and names
- `get_screen_tabs_and_fields` — a screen's tabs and ordered fields
- `list_screen_schemes` — all screen schemes with operation mappings
- `get_screen_scheme` — one screen scheme with screens and tabs
- `list_issue_type_screen_schemes` † — issue-type-to-screen-scheme mappings and projects
- `get_issue_type_screen_scheme` — one issue type screen scheme

**Fields**

- `list_fields` — all system and custom fields with types
- `list_custom_fields_usage` — custom fields with usage stats (issues, projects, screens)
- `get_field_configuration` — field config items: required, hidden, renderer
- `get_field_configuration_scheme` — maps issue types to field configurations
- `find_field_usage` — where a field appears across all screens
- `get_createmeta_fields` — fields on the create screen for a project + issue type
- `get_field_contexts` — custom field contexts: project and issue-type scope

**Schemes**

- `get_permission_scheme` — full permission scheme with all grants
- `list_permission_schemes` — all permission schemes with grant counts
- `get_notification_scheme` — event-to-notification mappings
- `list_notification_schemes` — all notification schemes
- `get_issue_type_scheme` — available issue types and the default
- `get_issue_security_scheme` — issue security scheme with security levels
- `get_priority_scheme` — priority scheme (Jira DC 10)

**Automation**

- `list_automation_rules` — Automation for Jira (A4J) rules from the cache
- `get_automation_rule_detail` — full rule: trigger, conditions, actions, smart values
- `get_automation_audit_log` — recent executions across all rules
- `get_automation_rule_audit_log` — execution history for one rule
- `get_automation_audit_item` — detail for a single audit entry
- `refresh_automation_cache` — force an automation cache refresh

**Boards**

- `list_boards` — all agile boards (Scrum/Kanban)
- `get_board_configuration` — columns, WIP limits, estimation, ranking, backing filter

**Service Desk**

- `list_service_desks` — all JSM service desks with project associations
- `get_service_desk_queues` — queues for a JSM service desk

**Filters & Dashboards**

- `list_filters` — favourite/shared JQL filters
- `list_dashboards` — all dashboards with owner and popularity

**Analysis**

- `analyze_project_config_chain` — resolve a project's scheme chain, report inconsistencies
- `search_config` — free-text search across all config entities

**Issues**

- `get_issue` — a Jira issue by key
- `get_issue_changelog` — an issue's edit history

**Users**

- `get_user` — user details by key, username, or ID
- `find_users` — search users by name or email
- `get_user_groups` — groups a user belongs to
- `get_group_members` — members of a group

**Administration** (all † ScriptRunner-backed)

- `list_listeners` † — registered event listeners
- `list_scheduled_services` † — scheduled services with cron schedules
- `list_application_links` † — links to Confluence, Bitbucket, Bamboo, etc.
- `get_effective_permissions` † — effective project permissions via groups, roles, grants

**Dump**

- `dump_global_config` — all fields, issue types, statuses, resolutions, priorities, link types
- `dump_workflows` — all workflows with statuses, transitions, and rules
- `dump_automation_rules` — all A4J rules from the cache
