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
| `fieldConfigurations.groovy` | `/fieldConfigurations` | P0 | Field configurations with field items (required/hidden/renderer) |
| `fieldConfigurationSchemes.groovy` | `/fieldConfigurationSchemes` | P0 | Field configuration schemes with issue type mappings and project associations |
| `screenSchemes.groovy` | `/screenSchemes` | P0 | Screen schemes with operation→screen mappings |
| `issueTypeScreenSchemes.groovy` | `/issueTypeScreenSchemes` | P0 | Issue type screen schemes with issue type→screen scheme mappings |
| `workflowTransitionDetails.groovy` | `/workflowTransitionDetails` | P1 | Full transition rule config (post-function params, condition/validator args) |
| `customFieldContexts.groovy` | `/customFieldContexts` | P1 | Custom field contexts with project/issue type scoping |
| `listeners.groovy` | `/listeners` | P1 | All registered event listeners |
| `scheduledServices.groovy` | `/scheduledServices` | P2 | Jira scheduled services (mail handlers, etc.) |
| `applicationLinks.groovy` | `/applicationLinks` | P2 | Application links to Confluence, Bitbucket, etc. |
| `effectivePermissions.groovy` | `/effectivePermissions` | P2 | Resolved effective permissions for user+project |

## Authentication

These endpoints inherit ScriptRunner's authentication. Callers must authenticate with Jira credentials (Basic auth or PAT) that have admin privileges.

## Notes

- All endpoints are read-only (GET only)
- Responses are JSON with `Content-Type: application/json`
- Designed for Jira DC 10.x but should work on 8.x/9.x as well
- Some endpoints accept query parameters for filtering — see individual file headers
