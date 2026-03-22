"""Scheme introspection tools — permissions, notifications, issue security, priorities."""

from __future__ import annotations

import json

from ..client import JiraClient


async def get_permission_scheme(client: JiraClient, scheme_id: int) -> str:
    """Get full permission scheme with all grants."""
    scheme = await client.get_permission_scheme(scheme_id)
    permissions = scheme.get("permissions", [])

    result = {
        "id": scheme.get("id"),
        "name": scheme.get("name"),
        "description": scheme.get("description", ""),
        "grants": [
            {
                "permission": p.get("permission"),
                "holder": {
                    "type": p.get("holder", {}).get("type"),
                    "parameter": p.get("holder", {}).get("parameter"),
                    "value": p.get("holder", {}).get("value"),
                },
            }
            for p in permissions
        ],
        "grantCount": len(permissions),
    }
    return json.dumps(result, indent=2)


async def list_permission_schemes(client: JiraClient) -> str:
    schemes = await client.list_permission_schemes()
    result = [
        {
            "id": s.get("id"),
            "name": s.get("name"),
            "description": s.get("description", ""),
            "grantCount": len(s.get("permissions", [])),
        }
        for s in schemes
    ]
    return json.dumps(result, indent=2)


async def get_notification_scheme(client: JiraClient, scheme_id: int) -> str:
    """Get notification scheme with all event → notification mappings."""
    scheme = await client.get_notification_scheme(scheme_id)

    events = scheme.get("notificationSchemeEvents", [])
    result = {
        "id": scheme.get("id"),
        "name": scheme.get("name"),
        "description": scheme.get("description", ""),
        "events": [
            {
                "event": e.get("event", {}).get("name") if isinstance(e.get("event"), dict) else e.get("event"),
                "eventId": e.get("event", {}).get("id") if isinstance(e.get("event"), dict) else None,
                "notifications": [
                    {
                        "type": n.get("type"),
                        "parameter": n.get("parameter"),
                    }
                    for n in e.get("notifications", [])
                ],
            }
            for e in events
        ],
    }
    return json.dumps(result, indent=2)


async def list_notification_schemes(client: JiraClient) -> str:
    schemes = await client.list_notification_schemes()
    result = [
        {"id": s.get("id"), "name": s.get("name"), "description": s.get("description", "")}
        for s in schemes
    ]
    return json.dumps(result, indent=2)


async def get_issue_type_scheme(client: JiraClient, scheme_id: int) -> str:
    """Get issue type scheme — which issue types are available.

    DC 10: uses ?expand=issueTypes,defaultIssueType to get full details
    in a single call (the /mapping sub-resource does not exist on DC).
    """
    scheme = await client.get_issue_type_scheme(scheme_id)

    # DC returns expanded issueTypes and defaultIssueType objects
    default_it = scheme.get("defaultIssueType")
    issue_types = scheme.get("issueTypes", [])

    result = {
        "id": scheme.get("id"),
        "name": scheme.get("name"),
        "description": scheme.get("description", ""),
        "defaultIssueType": {
            "id": default_it.get("id"),
            "name": default_it.get("name"),
        } if isinstance(default_it, dict) else default_it,
        "issueTypes": [
            {"id": it.get("id"), "name": it.get("name"), "subtask": it.get("subtask", False)}
            for it in issue_types
        ],
    }
    return json.dumps(result, indent=2)


async def get_issue_security_scheme(client: JiraClient, scheme_id: int) -> str:
    """Get issue security scheme with levels."""
    scheme = await client.get_issue_security_scheme(scheme_id)
    levels = scheme.get("levels", [])

    result = {
        "id": scheme.get("id"),
        "name": scheme.get("name"),
        "description": scheme.get("description", ""),
        "defaultSecurityLevelId": scheme.get("defaultSecurityLevelId"),
        "levels": [
            {"id": lv.get("id"), "name": lv.get("name"), "description": lv.get("description", "")}
            for lv in levels
        ],
    }
    return json.dumps(result, indent=2)


async def get_priority_scheme(client: JiraClient, scheme_id: int) -> str:
    """Get priority scheme (DC 10 feature)."""
    scheme = await client.get_priority_scheme(scheme_id)
    return json.dumps(scheme, indent=2)


async def list_all_scheme_types(client: JiraClient) -> str:
    """Overview of every scheme type and count."""
    import asyncio

    async def _safe_len(coro, label):
        try:
            data = await coro
            return label, len(data)
        except Exception:
            return label, 0

    results = await asyncio.gather(
        _safe_len(client.list_workflow_schemes(), "workflowSchemes"),
        _safe_len(client.list_issue_type_schemes(), "issueTypeSchemes"),
        _safe_len(client.list_screens(), "screens"),
        _safe_len(client.list_permission_schemes(), "permissionSchemes"),
        _safe_len(client.list_notification_schemes(), "notificationSchemes"),
        _safe_len(client.list_issue_security_schemes(), "issueSecuritySchemes"),
        _safe_len(client.list_priority_schemes(), "prioritySchemes"),
    )
    result = {label: count for label, count in results}
    # These endpoints are not available on DC 10.3.12
    result["screenSchemes"] = "unavailable on DC 10"
    result["issueTypeScreenSchemes"] = "unavailable on DC 10"
    result["fieldConfigurations"] = "unavailable on DC 10"
    result["fieldConfigurationSchemes"] = "unavailable on DC 10"
    return json.dumps(result, indent=2)
