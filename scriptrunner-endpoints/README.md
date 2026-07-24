# ScriptRunner Custom REST Endpoints

Custom REST endpoints for Jira Data Center that expose Java API data unavailable through the standard REST API.

## Installation

1. In Jira, go to **Manage apps → ScriptRunner → REST Endpoints**
2. Click **Create REST Endpoint** (or **Add New Item**)
3. Paste the contents of each `.groovy` file
4. Each endpoint will be available at `/rest/scriptrunner/latest/custom/<endpointName>`

## Endpoints

| File | Endpoint Path | Priority | Description |
|------|--------------|----------|-------------|
| `jiraMcpFieldConfigurations.groovy` | `/jiraMcpFieldConfigurations` | P0 | Field configurations with field items (required/hidden/renderer) |
| `jiraMcpFieldConfigurationSchemes.groovy` | `/jiraMcpFieldConfigurationSchemes` | P0 | Field configuration schemes with issue type mappings and project associations |
| `jiraMcpScreenSchemes.groovy` | `/jiraMcpScreenSchemes` | P0 | Screen schemes with operation→screen mappings |
| `jiraMcpIssueTypeScreenSchemes.groovy` | `/jiraMcpIssueTypeScreenSchemes` | P0 | Issue type screen schemes with issue type→screen scheme mappings |
| `jiraMcpWorkflowTransitionDetails.groovy` | `/jiraMcpWorkflowTransitionDetails` | P1 | Full transition rule config (post-function params, condition/validator args) |
| `jiraMcpCustomFieldContexts.groovy` | `/jiraMcpCustomFieldContexts` | P1 | Custom field contexts with project/issue type scoping |
| `jiraMcpListeners.groovy` | `/jiraMcpListeners` | P1 | All registered event listeners |
| `jiraMcpScheduledServices.groovy` | `/jiraMcpScheduledServices` | P2 | Jira scheduled services (mail handlers, etc.) |
| `jiraMcpApplicationLinks.groovy` | `/jiraMcpApplicationLinks` | P2 | Application links to Confluence, Bitbucket, etc. |
| `jiraMcpEffectivePermissions.groovy` | `/jiraMcpEffectivePermissions` | P2 | Resolved effective permissions for user+project |
| `jiraMcpExportWorkflow.groovy` | `/jiraMcpExportWorkflow` | — | Workflow OpenSymphony XML descriptor (powers `get_workflow_detail`) |
| `jiraMcpServerLog` (in `jiraMcpEndpoints.groovy`) | `/jiraMcpServerLog` | P1 | List/tail/grep server log files; restricted to the Jira/Tomcat log directories and `jira-administrators` |

All endpoints above are wired into working MCP tools (see the project README).
A tool surfaces a clear error if its endpoint is missing or failing — failures
are not silently degraded.

## Authentication

These endpoints inherit ScriptRunner's authentication. Callers must authenticate with Jira credentials (Basic auth or PAT) that have admin privileges.

## Notes

- All endpoints are read-only (GET only)
- Responses are JSON with `Content-Type: application/json`
- Designed for Jira DC 10.x but should work on 8.x/9.x as well
- Some endpoints accept query parameters for filtering — see individual file headers
