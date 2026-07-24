# TODO — Jira DC MCP Server

- **`get_effective_permissions` by-permission mode** — the "who holds
  permission X" path uses a `PermissionManager.getAllUsers` signature that does
  not exist on this Jira version. Fix or replace it; the by-user path already
  works and the Groovy fails the other path gracefully for now.

- **Issue link usage patterns** — which link types are actually used between
  which projects. Requires JQL search sampling, not a config endpoint.
