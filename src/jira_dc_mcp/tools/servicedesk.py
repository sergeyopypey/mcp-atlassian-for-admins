"""JSM Service Desk introspection tools."""

from __future__ import annotations

import json

from ..client import JiraClient


async def list_service_desks(client: JiraClient) -> str:
    """List all JSM service desks."""
    desks = await client.list_jsm_service_desks()
    result = [
        {
            "id": d.get("id"),
            "projectId": d.get("projectId"),
            "projectKey": d.get("projectKey"),
            "projectName": d.get("projectName"),
        }
        for d in desks
    ]
    return json.dumps(result, indent=2)


async def get_service_desk_queues(client: JiraClient, service_desk_id: int) -> str:
    """Get queues for a service desk."""
    queues = await client.get_service_desk_queues(service_desk_id)
    result = [
        {
            "id": q.get("id"),
            "name": q.get("name"),
            "jql": q.get("jql"),
            "issueCount": q.get("issueCount"),
        }
        for q in queues
    ]
    return json.dumps(result, indent=2)
