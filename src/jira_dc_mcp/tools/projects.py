"""Project introspection tools."""

from __future__ import annotations

import json
from typing import Any

from ..client import JiraClient


async def list_projects(client: JiraClient) -> str:
    """List all projects with key metadata."""
    projects = await client.list_projects()
    result = [
        {
            "id": p.get("id"),
            "key": p.get("key"),
            "name": p.get("name"),
            "projectTypeKey": p.get("projectTypeKey"),
            "lead": p.get("lead", {}).get("displayName") if p.get("lead") else None,
            "description": (p.get("description") or "")[:200],
        }
        for p in projects
    ]
    return json.dumps(result, indent=2)


async def _get_project_config(client: JiraClient, project_key: str) -> dict[str, Any]:
    """Internal: resolve the full scheme chain for a project.

    Uses project-level endpoints (``/project/{key}/workflowscheme``, etc.)
    which are available on Jira DC 10.x.  Falls back gracefully when an
    endpoint returns 404/405.
    """
    import httpx

    project = await client.get_project(project_key)
    pid = int(project["id"])

    async def _try_get(path: str) -> dict | None:
        try:
            return await client.get(path)
        except httpx.HTTPStatusError:
            return None

    # Resolve workflow scheme via project-level endpoint
    wf_scheme = await _try_get(f"/rest/api/2/project/{project_key}/workflowscheme")

    # Notification, permission, and issue security schemes have project-level endpoints
    notif_scheme = await _try_get(f"/rest/api/2/project/{project_key}/notificationscheme")
    perm_scheme = await _try_get(f"/rest/api/2/project/{project_key}/permissionscheme")
    sec_scheme = await _try_get(f"/rest/api/2/project/{project_key}/issuesecuritylevelscheme")

    return {
        "key": project.get("key"),
        "name": project.get("name"),
        "id": pid,
        "projectTypeKey": project.get("projectTypeKey"),
        "lead": project.get("lead", {}).get("displayName") if project.get("lead") else None,
        "issueTypes": [
            {"id": it["id"], "name": it["name"], "subtask": it.get("subtask", False)}
            for it in project.get("issueTypes", [])
        ],
        "schemes": {
            "workflowScheme": {
                "id": wf_scheme.get("id") if wf_scheme else None,
                "name": wf_scheme.get("name") if wf_scheme else "Default",
                "defaultWorkflow": wf_scheme.get("defaultWorkflow") if wf_scheme else None,
                "issueTypeMappings": wf_scheme.get("issueTypeMappings", {}) if wf_scheme else {},
            },
            "notificationScheme": {
                "id": notif_scheme.get("id") if notif_scheme else None,
                "name": notif_scheme.get("name") if notif_scheme else "Default",
            },
            "permissionScheme": {
                "id": perm_scheme.get("id") if perm_scheme else None,
                "name": perm_scheme.get("name") if perm_scheme else "Default",
            },
            "issueSecurityScheme": {
                "id": sec_scheme.get("id") if sec_scheme else None,
                "name": sec_scheme.get("name") if sec_scheme else None,
            },
        },
    }


async def get_project_config(client: JiraClient, project_key: str) -> str:
    """Full configuration chain for a project."""
    result = await _get_project_config(client, project_key)
    return json.dumps(result, indent=2)


async def get_project_role_members(client: JiraClient, project_key: str) -> str:
    """Get all roles and their members for a project."""
    roles_map = await client.get_project_roles(project_key)
    result = {}
    for role_name, role_url in roles_map.items():
        # Extract role ID from URL
        role_id = int(role_url.rstrip("/").split("/")[-1])
        role_data = await client.get_project_role_actors(project_key, role_id)
        result[role_name] = {
            "id": role_id,
            "actors": [
                {
                    "displayName": a.get("displayName"),
                    "type": a.get("type"),
                    "name": a.get("name"),
                }
                for a in role_data.get("actors", [])
            ],
        }
    return json.dumps(result, indent=2)


async def get_project_components(client: JiraClient, project_key: str) -> str:
    comps = await client.get_project_components(project_key)
    result = [
        {
            "id": c.get("id"),
            "name": c.get("name"),
            "lead": c.get("lead", {}).get("displayName") if c.get("lead") else None,
            "assigneeType": c.get("assigneeType"),
            "description": c.get("description", ""),
        }
        for c in comps
    ]
    return json.dumps(result, indent=2)


async def get_project_versions(client: JiraClient, project_key: str) -> str:
    versions = await client.get_project_versions(project_key)
    result = [
        {
            "id": v.get("id"),
            "name": v.get("name"),
            "released": v.get("released", False),
            "archived": v.get("archived", False),
            "releaseDate": v.get("releaseDate"),
            "description": v.get("description", ""),
        }
        for v in versions
    ]
    return json.dumps(result, indent=2)


async def list_project_categories(client: JiraClient) -> str:
    """List all project categories."""
    categories = await client.list_project_categories()
    result = [
        {
            "id": c.get("id"),
            "name": c.get("name"),
            "description": c.get("description", ""),
        }
        for c in categories
    ]
    return json.dumps(result, indent=2)
