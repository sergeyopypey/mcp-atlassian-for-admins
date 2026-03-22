# TODO — Jira DC MCP Server

## What We Have (46 tools)

| Data | Tool | Status |
|---|---|---|
| Projects + issue types | `list_projects`, `get_project_config` | Working |
| Project role members | `get_project_role_members` | Working |
| Project components | `get_project_components` | Working |
| Project versions | `get_project_versions` | Working |
| Global config (statuses, priorities, resolutions, fields) | `dump_global_config` | Working |
| Fields (system + custom) | `list_fields` | Working |
| Workflows (statuses, transitions, screens, rule counts) | `list_workflows`, `get_workflow_statuses_and_transitions` | Working |
| Workflow detail (XML-parsed rules, properties) | `get_workflow_detail` | Working |
| Workflow schemes (issue type → workflow mapping) | `list_workflow_schemes`, `get_workflow_scheme` | Working |
| Transition screens with fields | included in workflow tool | Working |
| JSM approval detection | included in workflow tool | Working |
| Permission schemes | `list_permission_schemes`, `get_permission_scheme` | Working |
| Notification schemes | `list_notification_schemes`, `get_notification_scheme` | Working |
| Issue security schemes | `get_issue_security_scheme` | Working |
| Priority schemes | `get_priority_scheme` | Working |
| Screens (489 total) | `list_screens`, `get_screen_tabs_and_fields` | Working |
| Screen schemes (180 total) | `list_screen_schemes`, `get_screen_scheme` | Working (reconstructed from screens expand) |
| Issue type schemes (49 total) | `list_issue_type_schemes`, `get_issue_type_scheme` | Working |
| Automation rules (886 rules) | `list_automation_rules`, `get_automation_rule_detail`, `refresh_automation_cache` | Working |
| Field usage on screens | `find_field_usage` | Working (screens only) |
| Custom field contexts | `get_field_contexts` | Working (internal API, unsupported) |
| Scheme overview | `list_all_scheme_types`, `dump_all_schemes` | Working |
| Full instance dump | `dump_full_instance` | Working |
| Bulk dumps | `dump_workflows`, `dump_automation_rules` | Working |
| Config chain analysis | `analyze_project_config_chain` | Working |
| Free-text config search | `search_config` | Working |
| Agile boards | `list_boards`, `get_board_configuration` | Working |
| JSM service desks | `list_service_desks` | Working |
| JSM SLAs | `get_service_desk_slas` | Working |
| JSM queues | `get_service_desk_queues` | Working |
| Filters (JQL) | `list_filters` | Working |
| Dashboards | `list_dashboards` | Working |
| Webhooks | `list_webhooks` | Working |
| Project categories | `list_project_categories` | Working |

## What's Missing

### Medium Impact

- [ ] **Issue link usage patterns** — We know 18 link types exist, but not which ones are actually used between which projects (e.g., "INCIDENT always links to ASS via 'Action item of incident'"). Requires JQL search sampling, not a config endpoint.

### Done (previously listed as missing)

- [x] **Board configurations** — `list_boards`, `get_board_configuration` via Agile REST API.
- [x] **SLAs** (JSM) — `get_service_desk_slas` via Service Desk API.
- [x] **Queues** (JSM) — `get_service_desk_queues` via Service Desk API.
- [x] **Webhooks / external integrations** — `list_webhooks` via REST API v2.
- [x] **Filters & dashboards** — `list_filters`, `list_dashboards` via REST API v2.
- [x] **Project categories** — `list_project_categories` via REST API v2.
- [x] **Custom field contexts** — Implemented via `get_field_contexts` using internal API `/rest/internal/2/field/{id}/context`.
- [x] **Transition rule details** — `get_workflow_detail` parses workflow XML to extract conditions, validators, and post-functions (class names, args). The Designer API (`get_workflow_statuses_and_transitions`) still only shows counts, but the XML parser gets the actual logic.
- [x] **Workflow properties** — `get_workflow_detail` extracts `jira.issue.editable` and other properties from workflow XML.

## Unavailable on DC 10.3.12 (no REST API)

These endpoints don't exist on Jira DC 10.3.12. Workarounds applied where possible.

- **Screen schemes** — `GET /rest/api/2/screenscheme` → 404. **FIXED**: reconstructed from `GET /rest/api/2/screens?expand=fieldScreenSchemes` which reveals the screen→scheme relationship. Operation (create/edit/view) is inferred from screen names. Returns 180 schemes.
- **Issue type screen schemes** — `GET /rest/api/2/issuetypescreenscheme` → 404. No workaround found. Use `createmeta` per project+issuetype to see which fields appear on create screens.
- **Field configurations** — `GET /rest/api/2/fieldconfiguration` → 404. No workaround found. Use `createmeta`/`editmeta` to see field required/hidden state per issue type.
- **Field configuration schemes** — `GET /rest/api/2/fieldconfigurationscheme` → 404. No workaround found.
- **Custom field contexts** — `GET /rest/api/2/fieldconfiguration` → 404. **FIXED**: use internal (unsupported) `GET /rest/internal/2/field/{id}/context` endpoint.
- **Issue type scheme mappings** — `GET /rest/api/2/issuetypescheme/mapping` → 400. **FIXED**: use `?expand=issueTypes` on individual scheme GET.

## Bugs Fixed (2026-03-22)

### Round 1 — Initial fixes
- `list_workflows` — was using `get_paged()` on an endpoint that returns a plain array. Fixed to use `self.get()`.
- `list_workflow_schemes` — `GET /rest/api/2/workflowscheme` returns 405 on DC 10.3.12. Added fallback that discovers scheme IDs via `/rest/api/2/project/{key}/workflowscheme` per project.
- `_get_project_config` — was using Cloud-only association endpoints (`/issuetypescheme/project`, etc.). Rewritten to use DC project-level endpoints.
- `_safe()` in `dump.py` — now logs HTTP status codes alongside errors.

### Round 2 — Cloud-vs-DC endpoint fixes
- `list_screens` — was using pagination key `"values"`, DC 10 uses `"screens"`. Fixed. Now returns 489 screens.
- `list_issue_type_schemes` — was using `get_paged()` with key `"values"`, DC 10 returns all in `"schemes"` key (not paginated). Fixed.
- `get_issue_type_scheme` — was calling non-existent `/mapping` sub-resource. Fixed to use `?expand=issueTypes,defaultIssueType` on individual GET.
- `export_automation_rules` — was missing `"rules"` key in response parsing. DC returns `{"rules": [...]}` but code only checked for `"results"` and `"values"`. Fixed. Now returns 886 rules.
- `list_screen_schemes` — endpoint 404 on DC. Added try/except, returns empty list gracefully.
- `list_issue_type_screen_schemes` — endpoint 404 on DC. Added try/except, returns empty list gracefully.
- `list_field_configurations` — endpoint 404 on DC. Added try/except, returns empty list gracefully.
- `list_field_configuration_schemes` — endpoint 404 on DC. Added try/except, returns empty list gracefully.
- `get_field_configuration` / `get_field_configuration_scheme` — now return explicit "unavailable" error message instead of crashing.
- `find_field_usage` — field configuration part now shows "unavailable on DC 10" instead of empty.
- `list_all_scheme_types` — removed broken scheme types, added screens count, marks unavailable types.
- `dump_all_schemes` — removed broken scheme fetches, added screens count, lists unavailable types.

## Known API Limitations (Jira DC 10.3.12)

- `GET /rest/api/2/workflowscheme` (collection) — returns 405. Individual `GET /rest/api/2/workflowscheme/{id}` works.
- `GET /rest/api/2/screenscheme` — returns 404. No alternative known.
- `GET /rest/api/2/issuetypescreenscheme` — returns 404. No alternative known.
- `GET /rest/api/2/fieldconfiguration` — returns 404. No alternative known.
- `GET /rest/api/2/fieldconfigurationscheme` — returns 404. No alternative known.
- `GET /rest/api/2/issuetypescheme/mapping` — returns 400. Workaround: `?expand=issueTypes` on individual GET.
- `GET /rest/api/2/issuetypescheme/project` — returns 400 ("not a valid scheme id: project").
- Transition rule details (conditions/validators/post-functions content) — not available via REST API; admin JSP pages require browser session (302 redirect with PAT).
- Workflow Designer plugin (`/rest/workflowDesigner/latest/workflows`) — returns layout with statuses, transitions, screen refs, and rule counts but not rule content.
- **Rate limiting** — Jira DC returns 403 after ~50+ rapid concurrent requests. Bulk dump tools affected. Individual tools recover after ~10s pause.
