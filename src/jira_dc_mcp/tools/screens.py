"""Screen introspection tools."""

from __future__ import annotations

import json
import logging
from collections import defaultdict

from ..client import JiraClient

logger = logging.getLogger(__name__)


async def list_screens(client: JiraClient) -> str:
    """List all screens."""
    screens = await client.list_screens()
    result = [
        {"id": s.get("id"), "name": s.get("name"), "description": s.get("description", "")}
        for s in screens
    ]
    return json.dumps(result, indent=2)


async def get_screen_tabs_and_fields(client: JiraClient, screen_id: int) -> str:
    """Get a screen's tabs with all fields in order."""
    full = await client.get_screen_full(screen_id)

    # Enrich with screen name from listing
    screens = await client.list_screens()
    screen_name = next((s["name"] for s in screens if s["id"] == screen_id), f"Screen {screen_id}")

    result = {
        "screenId": screen_id,
        "screenName": screen_name,
        "tabs": [
            {
                "id": tab.get("id"),
                "name": tab.get("name"),
                "fields": [
                    {"id": f.get("id"), "name": f.get("name")}
                    for f in tab.get("fields", [])
                ],
            }
            for tab in full.get("tabs", [])
        ],
    }
    return json.dumps(result, indent=2)


async def list_screen_schemes(client: JiraClient) -> str:
    """List all screen schemes with their create/edit/view/default screen mappings.

    Served by the jiraMcpScreenSchemes ScriptRunner endpoint; the native
    /rest/api/2/screenscheme endpoint 404s on Jira DC.
    """
    return json.dumps(await client.list_screen_schemes(), indent=2)


async def get_screen_scheme(client: JiraClient, scheme_id: int) -> str:
    """Get a screen scheme with its operation-to-screen mappings."""
    schemes = await client.list_screen_schemes()
    scheme = next((s for s in schemes if s.get("id") == scheme_id), None)
    if scheme is None:
        return json.dumps({"error": f"Screen scheme {scheme_id} not found"})
    return json.dumps(scheme, indent=2)


async def list_issue_type_screen_schemes(client: JiraClient) -> str:
    """List all issue type screen schemes with issue-type-to-screen-scheme
    mappings and associated projects.

    Served by the jiraMcpIssueTypeScreenSchemes ScriptRunner endpoint; the
    native /rest/api/2/issuetypescreenscheme endpoint 404s on Jira DC.
    """
    return json.dumps(await client.list_issue_type_screen_schemes(), indent=2)


async def get_issue_type_screen_scheme(client: JiraClient, scheme_id: int) -> str:
    """Get an issue type screen scheme with its mappings and associated projects."""
    schemes = await client.list_issue_type_screen_schemes()
    scheme = next((s for s in schemes if s.get("id") == scheme_id), None)
    if scheme is None:
        return json.dumps({"error": f"Issue type screen scheme {scheme_id} not found"})
    return json.dumps(scheme, indent=2)
