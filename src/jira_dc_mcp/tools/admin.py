"""Instance-administration introspection tools.

These expose data invisible to Jira DC's standard REST API (event listeners,
scheduled services, application links, effective permissions) via ScriptRunner
custom endpoints. If an endpoint is missing or erroring, the underlying client
call raises — the failure surfaces as a tool error rather than a silent empty
result.
"""

from __future__ import annotations

import json

from ..client import JiraClient


async def list_listeners(client: JiraClient) -> str:
    """List all registered event listeners (built-in, plugin, ScriptRunner)."""
    listeners = await client.list_listeners()
    return json.dumps({"count": len(listeners), "listeners": listeners}, indent=2)


async def list_scheduled_services(client: JiraClient) -> str:
    """List Jira scheduled services (mail handlers, backups, etc.) with schedules."""
    services = await client.list_scheduled_services()
    return json.dumps({"count": len(services), "services": services}, indent=2)


async def list_application_links(client: JiraClient) -> str:
    """List application links to Confluence, Bitbucket, Bamboo, etc."""
    links = await client.list_application_links()
    return json.dumps({"count": len(links), "applicationLinks": links}, indent=2)


async def get_effective_permissions(
    client: JiraClient,
    project_key: str,
    username: str | None = None,
    permission: str | None = None,
) -> str:
    """Resolve effective permissions for a user and/or a permission on a project.

    Pass ``username`` to get every permission that user holds on the project,
    and/or ``permission`` to get every user that holds that permission.
    """
    if not username and not permission:
        return json.dumps({"error": "Provide at least one of 'username' or 'permission'"})
    data = await client.get_effective_permissions(project_key, username, permission)
    return json.dumps(data, indent=2)
