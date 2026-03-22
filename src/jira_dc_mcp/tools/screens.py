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
    """List all screen schemes.

    Jira DC 10 does NOT have a /rest/api/2/screenscheme collection endpoint.
    This tool reconstructs screen schemes from the screens endpoint using
    ``expand=fieldScreenSchemes``, which reveals which screen scheme each
    screen belongs to.  Screen-to-operation mapping (create/edit/view) is
    inferred from screen names.
    """
    screens = await client.list_screens(expand="fieldScreenSchemes")

    scheme_screens: dict[int, dict] = {}  # scheme_id -> {name, screens: [...]}
    for scr in screens:
        for ss in scr.get("fieldScreenSchemes", []):
            sid = ss["id"]
            if sid not in scheme_screens:
                scheme_screens[sid] = {
                    "id": sid,
                    "name": ss.get("name", ""),
                    "description": ss.get("description", ""),
                    "screens": [],
                }
            # Infer operation from screen name
            sname = (scr.get("name") or "").lower()
            if "create" in sname and "edit" in sname and "view" in sname:
                operation = "default"
            elif "create" in sname and "edit" in sname:
                operation = "create/edit"
            elif "create" in sname:
                operation = "create"
            elif "edit" in sname:
                operation = "edit"
            elif "view" in sname:
                operation = "view"
            else:
                operation = "default"

            scheme_screens[sid]["screens"].append({
                "screenId": scr["id"],
                "screenName": scr.get("name", ""),
                "operation": operation,
            })

    result = sorted(scheme_screens.values(), key=lambda s: s["id"])
    return json.dumps(result, indent=2)


async def get_screen_scheme(client: JiraClient, scheme_id: int) -> str:
    """Get a screen scheme with its screens and inferred operation mappings.

    Reconstructed from screens ``expand=fieldScreenSchemes`` since the
    ``/rest/api/2/screenscheme/{id}`` endpoint does not exist on DC 10.
    """
    screens = await client.list_screens(expand="fieldScreenSchemes,fieldScreenTabs")

    matched_screens = []
    scheme_name = f"Screen Scheme {scheme_id}"
    for scr in screens:
        for ss in scr.get("fieldScreenSchemes", []):
            if ss["id"] == scheme_id:
                scheme_name = ss.get("name", scheme_name)

                sname = (scr.get("name") or "").lower()
                if "create" in sname and "edit" in sname and "view" in sname:
                    operation = "default"
                elif "create" in sname and "edit" in sname:
                    operation = "create/edit"
                elif "create" in sname:
                    operation = "create"
                elif "edit" in sname:
                    operation = "edit"
                elif "view" in sname:
                    operation = "view"
                else:
                    operation = "default"

                tabs = scr.get("fieldScreenTabList", [])
                matched_screens.append({
                    "screenId": scr["id"],
                    "screenName": scr.get("name", ""),
                    "operation": operation,
                    "tabs": [{"id": t.get("id"), "name": t.get("name")} for t in tabs],
                })
                break

    result = {
        "id": scheme_id,
        "name": scheme_name,
        "screens": matched_screens,
    }
    return json.dumps(result, indent=2)


async def list_issue_type_screen_schemes(client: JiraClient) -> str:
    """List all issue type screen schemes.

    The ``/rest/api/2/issuetypescreenscheme`` endpoint does not exist on DC 10.
    Returns an unavailability notice.
    """
    return json.dumps({
        "error": "Issue type screen scheme list endpoint is unavailable on Jira DC 10. "
                 "Use get_screen_scheme to see which screens belong to a screen scheme, "
                 "or use get_project_config to see the issue type screen scheme for a specific project.",
    })


async def get_issue_type_screen_scheme(client: JiraClient, scheme_id: int) -> str:
    """Get an issue type screen scheme.

    The ``/rest/api/2/issuetypescreenscheme/{id}`` endpoint does not exist on DC 10.
    Returns an unavailability notice.
    """
    return json.dumps({
        "error": "Issue type screen scheme detail endpoint is unavailable on Jira DC 10. "
                 "Use createmeta (GET /rest/api/2/issue/createmeta/{project}/issuetypes/{id}) "
                 "to discover which fields appear on the create screen for each issue type.",
        "schemeId": scheme_id,
    })
