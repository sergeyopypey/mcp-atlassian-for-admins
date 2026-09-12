# ScriptRunner Custom REST Endpoints

Custom REST endpoints for Jira Data Center that expose Java API data unavailable through the standard REST API. All endpoints live in a single script, [`jiraMcpEndpoints.groovy`](jiraMcpEndpoints.groovy).

## Installation

1. In Jira, go to **Manage apps → ScriptRunner → REST Endpoints**
2. Click **Create REST Endpoint** (or **Add New Item**)
3. Paste the contents of `jiraMcpEndpoints.groovy` (one script registers all endpoints)
4. Each endpoint becomes available at `/rest/scriptrunner/latest/custom/<endpointName>`

## Endpoints

| Endpoint Path | Description |
|---------------|-------------|
| `/jiraMcpFieldConfigurations` | Field configurations with field items (required/hidden/renderer) |
| `/jiraMcpFieldConfigurationSchemes` | Field configuration schemes with issue type mappings and project associations |
| `/jiraMcpScreenSchemes` | Screen schemes with operation→screen mappings |
| `/jiraMcpIssueTypeScreenSchemes` | Issue type screen schemes with issue type→screen scheme mappings |
| `/jiraMcpCustomFieldContexts` | Custom field contexts with project/issue type scoping |
| `/jiraMcpListeners` | All registered event listeners |
| `/jiraMcpScheduledServices` | Jira scheduled services (mail handlers, etc.) |
| `/jiraMcpApplicationLinks` | Application links to Confluence, Bitbucket, etc. |
| `/jiraMcpEffectivePermissions` | Resolved effective permissions for user+project |
| `/jiraMcpExportWorkflow` | Workflow OpenSymphony XML descriptor (powers `get_workflow`, `search_workflow_rules`); requires the Jira Administrators global permission |
| `/jiraMcpServerLog` | List/tail/grep server log files; restricted to the Jira/Tomcat log directories; requires the System Administrators global permission |

All endpoints are wired into working MCP tools (see the project README).
A tool surfaces a clear error if its endpoint is missing or failing — failures
are not silently degraded.

## Authentication

These endpoints inherit ScriptRunner's authentication. Callers must authenticate with Jira credentials (Basic auth or PAT) that have admin privileges.

The two sensitive endpoints check a global permission in code rather than a group name, since the admin group is named differently across instances: `/jiraMcpExportWorkflow` needs Jira Administrators, `/jiraMcpServerLog` needs System Administrators.

## Notes

- All endpoints are read-only (GET only)
- Responses are JSON with `Content-Type: application/json`
- Designed for Jira DC 10.x but should work on 8.x/9.x as well
- Some endpoints accept query parameters for filtering — see the section headers inside `jiraMcpEndpoints.groovy`
