# TODO — Jira DC MCP Server

## Tools (60)

Read-only introspection of a Jira Data Center instance. Tools marked **(SR)**
are backed by a ScriptRunner custom endpoint (`scriptrunner-endpoints/`) because
the data is not available through the native REST API.

| Area | Tools |
|---|---|
| Dump | `dump_global_config`, `dump_workflows`, `dump_automation_rules` |
| Projects | `list_projects`, `get_project_config`, `get_project_role_members`, `get_project_components`, `get_project_versions`, `list_project_categories` |
| Workflows | `list_active_workflows`, `list_all_workflows`, `get_workflow_detail` **(SR)**, `get_workflow_statuses_and_transitions`, `list_workflow_schemes`, `get_workflow_scheme`, `get_workflow_transition_details` **(SR)** |
| Screens | `list_screens`, `get_screen_tabs_and_fields`, `list_screen_schemes` **(SR)**, `get_screen_scheme` **(SR)**, `list_issue_type_screen_schemes` **(SR)**, `get_issue_type_screen_scheme` **(SR)** |
| Fields | `list_fields`, `list_custom_fields_usage`, `get_field_configuration` **(SR)**, `get_field_configuration_scheme` **(SR)**, `find_field_usage`, `get_createmeta_fields`, `get_field_contexts` **(SR)** |
| Schemes | `get_permission_scheme`, `list_permission_schemes`, `get_notification_scheme`, `list_notification_schemes`, `get_issue_type_scheme`, `get_issue_security_scheme`, `get_priority_scheme` |
| Automation (A4J) | `list_automation_rules`, `get_automation_rule_detail`, `get_automation_audit_log`, `get_automation_rule_audit_log`, `get_automation_audit_item`, `refresh_automation_cache` |
| Boards & JSM | `list_boards`, `get_board_configuration`, `list_service_desks`, `get_service_desk_queues` |
| Filters & dashboards | `list_filters`, `list_dashboards` |
| Issues | `get_issue`, `get_issue_changelog` |
| Users | `get_user`, `find_users`, `get_user_groups`, `get_group_members` |
| Analysis | `analyze_project_config_chain`, `search_config` |
| Administration **(SR)** | `list_listeners`, `list_scheduled_services`, `list_application_links`, `get_effective_permissions` |

`run_selftest.py` exercises every tool against a live instance and reports
per-tool pass/fail plus coverage.

## ScriptRunner custom endpoints

`scriptrunner-endpoints/` holds eleven Groovy endpoints (field configurations,
field configuration schemes, screen schemes, issue type screen schemes, workflow
transition details, workflow XML export, custom field contexts, listeners,
scheduled services, application links, effective permissions). All are wired
into the tools above.
A ScriptRunner-backed tool surfaces a clear error if its endpoint is missing or
failing — failures are not silently degraded.

## Future work

- **`get_effective_permissions` by-permission mode** — the "who holds permission
  X" path uses a `PermissionManager.getAllUsers` signature that does not exist on
  this version; the by-user path works and the Groovy fails the other path
  gracefully.
- **Plugin inventory** — a `jiraMcpPluginInventory` endpoint (installed apps,
  versions, enabled state, license) via `PluginAccessor`. Not started.
- **Issue link usage patterns** — which link types are actually used between
  which projects. Requires JQL search sampling, not a config endpoint.

## Removed

- `list_webhooks` / `get_service_desk_slas` — no accessible API on Jira DC. Jira
  System webhooks have no Java or REST API (Crowd's `WebhookRegistry` exposes
  only Crowd webhooks); JSM SLA configuration is not exposed by the servicedeskapi
  and the internal SLA Java API class is unidentified.
- `dump_all_schemes`, `dump_full_instance`, `list_all_scheme_types` — redundant
  with the per-scheme tools and targeted dumps.

## Native DC REST gaps (worked around)

These native endpoints fail on Jira DC; each is now served another way:

- Screen schemes (`/screenscheme` → 404) → `jiraMcpScreenSchemes`.
- Issue type screen schemes (`/issuetypescreenscheme` → 404) → `jiraMcpIssueTypeScreenSchemes`.
- Field configurations (`/fieldconfiguration` → 404) → `jiraMcpFieldConfigurations`.
- Field configuration schemes (`/fieldconfigurationscheme` → 404) → `jiraMcpFieldConfigurationSchemes`.
- Custom field contexts → `jiraMcpCustomFieldContexts` (replaced the unsupported internal API).
- Workflow transition rule content → `jiraMcpWorkflowTransitionDetails`.
- Workflow schemes (`/workflowscheme` collection → 405) → discovered per-project, fanned out concurrently.
- Issue type scheme mappings (`/issuetypescheme/mapping` → 400) → `?expand=issueTypes` on the individual GET.
- Priority schemes → plural `/rest/api/2/priorityschemes` (the singular path 404s).

## Known API limitations (Jira DC 10.3.12)

- Workflow Designer plugin (`/rest/workflowDesigner/latest/workflows`) — returns
  layout, statuses, transitions and rule counts, but not rule content.
- **Rate limiting** — Jira DC returns 403 after ~50+ rapid concurrent requests;
  ScriptRunner fan-out and per-project discovery are capped at 10 concurrent.
