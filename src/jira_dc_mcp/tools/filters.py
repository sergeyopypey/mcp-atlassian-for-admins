"""Filter, dashboard, and webhook introspection tools."""

from __future__ import annotations

import json

from ..client import JiraClient


async def list_filters(client: JiraClient) -> str:
    """List favourite/shared JQL filters."""
    filters = await client.list_filters()
    result = [
        {
            "id": f.get("id"),
            "name": f.get("name"),
            "jql": f.get("jql"),
            "owner": (f.get("owner") or {}).get("displayName"),
            "favourite": f.get("favourite"),
            "favouritedCount": f.get("favouritedCount"),
            "sharePermissions": [
                {
                    "type": sp.get("type"),
                    "project": (sp.get("project") or {}).get("key") if sp.get("project") else None,
                    "role": (sp.get("role") or {}).get("name") if sp.get("role") else None,
                    "group": (sp.get("group") or {}).get("name") if sp.get("group") else None,
                }
                for sp in f.get("sharePermissions", [])
            ],
        }
        for f in filters
    ]
    return json.dumps(result, indent=2)


async def list_dashboards(client: JiraClient) -> str:
    """List all dashboards."""
    dashboards = await client.list_dashboards()
    result = [
        {
            "id": d.get("id"),
            "name": d.get("name"),
            "owner": (d.get("owner") or {}).get("displayName") if d.get("owner") else None,
            "popularity": d.get("popularity"),
            "view": d.get("view"),
        }
        for d in dashboards
    ]
    return json.dumps(result, indent=2)


async def list_webhooks(client: JiraClient) -> str:
    """List all registered webhooks."""
    webhooks = await client.list_webhooks()
    result = [
        {
            "id": w.get("self", "").rstrip("/").split("/")[-1] if w.get("self") else w.get("id"),
            "name": w.get("name"),
            "url": w.get("url"),
            "events": w.get("events", []),
            "enabled": w.get("enabled"),
            "filters": w.get("filters") or {},
            "excludeBody": w.get("excludeBody"),
        }
        for w in webhooks
    ]
    return json.dumps(result, indent=2)
