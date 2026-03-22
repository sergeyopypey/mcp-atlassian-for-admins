# TODO

## Known limitations (Jira DC v10.3.12)

### 1. Workflow transition details (validators, post-functions, conditions)

The Jira DC REST API does not expose workflow transition rules via REST.
`/rest/api/2/workflow/search?expand=transitions.rules` returns 404 on this version.

Currently the `get_workflow` tool only returns statuses and transitions with **counts** of conditions/validators/post-functions (via `/rest/workflowDesigner/1.0/workflows`), but not the actual rule definitions.

**Possible solutions:**
- **Jira upgrade** — `transitions.rules` expand was added in later DC versions
- **ScriptRunner custom endpoint** — write a REST endpoint that reads the workflow XML descriptor
- **Direct DB query** — workflow XML is in the `jiraworkflows` table

**Interim improvement:**
- Update `get_workflow` tool to return transition rule counts from the workflow designer API

### 2. Endpoints returning 404 (not available on this DC version)

| Endpoint | Purpose |
|----------|---------|
| `/rest/api/2/issuetypescreenscheme` | Issue type screen scheme mappings |
| `/rest/api/2/screenscheme` | Screen schemes list |
| `/rest/api/2/fieldconfiguration` | Field configurations list |
| `/rest/api/2/fieldconfigurationscheme` | Field configuration schemes |

**Workaround:** Screen scheme associations are available via `/rest/api/2/screens?expand=fieldScreenSchemes` (already implemented in `list_screens`). No workaround found for field configurations.

### 3. `list_workflow_schemes` is slow

GET `/rest/api/2/workflowscheme` returns 405 on this version, so the tool iterates all projects to collect workflow schemes via `/rest/api/2/project/{key}/workflowscheme`. This is slow with many projects.

**Possible solution:** Cache the result, or find an alternative endpoint.

### 4. Dual auth requirement

The PAT (Bearer token) only works for the Automation API (`/rest/cb-automation/latest/...`). The standard REST API (`/rest/api/2/...`) requires Basic auth (username:password). Both credentials are read from files (`.jira-token`, `.jira-basic`) to avoid env var mangling by Claude Code's MCP transport.

### 5. `get_workflow` uses basic REST API (limited data)

The `/rest/api/2/workflow?workflowName=...` endpoint returns only summary info (name, description, step count). Full workflow details (statuses, transitions, layout) require the `/rest/workflowDesigner/1.0/workflows` endpoint which is already used in manual bash calls but not yet integrated into the tool.

**TODO:** Update `get_workflow` to use the workflow designer API for richer data.
