# TODO — Jira DC MCP Server

- **ScriptRunner script registry** — no tool exposes ScriptRunner's own
  registry: its REST endpoints, script listeners, custom script fields,
  behaviours, scheduled/escalation jobs and fragments, plus the registered
  script roots and script bodies/paths. `list_listeners` and
  `list_scheduled_services` only cover what Jira itself sees — not
  ScriptRunner's full inventory. A `jiraMcpScriptRegistry` endpoint enumerating
  every registered ScriptRunner item (name, type, enabled state, script
  path/body) is needed. An earlier ad-hoc registry probe was removed; not
  restarted.

- **`get_effective_permissions` by-permission mode** — the "who holds
  permission X" path uses a `PermissionManager.getAllUsers` signature that does
  not exist on this Jira version. Fix or replace it; the by-user path already
  works and the Groovy fails the other path gracefully for now.

- **Issue link usage patterns** — which link types are actually used between
  which projects. Requires JQL search sampling, not a config endpoint.
