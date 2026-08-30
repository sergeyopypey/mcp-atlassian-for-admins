# Jira Data Center 10 MCP Server (TypeScript)

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Node.js >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)
![MCP](https://img.shields.io/badge/Model_Context_Protocol-server-purple)

A **read-only** Model Context Protocol (MCP) server for deep introspection of
**Jira Data Center 10** — 76 tools covering projects, workflows, schemes,
fields, automation, Assets (Insight), and more.

> **Read-only** — this server cannot modify any Jira configuration.

## Why

Jira DC administration is config archaeology: the answer to "why did this
happen?" hides somewhere in a chain of workflow → post-functions → automation
rules → permission/field/screen schemes, and the admin UI shows that chain one
screen at a time. This server hands the whole picture to an AI assistant in a
single conversation — it can trace a project's full scheme chain, explain why
an automation rule fired (or didn't), find every screen a custom field sits
on, resolve who effectively holds a permission, or grep the server log,
without SSH access and without any ability to change anything.

Most data comes from Jira's native REST API. The parts Jira only exposes
through its Java API — listeners, scheduled services, effective permissions,
transition rule internals, server logs — are unlocked by a companion set of
ScriptRunner REST endpoints (a single GET-only Groovy file, see
[`scriptrunner-endpoints/`](scriptrunner-endpoints/)).

## Example prompts

- *"Why didn't the automation rule 'Notify on escalation' fire for PROJ-123 yesterday?"*
- *"Compare the workflows of projects A and B and list every difference in transitions and post-functions."*
- *"Which screens, projects and issue types still use the custom field 'Severity'? Can I delete it?"*
- *"Who effectively has 'Delete Issues' permission in PROJ, and through which groups or roles?"*
- *"Grep atlassian-jira.log for indexing errors around 14:00 and summarize the stack traces."*

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

### Response size

MCP clients cap the size of a single tool result (Claude Code drops results over
~25k tokens), and a large Jira has thousands of fields, rules, and workflows. So
tool output is compact JSON, and instance-wide listings are paginated: they take
`offset`/`limit` plus filters such as `name_contains` or `project_key`, and
return `{ total, offset, returned, nextOffset, items }`. A result that still
exceeds `JIRA_MCP_MAX_RESPONSE_CHARS` (default `60000`; `0` disables the check)
is replaced by an error that tells the model how to narrow the call.

## Self-test

`npm run selftest` exercises all 76 tools against the live Jira instance and
prints a coverage report — one line per tool variant, then a summary. It
auto-discovers the IDs/keys parameterised tools need (project keys, scheme IDs,
workflow names, ...) from the `list_*`/`dump_*` tools, so no manual setup is
needed. Credentials are read from the environment, falling back to the
`jira-dc` server's `env` block in `.mcp.json`.

```bash
npm run selftest                          # all 76 tools
npm run selftest -- --only get_workflow_detail   # one tool (deps auto-included)
npm run selftest -- --skip find_field_usage      # exclude slow tools
```

Each tool's raw JSON output is written to `selftest-output/<tool>.json`, with a
full machine-readable report at `selftest-output/_report.json`. Flags:
`--only`, `--skip`, `--out-dir PATH`, `--json PATH`.

## Tools

All 76 tools are read-only against Jira (one, `dump_script_registry`, also writes
its export bundle to a local directory). Tools marked † require the companion ScriptRunner
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
- `list_screen_schemes` — screen schemes with operation mappings; paginated
- `get_screen_scheme` — one screen scheme with screens and tabs
- `list_issue_type_screen_schemes` † — issue-type-to-screen-scheme mappings and projects; paginated, filter by project
- `get_issue_type_screen_scheme` — one issue type screen scheme

**Fields**

- `list_fields` — system and custom fields with types; paginated, filter by name
- `list_custom_fields_usage` — custom fields with usage stats (issues, projects, screens); paginated
- `get_field_configuration` — field config items: required, hidden, renderer; paginated, filter by field or required/hidden
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

- `list_automation_rules` — Automation for Jira (A4J) rules from the cache; paginated, filter by project or name
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

**Assets (Insight)**

Read-only introspection of Atlassian Assets (formerly Insight) on Data Center.
Uses the `/rest/insight/1.0` API on the Jira host with IQL; override the base
path with the optional `ASSETS_API_BASE` env var (default `/rest/insight/1.0`).
The PAT user needs read access to the relevant Assets object schemas.

- `list_object_schemas` — all Assets object schemas with key, status, object/type counts
- `get_object_schema` — one object schema's metadata by ID
- `list_object_types` — object types in a schema (flat list, or hierarchical tree)
- `get_object_type` — one object type's metadata (parent, position, abstract, icon)
- `get_object_type_attributes` — attribute definitions for an object type (type, references, cardinality, required)
- `get_schema_attributes` — all attribute definitions across a schema
- `list_object_statuses` — Assets status types and categories (global or schema-scoped)
- `search_objects_iql` — search objects with IQL (Insight Query Language); first 25 matches by default, plus the total count
- `get_object` — one object by ID with its attribute values
- `get_object_connected_tickets` — Jira issues connected to an object
- `dump_assets_schema` — full structural snapshot: schema, statuses, and all object types with attributes

**Filters & Dashboards**

- `list_filters` — favourite/shared JQL filters
- `list_dashboards` — dashboards with view URL; paginated, filter by name

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

**Administration** († ScriptRunner-backed)

- `list_listeners` † — registered event listeners
- `list_scheduled_services` † — scheduled services with cron schedules
- `list_application_links` † — links to Confluence, Bitbucket, Bamboo, etc.
- `get_effective_permissions` † — effective project permissions via groups, roles, grants
- `dump_plugin_inventory` — installed apps with version, enabled state, and license (user-installed by default)

**Server logs** († ScriptRunner-backed, System Administrators only)

- `list_server_log_files` † — log files in the Jira and Tomcat log directories with size and mtime; paginated, filter by name
- `tail_server_log` † — last N lines of a log file (default `atlassian-jira.log`)
- `grep_server_log` † — regex search over a log file and its rotations, with before/after context; matches return in chronological order

**Dump**

- `dump_global_config` — issue types, statuses, resolutions, priorities, link types, field counts
- `dump_workflows` — workflows with statuses and transitions (rules with `detail`); paginated
- `dump_automation_rules` — full A4J rules from the cache; paginated, filter by project or name
- `dump_script_registry` — full ScriptRunner inventory (listeners, REST endpoints, jobs, behaviours, fragments, script fields, resources, workflow functions, script-root `.groovy` files, instance metadata, `Output.csv`) reproducing ScriptRunner's "Export all scripts" bundle. **Writes the bundle to a local directory** (`output_dir`); reads from Jira are read-only.

## License

[MIT](LICENSE) © sergeyopypey, Ivnrv, peppingdore
