"""Field and field configuration tools."""

from __future__ import annotations

import json
import logging

from ..client import JiraClient

logger = logging.getLogger(__name__)


async def list_fields(client: JiraClient, custom_only: bool = False) -> str:
    """List all fields (system + custom), optionally filtered to custom only."""
    fields = await client.list_fields()
    if custom_only:
        fields = [f for f in fields if f.get("custom", False)]

    result = [
        {
            "id": f.get("id"),
            "name": f.get("name"),
            "custom": f.get("custom", False),
            "type": f.get("schema", {}).get("type") if f.get("schema") else None,
            "customType": f.get("schema", {}).get("custom") if f.get("schema") else None,
            "searchable": f.get("searchable"),
            "clauseNames": f.get("clauseNames", []),
        }
        for f in fields
    ]
    return json.dumps(result, indent=2)


async def get_field_configuration(client: JiraClient, fc_id: int) -> str:
    """Get field configuration items — required, hidden, renderer, description per field.

    NOTE: The /rest/api/2/fieldconfiguration endpoint is unavailable on Jira DC 10.3.12.
    This tool will return empty results on affected versions.
    """
    fc_list = await client.list_field_configurations()
    if not fc_list:
        return json.dumps({
            "error": "Field configuration API is unavailable on this Jira DC version",
            "fieldConfigurationId": fc_id,
        })
    fc_name = next((fc["name"] for fc in fc_list if fc["id"] == fc_id), f"FC {fc_id}")
    items = await client.get_field_configuration_items(fc_id)

    result = {
        "fieldConfigurationId": fc_id,
        "name": fc_name,
        "fields": [
            {
                "id": item.get("id"),
                "description": item.get("description", ""),
                "isRequired": item.get("isRequired", False),
                "isHidden": item.get("isHidden", False),
                "renderer": item.get("renderer"),
            }
            for item in items
        ],
    }
    return json.dumps(result, indent=2)


async def get_field_configuration_scheme(client: JiraClient, scheme_id: int) -> str:
    """Get field configuration scheme — maps issue types to field configurations.

    NOTE: The /rest/api/2/fieldconfigurationscheme endpoint is unavailable on Jira DC 10.3.12.
    This tool will return an error on affected versions.
    """
    schemes = await client.list_field_configuration_schemes()
    if not schemes:
        return json.dumps({
            "error": "Field configuration scheme API is unavailable on this Jira DC version",
            "schemeId": scheme_id,
        })
    scheme = next((s for s in schemes if s["id"] == scheme_id), None)
    if not scheme:
        return json.dumps({"error": f"Field configuration scheme {scheme_id} not found"})

    mappings = await client.get_field_configuration_scheme_mapping(scheme_id)
    result = {
        "id": scheme.get("id"),
        "name": scheme.get("name"),
        "description": scheme.get("description", ""),
        "mappings": [
            {
                "issueTypeId": m.get("issueTypeId"),
                "fieldConfigurationId": m.get("fieldConfigurationId"),
            }
            for m in mappings
        ],
    }
    return json.dumps(result, indent=2)


async def find_field_usage(client: JiraClient, field_id: str) -> str:
    """Find where a field appears across all screens and field configurations."""
    # Search screens
    screens = await client.list_screens()
    screen_hits = []
    for scr in screens:
        try:
            tabs = await client.get_screen_tabs(scr["id"])
            for tab in tabs:
                fields = await client.get_screen_tab_fields(scr["id"], tab["id"])
                for f in fields:
                    if f.get("id") == field_id:
                        screen_hits.append({
                            "screenId": scr["id"],
                            "screenName": scr.get("name"),
                            "tabId": tab["id"],
                            "tabName": tab.get("name"),
                        })
        except Exception:
            continue

    # Search field configurations
    fc_list = await client.list_field_configurations()
    fc_hits = []
    for fc in fc_list:
        try:
            items = await client.get_field_configuration_items(fc["id"])
            for item in items:
                if item.get("id") == field_id:
                    fc_hits.append({
                        "fieldConfigId": fc["id"],
                        "fieldConfigName": fc.get("name"),
                        "isRequired": item.get("isRequired", False),
                        "isHidden": item.get("isHidden", False),
                    })
        except Exception:
            continue

    result = {
        "fieldId": field_id,
        "screens": screen_hits,
        "fieldConfigurations": fc_hits if fc_hits else "unavailable on DC 10 (API returns 404)",
        "totalScreens": len(screen_hits),
        "totalFieldConfigs": len(fc_hits),
    }
    return json.dumps(result, indent=2)


async def get_field_contexts(client: JiraClient, field_id: str) -> str:
    """Get custom field contexts — which projects and issue types the field is scoped to.

    Uses the internal ``/rest/internal/2/field/{id}/context`` endpoint.
    This endpoint is NOT officially supported and may break on upgrades.
    """
    contexts = await client.get_field_context(field_id)
    if not contexts:
        return json.dumps({"error": f"No contexts found for field {field_id} (internal API may be unavailable)"})

    result = []
    for ctx in contexts:
        projects = ctx.get("projects", [])
        issue_types = ctx.get("issueTypes", [])
        result.append({
            "id": ctx.get("id"),
            "name": ctx.get("name", ""),
            "description": ctx.get("description", ""),
            "allProjects": ctx.get("allProjects", False),
            "allIssueTypes": ctx.get("allIssueTypes", False),
            "projects": [
                {"id": p.get("id"), "key": p.get("key")}
                for p in projects
            ] if isinstance(projects, list) else [],
            "issueTypes": [
                {"id": it.get("id"), "name": it.get("name")}
                for it in issue_types
            ] if isinstance(issue_types, list) else [],
        })
    return json.dumps({"fieldId": field_id, "contexts": result}, indent=2)
